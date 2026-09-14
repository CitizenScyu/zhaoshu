/** A character in one unchanged reader part, measured from its scrollport's top. */
export interface TextAnchor {
  /** UTF-16 offset into prose.textContent, never inside a surrogate pair. */
  textOffset: number;
  /** Character line's top relative to the viewport's inner top edge, in pixels. */
  viewportOffset: number;
}

const MAX_TEXT_UNITS = 32 * 1024;
const MAX_VIEWPORT_OFFSET = 256;
const MAX_RANGE_PROBES = 20;
const contentCache = new WeakMap<Text, { value: string; readable: boolean }>();

interface Frame {
  text: Text;
  value: string;
  document: Document;
  originTop: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  proseTop: number;
  proseBottom: number;
  lineHeight: number;
}

function frameFor(prose: HTMLElement, viewport: HTMLElement): Frame | null {
  if (!prose.isConnected || !viewport.isConnected || !viewport.contains(prose)
    || prose.ownerDocument !== viewport.ownerDocument || prose.childNodes.length !== 1) return null;
  const child = prose.firstChild;
  if (!child || child.nodeType !== 3) return null;
  const text = child as Text;
  const value = text.data;
  if (!value.length || value.length > MAX_TEXT_UNITS) return null;
  let content = contentCache.get(text);
  if (content?.value !== value) {
    content = { value, readable: /\S/u.test(value) };
    contentCache.set(text, content);
  }
  if (!content.readable) return null;

  const document = prose.ownerDocument;
  const view = document.defaultView;
  if (!view) return null;
  if (typeof prose.checkVisibility === 'function'
    && !prose.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
  const style = view.getComputedStyle(prose);
  if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0'
    || !style.writingMode.startsWith('horizontal')) return null;
  const proseBox = prose.getBoundingClientRect();
  const viewportBox = viewport.getBoundingClientRect();
  if (proseBox.width <= 0 || proseBox.height <= 0 || viewport.clientWidth <= 0
    || viewport.clientHeight <= 0 || viewportBox.width <= 0 || viewportBox.height <= 0) return null;
  const originTop = viewportBox.top + viewport.clientTop;
  const top = Math.max(0, originTop);
  const bottom = Math.min(view.innerHeight, originTop + viewport.clientHeight);
  const left = Math.max(0, proseBox.left, viewportBox.left + viewport.clientLeft);
  const right = Math.min(view.innerWidth, proseBox.right,
    viewportBox.left + viewport.clientLeft + viewport.clientWidth);
  if (bottom <= top || right <= left) return null;
  const lineHeight = Number.parseFloat(style.lineHeight);
  const fontSize = Number.parseFloat(style.fontSize) || 20;
  return {
    text, value, document, originTop, top, bottom, left, right,
    proseTop: proseBox.top, proseBottom: proseBox.bottom,
    lineHeight: Math.max(4, Math.min(256, Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.5)),
  };
}

function highSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function lowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

function characterStart(value: string, offset: number): number {
  let start = Math.min(value.length - 1, Math.max(0, offset));
  if (start > 0 && lowSurrogate(value.charCodeAt(start)) && highSurrogate(value.charCodeAt(start - 1))) start--;
  return start;
}

function characterEnd(value: string, start: number): number {
  return start + (highSurrogate(value.charCodeAt(start)) && lowSurrogate(value.charCodeAt(start + 1)) ? 2 : 1);
}

function characterRect(frame: Frame, range: Range, offset: number): DOMRect | null {
  range.setStart(frame.text, offset);
  range.setEnd(frame.text, characterEnd(frame.value, offset));
  const rectangles = range.getClientRects();
  for (let index = 0; index < Math.min(rectangles.length, 4); index++) {
    const rectangle = rectangles[index];
    if (rectangle.height > 0 && Number.isFinite(rectangle.top) && Number.isFinite(rectangle.bottom)) return rectangle;
  }
  // A newline or zero-width character may only expose a collapsed caret box.
  range.collapse(true);
  const rectangle = range.getBoundingClientRect();
  return rectangle.height > 0 && Number.isFinite(rectangle.top) ? rectangle : null;
}

function caretOffset(frame: Frame, x: number, y: number): number | null {
  const document = frame.document;
  if (typeof document.caretPositionFromPoint === 'function') {
    try {
      const caret = document.caretPositionFromPoint(x, y);
      if (caret?.offsetNode === frame.text) return caret.offset;
    } catch { /* Older/partially implemented APIs may throw; use the fallback. */ }
  }
  if (typeof document.caretRangeFromPoint === 'function') {
    try {
      const caret = document.caretRangeFromPoint(x, y);
      if (caret?.startContainer === frame.text) return caret.startOffset;
    } catch { /* The bounded Range search below does not depend on hit testing. */ }
  }
  return null;
}

function visibleAnchor(frame: Frame, range: Range, offset: number): TextAnchor | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > frame.value.length) return null;
  const textOffset = characterStart(frame.value, offset);
  const rectangle = characterRect(frame, range, textOffset);
  if (!rectangle || rectangle.bottom <= frame.top || rectangle.top >= frame.bottom) return null;
  return {
    textOffset,
    viewportOffset: Math.max(-MAX_VIEWPORT_OFFSET,
      Math.min(MAX_VIEWPORT_OFFSET, rectangle.top - frame.originTop)),
  };
}

/**
 * Capture a character on the first visible text line. Before prose reaches the
 * viewport's top (for example, while its chapter heading is still visible),
 * return null so restoring an anchor cannot scroll that heading out of view.
 *
 * The reader supplies one horizontal, pre-wrapped Text node of at most 32 KiB.
 * Native caret hit testing is preferred; a missing/obscured caret falls back to
 * at most 20 single-character Range probes, never a range spanning the full text.
 * Whitespace classification is cached until that Text node's content changes.
 */
export function captureTextAnchor(prose: HTMLElement, viewport: HTMLElement): TextAnchor | null {
  try {
    const frame = frameFor(prose, viewport);
    if (!frame || frame.proseTop > frame.top + 1 || frame.proseBottom <= frame.top) return null;
    const range = frame.document.createRange();
    const x = Math.min(frame.right - 0.5, frame.left + 1);
    for (const distance of [0.5, Math.min(12, frame.lineHeight / 2), frame.lineHeight]) {
      const y = Math.min(frame.bottom - 0.5, frame.top + distance);
      const offset = caretOffset(frame, x, y);
      const anchor = offset === null ? null : visibleAnchor(frame, range, offset);
      if (anchor) return anchor;
    }

    let low = 0;
    let high = frame.value.length;
    for (let probe = 0; low < high && probe < MAX_RANGE_PROBES; probe++) {
      const middle = characterStart(frame.value, Math.floor((low + high) / 2));
      const rectangle = characterRect(frame, range, middle);
      if (!rectangle) return null;
      if (rectangle.bottom <= frame.top) low = characterEnd(frame.value, middle);
      else high = middle;
    }
    return low < frame.value.length ? visibleAnchor(frame, range, low) : null;
  } catch {
    // A React commit can detach/replace text between a scheduled capture and use.
    return null;
  }
}

/**
 * Restore after a layout change, using the same unchanged part text. Only the
 * supplied viewport scrolls. Browser scroll limits still apply near book ends.
 * Invalid/stale offsets, hidden or detached nodes return false without scrolling.
 */
export function restoreTextAnchor(
  prose: HTMLElement,
  viewport: HTMLElement,
  anchor: TextAnchor,
): boolean {
  try {
    const frame = frameFor(prose, viewport);
    if (!frame || !Number.isSafeInteger(anchor.textOffset) || anchor.textOffset < 0
      || anchor.textOffset >= frame.value.length || !Number.isFinite(anchor.viewportOffset)) return false;
    const offset = characterStart(frame.value, anchor.textOffset);
    const rectangle = characterRect(frame, frame.document.createRange(), offset);
    if (!rectangle) return false;
    const viewportOffset = Math.max(-MAX_VIEWPORT_OFFSET, Math.min(MAX_VIEWPORT_OFFSET, anchor.viewportOffset));
    const target = viewport.scrollTop + rectangle.top - frame.originTop - viewportOffset;
    viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, target));
    return true;
  } catch {
    return false;
  }
}

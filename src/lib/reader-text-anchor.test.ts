import { describe, expect, it, vi } from 'vitest';
import { captureTextAnchor, restoreTextAnchor } from './reader-text-anchor';

function fixture(parentOpacity: string) {
  const parent = { parentElement: null };
  const rect = { top: 0, bottom: 100, left: 0, right: 200, width: 200, height: 100 };
  const range = { setStart: vi.fn(), setEnd: vi.fn(), getClientRects: () => [{ ...rect, height: 20, bottom: 20 }] };
  const document = { createRange: vi.fn(() => range), defaultView: {
    innerHeight: 500, innerWidth: 500,
    getComputedStyle: (element: unknown) => ({ opacity: element === parent ? parentOpacity : '1', visibility: 'visible', writingMode: 'horizontal-tb', lineHeight: '20px', fontSize: '16px' }),
  } };
  const node = { nodeType: 3, data: '😀测试文本' };
  const prose = { isConnected: true, ownerDocument: document, parentElement: parent, childNodes: [node], firstChild: node, getBoundingClientRect: () => rect } as unknown as HTMLElement;
  const viewport = { isConnected: true, ownerDocument: document, contains: () => true, getBoundingClientRect: () => rect, clientTop: 0, clientLeft: 0, clientWidth: 200, clientHeight: 100, scrollTop: 0, scrollHeight: 500 } as unknown as HTMLElement;
  return { prose, viewport, document };
}

describe('visibility without checkVisibility or native caret APIs', () => {
  it('does not capture or restore text under a transparent ancestor', () => {
    const { prose, viewport, document } = fixture('0');
    expect(captureTextAnchor(prose, viewport)).toBeNull();
    expect(restoreTextAnchor(prose, viewport, { textOffset: 0, viewportOffset: 0 })).toBe(false);
    expect(document.createRange).not.toHaveBeenCalled();
  });

  it('retains the Range fallback when ancestors are visible', () => {
    const { prose, viewport } = fixture('1');
    expect(captureTextAnchor(prose, viewport)).toEqual({ textOffset: 0, viewportOffset: 0 });
    expect(restoreTextAnchor(prose, viewport, { textOffset: 0, viewportOffset: 0 })).toBe(true);
  });
});

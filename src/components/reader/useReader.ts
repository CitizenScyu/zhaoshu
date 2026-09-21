'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReaderIndex, ReaderPart, ReadingSession } from '@/lib/reader-types';
import { readerChapterUrl, readerIndexUrl, readerPartMatches, switchedReaderIndex } from '@/lib/reader-session';
import { ReaderPartCache, nextReadingPosition, previousReadingPosition } from '@/lib/reader-part-cache';
import { captureTextAnchor, restoreTextAnchor } from '@/lib/reader-text-anchor';
import { catalogPrefixKey, migrateProgressAcrossSources, parseReaderSettings, parseReadingProgress, readingPercent, READER_SETTINGS_KEY } from '@/lib/reader-preferences';
import { migrateLegacyIndexProgressKey } from '@/lib/user-scope';
import type { ReaderSettings, ReadingPosition, ReadingProgress } from '@/lib/reader-preferences';

interface Reading {
  index: ReaderIndex;
  parts: ReaderPart[];
  position: ReadingPosition;
  focus: boolean;
  sectionOffset?: number;
}
export interface SimilarCandidate { title: string; author: string; alias?: string; chapters: number; bookUrl: string }
interface Failure { message: string; status: number; code?: string; candidates?: SimilarCandidate[]; target?: ReadingPosition; direction?: 'next' | 'previous' }
type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const START: ReadingPosition = { chapterIndex: 0, partIndex: 0, ratio: 0 };
const WINDOW_SIZE = 3;
export const partKey = (part: Pick<ReaderPart, 'chapterIndex' | 'partIndex'>) => `${part.chapterIndex}:${part.partIndex}`;

class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) throw new RequestError('访问口令不正确或已失效，请重新输入。', 401);
    const error = new RequestError(
      typeof data?.error === 'string' ? data.error : '阅读服务暂时不可用，请稍后重试。',
      response.status, typeof data?.code === 'string' ? data.code : undefined,
    );
    // 模糊降级层：把 SOURCE_SIMILAR 响应里的候选列表附在错误对象上，由 fail() 转入 Failure。
    if (Array.isArray(data?.candidates)) {
      (error as RequestError & { candidates?: SimilarCandidate[] }).candidates = data.candidates as SimilarCandidate[];
    }
    throw error;
  }
  if (!data) throw new RequestError('收到的阅读内容不完整，请重试。', 502);
  return data as T;
}
function storedValue(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function canPrefetch(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return document.visibilityState !== 'hidden' && !connection?.saveData
    && connection?.effectiveType !== '2g' && connection?.effectiveType !== 'slow-2g';
}

export function useReader(session: ReadingSession, apiFetch: ApiFetch, userId: number) {
  // 确认路径（模糊候选点选后）会换 bookUrl 重放；初始 indexUrl 仍由 session 派生。
  const [indexUrl, setIndexUrl] = useState(() => readerIndexUrl(session));
  // 进度键按当前用户固定：卸载清理时仍写回旧用户，不会写进下一个身份的键。
  const progressKeyFor = useCallback((index: ReaderIndex) => migrateLegacyIndexProgressKey(index, userId), [userId]);
  const [settings, setSettings] = useState(() => parseReaderSettings(storedValue(READER_SETTINGS_KEY)));
  const [reading, setReading] = useState<Reading | null>(null);
  const [activeKey, setActiveKey] = useState('0:0');
  const [loading, setLoading] = useState(true);
  const [flowing, setFlowing] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [percent, setPercent] = useState(0);
  const [notice, setNotice] = useState('');
  const [storageFailed, setStorageFailed] = useState(false);
  const [focused, setFocused] = useState(false);
  const scroller = useRef<HTMLElement>(null);
  const article = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const request = useRef<AbortController | null>(null);
  const flowRequest = useRef<AbortController | null>(null);
  const serial = useRef(0);
  const currentReading = useRef<Reading | null>(null);
  const appliedReading = useRef<Reading | null>(null);
  const progress = useRef<ReadingProgress | null>(null);
  const measuredScrollTop = useRef<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const restoring = useRef(false);
  const scrollIntent = useRef(false);
  // 洞 2 前端半边:换源成功后阅读中的目录切成新源;同一阅读会话只跟随一次
  // (用户重载目录后以新源为基线重来,避免两源间来回横跳)。
  const adoptedSwitch = useRef<string | null>(null);
  // M3 手动换源:换源前把旧目录与进度暂存,等新目录到达且新键无已存进度时做一次跨源迁移。
  const pendingMigration = useRef<{ progress: ReadingProgress; fromIndex: ReaderIndex } | null>(null);
  // 迁移 notice 文案由 loadIndex 消费(设计 §5),用 ref 传递避免额外状态。
  const migrationNotice = useRef<string | null>(null);

  const [cache] = useState(() => new ReaderPartCache(async (index, position, signal) => {
    const part = await responseJson<ReaderPart>(await apiFetch(readerChapterUrl(index, position), { signal, cache: 'no-store' }));
    if (!readerPartMatches(index, part, position)) {
      throw new RequestError('章节内容与目录不一致，请重新加载目录。', 409);
    }
    return part;
  }));

  const saveProgress = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const index = currentReading.current?.index;
    if (!progress.current || !index) return;
    try { window.localStorage.setItem(progressKeyFor(index), JSON.stringify(progress.current)); }
    catch { setStorageFailed(true); }
  }, [progressKeyFor]);

  const capturePosition = useCallback(() => {
    const current = currentReading.current;
    const viewport = scroller.current;
    if (!current || !viewport) return null;
    const top = viewport.getBoundingClientRect().top + viewport.clientTop;
    let part = current.parts[0];
    const last = current.parts[current.parts.length - 1];
    const atBookEnd = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2
      && nextReadingPosition(current.index, last) === null;
    if (viewport.scrollHeight <= viewport.clientHeight + 1 || atBookEnd) part = last;
    else {
      for (const candidate of current.parts) {
        const section = sections.current.get(partKey(candidate));
        if (section && section.getBoundingClientRect().top <= top + 20) part = candidate;
      }
    }
    const section = sections.current.get(partKey(part));
    if (!section) return null;
    const rect = section.getBoundingClientRect();
    const distance = Math.max(0, rect.height - viewport.clientHeight);
    const ratio = distance > 0 ? Math.max(0, Math.min(1, (top - rect.top) / distance)) : 1;
    const prose = section.querySelector<HTMLElement>('[data-reader-prose]');
    const anchor = prose ? captureTextAnchor(prose, viewport) : null;
    // 在线目录可增长：除 version 外再存稳定章节键 + 前缀指纹，目录追加后才可验证地续读（F11）。
    const chapter = current.index.chapters[part.chapterIndex];
    const catalog = current.index.taskId === null && current.index.source && chapter?.title
      ? { chapterTitle: chapter.title, catalogPrefix: catalogPrefixKey(current.index, part.chapterIndex) } : {};
    const position: ReadingProgress = {
      schema: 1, version: current.index.version, chapterIndex: part.chapterIndex, partIndex: part.partIndex,
      ratio, ...anchor, ...catalog, updatedAt: Date.now(),
    };
    return { position, sectionOffset: rect.top - top, part };
  }, []);

  const publishPosition = useCallback((snapshot: ReturnType<typeof capturePosition>) => {
    if (!snapshot || !currentReading.current) return;
    progress.current = snapshot.position;
    measuredScrollTop.current = scroller.current?.scrollTop ?? null;
    setActiveKey(partKey(snapshot.position));
    setPercent(readingPercent(currentReading.current.index, snapshot.part, snapshot.position.ratio));
  }, []);

  const captureStablePosition = useCallback(() => {
    const snapshot = capturePosition();
    const previous = progress.current;
    const viewport = scroller.current;
    if (snapshot && previous && viewport && measuredScrollTop.current !== null
      && Math.abs(viewport.scrollTop - measuredScrollTop.current) < 1
      && partKey(snapshot.position) === partKey(previous) && snapshot.position.version === previous.version
      && previous.textOffset !== undefined && previous.viewportOffset !== undefined) {
      // Several layout changes can place this character in the middle of a new
      // line. Re-capturing each new line start would accumulate a full-line drift.
      snapshot.position.textOffset = previous.textOffset;
      snapshot.position.viewportOffset = previous.viewportOffset;
    }
    return snapshot;
  }, [capturePosition]);

  const flushPosition = useCallback(() => {
    if (!restoring.current) publishPosition(captureStablePosition());
    saveProgress();
  }, [captureStablePosition, publishPosition, saveProgress]);

  /**
   * 洞 2 前端半边:章内换源成功后,服务端在 part 上带出新源的目录会话版本。
   * 此时把**后续**章节的请求重定向到新源 —— 不重键已渲染的阅读依赖(否则会跳回进度、
   * 闪一下空状态),只换「后续取的目录」。同一阅读会话只跟随一次:用户重载目录后以新源
   * 目录为基线重来,避免两源间来回横跳。
   */
  const adoptSwitch = useCallback((index: ReaderIndex, part: ReaderPart): ReaderIndex => {
    const switched = switchedReaderIndex(index, part);
    if (switched === index) return index;
    if (!adoptedSwitch.current) adoptedSwitch.current = switched.source!.session;
    if (adoptedSwitch.current !== switched.source!.session) return index;
    const current = currentReading.current;
    if (current && current.index === index) currentReading.current = { ...current, index: switched };
    return switched;
  }, []);

  const fail = useCallback((error: unknown, target?: ReadingPosition, direction?: 'next' | 'previous') => {
    const status = error instanceof RequestError ? error.status : 0;
    if (status === 401) { cache.clear(); setReading(null); }
    setFailure({
      message: error instanceof Error ? error.message : '阅读内容加载失败，请重试。', status,
      code: error instanceof RequestError ? error.code : undefined,
      // 模糊降级层：SOURCE_SIMILAR 的失败体携带候选列表，交给前端渲染点选卡。
      candidates: error instanceof RequestError && Array.isArray((error as RequestError & { candidates?: unknown }).candidates)
        ? (error as RequestError & { candidates: SimilarCandidate[] }).candidates
        : undefined,
      target, direction,
    });
  }, [cache]);

  const beginRequest = useCallback(() => {
    const previousRequest = request.current;
    const previousFlow = flowRequest.current;
    flowRequest.current = null;
    scrollIntent.current = false;
    const controller = new AbortController();
    request.current = controller;
    const id = ++serial.current;
    setLoading(true);
    setFlowing(false);
    setFailure(null);
    return {
      controller, id,
      retirePrevious: () => {
        previousRequest?.abort();
        previousFlow?.abort();
        cache.cancelPrefetch();
      },
    };
  }, [cache]);

  const loadIndex = useCallback(async () => {
    flushPosition();
    const { controller, id, retirePrevious } = beginRequest();
    retirePrevious();
    cache.clear();
    try {
      const index = await responseJson<ReaderIndex>(await apiFetch(indexUrl, { signal: controller.signal, cache: 'no-store' }));
      if (!Array.isArray(index.chapters) || !index.chapters.length) throw new RequestError('这本书还没有可阅读的正文。', 422);
      adoptedSwitch.current = null; // 新目录为基线:后续仍可再跟随一次换源
      let saved = parseReadingProgress(storedValue(progressKeyFor(index)), index);
      // M3 手动换源:迁移只在**新键无已存进度**时进行(用户之前在这个源读过 ⇒ 尊重该源自己的进度)。
      const pending = pendingMigration.current;
      if (!saved && pending && index.source && index.source.id !== pending.fromIndex.source?.id) {
        const result = migrateProgressAcrossSources(pending.progress, pending.fromIndex, index);
        if (result) {
          saved = { schema: 1, version: index.version, ...result.position, updatedAt: Date.now() };
          try { window.localStorage.setItem(progressKeyFor(index), JSON.stringify(saved)); } catch { setStorageFailed(true); }
          migrationNotice.current = result.confidence === 'exact'
            ? '已切换书源,回到原进度'
            : '已切换书源,按章节进度估算定位(两源目录略有差异)';
        } else {
          migrationNotice.current = '已切换书源;新源目录差异较大,未能定位原进度';
        }
      } else if (pending) {
        // 换了源但没有可迁移的进度(或迁移未命中)。
        if (!saved) migrationNotice.current = '已切换书源;新源目录差异较大,未能定位原进度';
      }
      pendingMigration.current = null;
      const position = saved ?? START;
      const part = await cache.get(index, position, controller.signal);
      if (controller.signal.aborted || id !== serial.current) return;
      const switched = adoptSwitch(index, part);
      setActiveKey(partKey(part));
      setReading({ index: switched, parts: [part], position, focus: false });
      setPercent(readingPercent(switched, part, position.ratio));
      const notice = migrationNotice.current;
      migrationNotice.current = null;
      setNotice(notice ?? (saved ? '已回到上次阅读的位置' : ''));
    } catch (error) {
      if (!controller.signal.aborted && id === serial.current) fail(error);
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted && id === serial.current) setLoading(false);
    }
  }, [apiFetch, indexUrl, beginRequest, adoptSwitch, cache, fail, flushPosition, progressKeyFor]);

  // 模糊候选点选后的确认重放：换 bookUrl 重载目录（server 端跳过书名/作者匹配）。
  const loadConfirmedBook = useCallback((bookUrl: string) => {
    if (session.kind !== 'source' || !bookUrl) return;
    flushPosition();
    const current = currentReading.current;
    if (current?.index.source && progress.current) {
      pendingMigration.current = { progress: progress.current, fromIndex: current.index };
    }
    setIndexUrl('/api/read/source/index?' + new URLSearchParams({ title: session.title, author: session.author, book_url: bookUrl }));
  }, [session, flushPosition]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void loadIndex(); });
    return () => {
      active = false; serial.current += 1;
      request.current?.abort(); flowRequest.current?.abort(); cache.clear(); saveProgress();
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, [loadIndex, cache, saveProgress]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') { flushPosition(); cache.cancelPrefetch(); }
    };
    window.addEventListener('pagehide', flushPosition);
    document.addEventListener('visibilitychange', onHidden);
    return () => { window.removeEventListener('pagehide', flushPosition); document.removeEventListener('visibilitychange', onHidden); };
  }, [flushPosition, cache]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const activePart = reading?.parts.find((part) => partKey(part) === activeKey) ?? reading?.parts[0];
  useEffect(() => {
    if (!reading || !activePart || loading || failure || !settings.preloadNext || !canPrefetch()) {
      cache.cancelPrefetch();
      return;
    }
    const next = nextReadingPosition(reading.index, reading.parts[reading.parts.length - 1]);
    if (!next) return;
    const timer = setTimeout(() => { if (canPrefetch()) cache.prefetch(reading.index, next); }, 250);
    return () => clearTimeout(timer);
  }, [reading, activePart, loading, failure, settings.preloadNext, cache]);

  useLayoutEffect(() => {
    currentReading.current = reading;
    if (!reading || !scroller.current) { appliedReading.current = reading; return; }
    const viewport = scroller.current;
    const changed = appliedReading.current !== reading;
    appliedReading.current = reading;
    if (changed) progress.current = { schema: 1, version: reading.index.version, ...reading.position, updatedAt: Date.now() };
    let releaseFrame = 0;
    let alive = true;
    let initialRestore = changed;
    const restore = () => {
      if (!alive || currentReading.current !== reading || !progress.current) return;
      const position = progress.current;
      const section = sections.current.get(partKey(position));
      if (!section) return;
      restoring.current = true;
      const prose = section.querySelector<HTMLElement>('[data-reader-prose]');
      const anchored = prose && position.textOffset !== undefined && position.viewportOffset !== undefined
        && restoreTextAnchor(prose, viewport, { textOffset: position.textOffset, viewportOffset: position.viewportOffset });
      if (!anchored) {
        const sectionTop = section.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop;
        if (initialRestore && reading.sectionOffset !== undefined) viewport.scrollTop += sectionTop - reading.sectionOffset;
        else if (position.ratio === 0 && partKey(position) === partKey(reading.parts[0])) viewport.scrollTop = 0;
        else viewport.scrollTop += sectionTop + position.ratio * Math.max(0, section.offsetHeight - viewport.clientHeight);
      }
      initialRestore = false;
      cancelAnimationFrame(releaseFrame);
      releaseFrame = requestAnimationFrame(() => {
        if (!alive) return;
        const snapshot = capturePosition();
        // Reflow may move the character within its line. Keep the chosen character
        // until the user scrolls, instead of drifting toward each new line start.
        if (anchored && snapshot && partKey(snapshot.position) === partKey(position)) {
          snapshot.position.textOffset = position.textOffset;
          snapshot.position.viewportOffset = position.viewportOffset;
        }
        publishPosition(snapshot);
        restoring.current = false;
        saveProgress();
      });
    };
    restore();
    if (changed && reading.focus) heading.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(restore);
    if (article.current) observer.observe(article.current);
    observer.observe(viewport);
    return () => { alive = false; observer.disconnect(); cancelAnimationFrame(releaseFrame); };
  }, [reading, settings.fontSize, settings.lineHeight, settings.font, settings.width, focused, capturePosition, publishPosition, saveProgress]);

  const navigate = useCallback(async (position: ReadingPosition) => {
    const current = currentReading.current;
    if (!current) return;
    flushPosition();
    setNotice('');
    const { controller, id, retirePrevious } = beginRequest();
    try {
      // Subscribe to the destination before dropping speculative/previous interest.
      // A click during its in-flight preload promotes that same network request.
      const pending = cache.get(current.index, position, controller.signal);
      retirePrevious();
      const part = await pending;
      if (controller.signal.aborted || id !== serial.current) return;
      // 换源在飞期间用户又点了别处:结果只对发起它的那次阅读有效(与 extend 同款护栏)。
      if (currentReading.current !== current) return;
      const adopted = adoptSwitch(current.index, part);
      setActiveKey(partKey(part));
      setReading({ index: adopted, parts: [part], position, focus: true });
      setPercent(readingPercent(adopted, part, position.ratio));
    } catch (error) {
      if (!controller.signal.aborted && id === serial.current) fail(error, position);
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted && id === serial.current) setLoading(false);
    }
  }, [adoptSwitch, beginRequest, cache, fail, flushPosition]);

  const extend = useCallback(async (direction: 'next' | 'previous', manual = false) => {
    const current = currentReading.current;
    const viewport = scroller.current;
    if (!current || !viewport || flowRequest.current || request.current || loading) return;
    const next = direction === 'next'
      ? nextReadingPosition(current.index, current.parts[current.parts.length - 1])
      : previousReadingPosition(current.index, current.parts[0]);
    if (!next) return;
    if (current.parts.length >= WINDOW_SIZE) {
      const evicted = direction === 'next' ? current.parts[0] : current.parts[current.parts.length - 1];
      const bounds = sections.current.get(partKey(evicted))?.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      const safelyOutside = bounds && (direction === 'next' ? bounds.bottom <= view.top + 2 : bounds.top >= view.bottom - 2);
      if (!safelyOutside) {
        if (manual) await navigate(next);
        return;
      }
    }
    const controller = new AbortController();
    flowRequest.current = controller;
    const id = serial.current;
    setFlowing(true);
    setFailure(null);
    try {
      const part = await cache.get(current.index, next, controller.signal);
      if (controller.signal.aborted || id !== serial.current || currentReading.current !== current) return;
      // The reader may have scrolled back while the next section was in flight.
      // Keep the current window if its proposed eviction is visible again.
      if (current.parts.length >= WINDOW_SIZE) {
        const evicted = direction === 'next' ? current.parts[0] : current.parts[current.parts.length - 1];
        const bounds = sections.current.get(partKey(evicted))?.getBoundingClientRect();
        const view = viewport.getBoundingClientRect();
        if (!bounds || (direction === 'next' ? bounds.bottom > view.top + 2 : bounds.top < view.bottom - 2)) return;
      }
      const snapshot = captureStablePosition();
      let parts = direction === 'next' ? [...current.parts, part] : [part, ...current.parts];
      if (parts.length > WINDOW_SIZE) parts = direction === 'next' ? parts.slice(-WINDOW_SIZE) : parts.slice(0, WINDOW_SIZE);
      const retained = !manual && snapshot && parts.some((candidate) => partKey(candidate) === partKey(snapshot.position));
      const destination = direction === 'previous' ? { ...next, ratio: 1 } : next;
      const adopted = adoptSwitch(current.index, part);
      setReading({ index: adopted, parts, position: retained ? snapshot.position : destination, sectionOffset: retained ? snapshot.sectionOffset : undefined, focus: false });
    } catch (error) {
      if (!controller.signal.aborted && id === serial.current) fail(error, next, direction);
    } finally {
      if (flowRequest.current === controller) { flowRequest.current = null; setFlowing(false); }
    }
  }, [adoptSwitch, loading, cache, captureStablePosition, fail, navigate]);

  function onScroll() {
    if (restoring.current || scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (restoring.current) return;
      publishPosition(capturePosition());
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(saveProgress, 400);
      const viewport = scroller.current;
      if (viewport && scrollIntent.current && settings.continuous && !failure && !loading
        && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < viewport.clientHeight * 0.7) void extend('next');
    });
  }

  function updateSettings(next: ReaderSettings) {
    flushPosition();
    setSettings(next);
    if (!next.preloadNext) cache.cancelPrefetch();
    try { window.localStorage.setItem(READER_SETTINGS_KEY, JSON.stringify(next)); }
    catch { setStorageFailed(true); }
  }

  function setFocusMode(next: boolean) { flushPosition(); setFocused(next); }
  function retry() {
    if (!failure || failure.status === 409 || !failure.target) return void loadIndex();
    if (failure.direction) return void extend(failure.direction, true);
    return void navigate(failure.target);
  }

  function markScrollIntent(forward = true) {
    scrollIntent.current = forward;
    const viewport = scroller.current;
    const current = currentReading.current;
    // A wheel/swipe on a fully visible short chapter emits no scroll event.
    // Advance once per user gesture; never recursively download an idle book.
    if (forward && viewport && current && viewport.scrollHeight <= viewport.clientHeight + 1
      && settings.continuous && !failure && !loading) void extend('next', current.parts.length >= WINDOW_SIZE);
  }

  return {
    settings, reading, activePart, loading, flowing, failure, percent, notice, storageFailed, focused,
    scroller, article, heading, onScroll, updateSettings, setFocusMode, navigate, extend, retry,
    markScrollIntent, loadConfirmedBook,
    setSection: (part: ReaderPart, element: HTMLElement | null) => {
      if (element) sections.current.set(partKey(part), element); else sections.current.delete(partKey(part));
    },
  };
}

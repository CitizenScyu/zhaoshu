'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { OwnerProvider, useOwner } from '@/components/OwnerProvider';
import AuthForm from '@/components/AuthForm';
import type { ReaderIndex, ReaderOrigin, ReaderPart, ReadingSession } from '@/lib/reader-types';
import type { SourceAlternateStatus } from '@/lib/source-reader';
import { readingSessionKey } from '@/lib/reader-session';
import { readFeedbackSnapshot } from '@/lib/feedback';
import {
  feedbackPromptKey, hasPromptedFeedback, hasReadingTrace, markFeedbackPrompted,
  planFeedbackPrompt, promptStorage, snapshotHasFeedback,
} from '@/lib/feedback-prompt';
import { DEFAULT_READER_SETTINGS, indexProgressKey } from '@/lib/reader-preferences';
import type { ReaderSettings, ReaderTheme, ReadingPosition } from '@/lib/reader-preferences';
import { useReader, partKey } from './useReader';
import FeedbackPrompt from './FeedbackPrompt';
import { useSourceFanout } from './useSourceFanout';
import type { FanoutRow, ProbeCache } from './useSourceFanout';
import { nextReadingPosition, previousReadingPosition } from '@/lib/reader-part-cache';
import styles from './reader.module.css';

interface Props { session: ReadingSession; from: ReaderOrigin }
const DIRECTORY_PAGE_SIZE = 80;

function bodyText(part: ReaderPart): string {
  const text = part.text.replace(/^\uFEFF/, '');
  if (part.partIndex !== 0) return text;
  const lineEnd = text.search(/[\r\n]/);
  // The title already has its own heading; retain all other original text.
  if (lineEnd >= 0 && text.slice(0, lineEnd).trim() === part.title) return text.slice(lineEnd).replace(/^[\r\n]+/, '');
  if (text.trim() === part.title) return '';
  return text;
}

// T66：返回键是「读完一本书」之后用户一定会走的一步，反馈引导就挂在这里。
// onBeforeNavigate 返回 true 表示这次点击已被接管（展示引导卡），不再跳转。
function BackLink({ from, onBeforeNavigate }: Pick<Props, 'from'> & { onBeforeNavigate?: () => boolean }) {
  return (
    <Link
      className={styles.back}
      href={`/?tab=${from}`}
      onClick={onBeforeNavigate ? (event) => { if (onBeforeNavigate()) event.preventDefault(); } : undefined}
    >
      ← 返回{from === 'shelf' ? '书架' : from === 'find' ? '找书' : '书库'}
    </Link>
  );
}

export default function ReaderClient(props: Props) {
  return <OwnerProvider><ReaderGate {...props} /></OwnerProvider>;
}

function ReaderGate(props: Props) {
  const { ready, user, can, sessionId } = useOwner();
  if (!ready) return <div className={styles.screen}><p className={styles.empty} role="status">正在打开书页…</p></div>;
  if (!user) return <div className={styles.screen}><AccessForm from={props.from} /></div>;
  // 无阅读权限与“文件不存在”必须区分：这里不发请求就给出明确原因。
  if (!can('read')) return <div className={styles.screen}><NoReadPermission from={props.from} /></div>;
  // Drop any in-flight work and previously displayed book when credentials change.
  return <ReaderSession key={`${readingSessionKey(props.session)}:${sessionId}`} {...props} />;
}

/** 站内返回路径；登录成功后回到当前阅读深链。 */
function readerReturnPath(): string | null {
  if (typeof window === 'undefined') return null;
  return `${window.location.pathname}${window.location.search}`;
}

function AccessForm({ from, message }: Pick<Props, 'from'> & { message?: string }) {
  return (
    <div className={styles.access}>
      <BackLink from={from} />
      <div className={styles.accessCard}>
        <span className="seal w-12 h-12 text-lg" aria-hidden="true">书径</span>
        <h1>推门，入书中</h1>
        <p>登录后继续阅读；没有账号可先向管理员申请。</p>
        <AuthForm
          compact
          returnTo={readerReturnPath()}
          message={message}
          classes={{ input: styles.input, primary: styles.primary, error: styles.errorText }}
        />
      </div>
    </div>
  );
}

function NoReadPermission({ from }: Pick<Props, 'from'>) {
  return (
    <div className={styles.access}>
      <BackLink from={from} />
      <div className={styles.accessCard}>
        <span className="seal w-12 h-12 text-lg" aria-hidden="true">书径</span>
        <h1>当前账号尚未获得阅读权限</h1>
        <p>这本书在书库中存在，但当前账号没有在线阅读权限；请联系管理员开通后再试。</p>
      </div>
    </div>
  );
}

function ReaderSession({ session, from }: Props) {
  const { apiFetch, user } = useOwner();
  const router = useRouter();
  const {
    settings, reading, activePart, loading, flowing, failure, percent, notice, storageFailed, focused,
    scroller, article, heading, onScroll, updateSettings, setFocusMode, navigate: requestNavigation,
    extend, retry, markScrollIntent, setSection, loadConfirmedBook, registerSwitchCommitted,
  } = useReader(session, apiFetch, user?.id ?? 0);
  const [panel, setPanel] = useState<'directory' | 'settings' | 'sources' | null>(null);
  // 41-panel:扇出 probe 结果在本阅读会话内复用(关了面板再开不重复出网/计数);换账号时 ReaderSession 重挂即清。
  const [probeCache] = useState<ProbeCache>(() => new Map());
  const restoreButton = useRef<HTMLButtonElement>(null);
  const focusButton = useRef<HTMLButtonElement>(null);
  const tap = useRef<{ x: number; y: number; time: number } | null>(null);
  const chapter = activePart?.chapterIndex ?? 0;
  const chapters = reading?.index.chapters ?? [];
  const first = reading?.parts[0];
  const last = reading?.parts[reading.parts.length - 1];
  const before = reading && first ? previousReadingPosition(reading.index, first) : null;
  const after = reading && last ? nextReadingPosition(reading.index, last) : null;
  const hasNextChapter = chapter + 1 < chapters.length;
  const position = (chapterIndex: number): ReadingPosition => ({ chapterIndex, partIndex: 0, ratio: 0 });
  const screenStyle = { '--reader-font-size': settings.fontSize + 'px', '--reader-line-height': settings.lineHeight } as CSSProperties;

  // T66 反馈入口：返回键只在「有阅读痕迹 + 尚无反馈 + 没引导过」时才被接管。
  const userId = user?.id ?? 0;
  const bookTitle = reading?.index.title ?? '';
  const bookAuthor = reading?.index.author || '佚名';
  // 本机存过进度也算读过（回到开头重看时 percent 为 0）；阈值判定在 lib 里，测试钉得到。
  // useReader 读进度时已经做过旧键迁移，这里取纯键即可，渲染期不写存储。
  const readTrace = useMemo(() => {
    let stored = false;
    try {
      stored = reading ? window.localStorage.getItem(indexProgressKey(reading.index, userId)) !== null : false;
    } catch {
      stored = false; // 存储不可用：没有可靠痕迹，就不引导。
    }
    return hasReadingTrace(percent, stored);
  }, [percent, reading, userId]);

  // 读回线上状态前一律按「已有反馈」处理：宁可不引导，也绝不抢在真相前面弹卡。
  const [hasFeedback, setHasFeedback] = useState(true);
  // 默认按「已引导」：还不知道是哪本书、是谁的时候不判定。
  const prompted = useMemo(() => (
    !bookTitle || userId <= 0
      ? true
      : hasPromptedFeedback(promptStorage(), feedbackPromptKey(userId, bookTitle, bookAuthor))
  ), [bookTitle, bookAuthor, userId]);
  const [promptHandled, setPromptHandled] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const decision = planFeedbackPrompt({ userId, from, read: readTrace, hasFeedback, prompted: prompted || promptHandled });

  // 引导条件在后台先算好：点返回时必须同步可判定，不能卡在一次网络往返上。
  // 失败一律按「已有反馈」——少一次引导也不能耽误用户离开。
  useEffect(() => {
    if (!readTrace || prompted || !bookTitle || userId <= 0) return;
    const controller = new AbortController();
    void apiFetch('/api/feedback?' + new URLSearchParams({ title: bookTitle, author: bookAuthor }), { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error('读取当前反馈失败');
        const snapshot = readFeedbackSnapshot(data?.current);
        if (!snapshot) throw new Error('读取当前反馈失败');
        setHasFeedback(snapshotHasFeedback(snapshot));
      })
      .catch(() => { /* 读不到就维持「已有反馈」，不引导 */ });
    return () => controller.abort();
  }, [apiFetch, readTrace, prompted, bookTitle, bookAuthor, userId]);

  function handleBack(): boolean {
    if (!decision.offer || promptOpen) return false;
    // 展示即记账：同一本书只引导一次，填没填都不再出现。
    markFeedbackPrompted(promptStorage(), feedbackPromptKey(userId, bookTitle, bookAuthor), Date.now());
    setPromptHandled(true);
    setPromptOpen(true);
    return true;
  }

  function leaveReader() {
    setPromptOpen(false);
    router.push(`/?tab=${from}`);
  }

  function navigate(next: ReadingPosition) { setPanel(null); void requestNavigation(next); }
  function showPanel(next: 'directory' | 'settings' | 'sources') { setFocusMode(false); setPanel(next); }
  // M3 手动换源:先走确认重放换目录(useReader 内做进度迁移),再把 book_url 写进 URL 防刷新丢源。
  // readingSessionKey 不含 bookUrl,router.replace 不会重挂 ReaderSession。
  // 复审 P1-3:book_url 只在**目录加载成功后**才写进 URL。确认路径(book_url=...)会让服务端
  // 跳过书名/作者匹配去建目录,一旦该候选建目录失败(404/422/503),URL 若已先被 replace 成
  // 新 book_url,刷新/回退都会重放一个已知失败的候选。失败时 URL 必须保持旧源,用户可重试或换源。
  // 41-panel:扇出面板的确认带上命中行的 sourceUrl(服务端按源精确定位);旧 alternates 面板不带。
  function switchSource(bookUrl: string, sourceUrl?: string) {
    if (session.kind !== 'source' || !bookUrl) return;
    loadConfirmedBook(bookUrl, sourceUrl);
    setPanel(null);
  }
  // 目录加载成功后把 book_url 持久化进 URL(与 loadIndex 成功对齐)。从 indexUrl 取实参,
  // 保证「写进 URL 的就是服务端刚成功建目录的那个候选」。
  const commitSwitchedBookUrl = useCallback((bookUrl: string | undefined, sourceUrl?: string) => {
    if (session.kind !== 'source' || !bookUrl) return;
    const query = new URLSearchParams({ title: session.title, author: session.author, from, book_url: bookUrl });
    if (sourceUrl) query.set('source', sourceUrl);
    if (window.location.search !== '?' + query.toString()) router.replace('/read/source?' + query);
  }, [session, from, router]);
  // M3 复审 P1-3:回调注册放进 effect(ref 写入不得在渲染期做,SSR 会抛)。
  // loadIndex 由 useReader 的 effect 里 queueMicrotask 触发,微排在所有 effect 之后,
  // 因此此处的注册必然先于任何一次 loadIndex 成功回调,时序安全。
  // 注册函数是 hook 内部维护 ref 的稳定句柄(不是裸 ref),避免 react-hooks 的
  // React Compiler 规则判「修改 hook 返回值」error。
  useEffect(() => { registerSwitchCommitted(commitSwitchedBookUrl); }, [registerSwitchCommitted, commitSwitchedBookUrl]);

  function toggleFocus(focusControl = false) {
    const next = !focused;
    setFocusMode(next);
    if (focusControl) requestAnimationFrame(() => (next ? restoreButton : focusButton).current?.focus({ preventScroll: true }));
  }

  if (failure?.status === 401) return <div className={styles.screen}><AccessForm from={from} message={failure.message} /></div>;
  // 403 是“没有阅读权限”，不是“书不存在”；不渲染成通用失败或 404。
  if (failure?.status === 403) return <div className={styles.screen}><NoReadPermission from={from} /></div>;

  return (
    <div
      className={styles.screen}
      data-theme={settings.theme}
      data-font={settings.font}
      data-width={settings.width}
      data-focused={focused}
      style={screenStyle}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && focused && !panel) {
          event.preventDefault(); setFocusMode(false);
          requestAnimationFrame(() => focusButton.current?.focus({ preventScroll: true }));
        }
      }}
    >
      <header className={styles.header} hidden={focused}>
        <BackLink from={from} onBeforeNavigate={handleBack} />
        <div className={styles.bookIdentity}>
          <span className={styles.smallSeal} aria-hidden="true">书径</span>
          <span title={reading?.index.title}>{reading?.index.title ?? '在线阅读'}</span>
        </div>
        <div className={styles.tools}>
          {session.kind === 'source' && <button className={styles.tool} aria-haspopup="dialog" aria-expanded={panel === 'sources'} onClick={() => showPanel('sources')}><span aria-hidden="true">⇄</span> 换源</button>}
          <button ref={focusButton} className={styles.tool} disabled={!reading} aria-label="专注阅读" onClick={() => toggleFocus(true)}>专注</button>
          <button className={styles.tool} disabled={!reading} aria-haspopup="dialog" aria-expanded={panel === 'directory'} onClick={() => showPanel('directory')}><span aria-hidden="true">☷</span> 目录</button>
          <button className={styles.tool} aria-haspopup="dialog" aria-expanded={panel === 'settings'} onClick={() => showPanel('settings')}><span aria-hidden="true">Aa</span> 设置</button>
        </div>
      </header>
      <button ref={restoreButton} hidden={!focused} className={styles.restoreTools} onClick={() => toggleFocus(true)} aria-label="显示工具栏" title="显示工具栏（Esc）">☷</button>
      {failure && (
        <div className={styles.errorBar} role="alert">
          <span>{failure.message}</span>
          <button className={styles.tool} disabled={loading || flowing} onClick={retry}>{failure.status === 409 ? '重新加载目录' : '重试'}</button>
          {/* M3 复审 P1-3:确认失败(候选建目录失败 404/422/503,或章节在新源不可读 503
              SOURCE_CHAPTER_UNAVAILABLE)时必须给一个「换个书源」的出口 —— 用户的本意是
              「我要读这本书」,某个候选失败不该把他困死在重试上。SOURCE_CHANGED 是旧实现的
              死码(服务端已不产出,见 source-reader.ts:634 注释),不再作为条件。 */}
          {session.kind === 'source' && (failure.status === 404 || failure.status === 422 || failure.status === 503)
            && <button className={styles.tool} disabled={loading || flowing} onClick={() => showPanel('sources')}>换个书源</button>}
          {session.kind === 'source' && <Link className={styles.tool} href={`/?${new URLSearchParams({ tab: 'library', q: session.title })}`}>去书库下载全书</Link>}
        </div>
      )}
      {failure?.code === 'SOURCE_SIMILAR' && failure.candidates?.length ? (
        <div className={styles.similarList} role="listbox" aria-label="相似书籍候选">
          {failure.candidates.map((candidate) => (
            <button
              key={candidate.bookUrl}
              className={styles.similarItem}
              role="option"
              aria-selected={false}
              disabled={loading || flowing}
              onClick={() => loadConfirmedBook(candidate.bookUrl)}
            >
              <strong>{candidate.title}</strong>
              <span>{candidate.author || '佚名'}{candidate.alias ? ` · 原名《${candidate.alias}》` : ''} · {candidate.chapters} 章</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.liveStatus} role="status" aria-live="polite">
        {loading ? reading ? '正在打开章节…' : '正在准备目录与正文，首次打开可能需要一点时间…' : notice}
      </div>

      <main
        ref={scroller}
        className={styles.scroller}
        aria-label="阅读正文"
        aria-busy={loading}
        tabIndex={0}
        onScroll={onScroll}
        onWheel={(event) => markScrollIntent(event.deltaY > 0)}
        onPointerDown={(event) => {
          if (event.pointerType !== 'touch' || !event.isPrimary || !(event.target as HTMLElement).closest('[data-reader-prose]')) { tap.current = null; return; }
          tap.current = { x: event.clientX, y: event.clientY, time: performance.now() };
        }}
        onPointerMove={(event) => {
          if (event.pointerType === 'touch' && tap.current && Math.abs(event.clientY - tap.current.y) > 8) {
            markScrollIntent(event.clientY < tap.current.y);
          }
        }}
        onPointerUp={(event) => {
          const start = tap.current;
          tap.current = null;
          if (!start || panel || loading || performance.now() - start.time > 400
            || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8 || window.getSelection()?.isCollapsed === false) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX > bounds.left + bounds.width / 3 && event.clientX < bounds.right - bounds.width / 3) toggleFocus();
        }}
        onPointerCancel={() => { tap.current = null; }}
        onKeyDown={(event) => {
          if (loading || panel || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
          if (['ArrowDown', 'PageDown', ' ', 'End'].includes(event.key)) markScrollIntent(true);
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) markScrollIntent(false);
          if (event.key === 'ArrowLeft' && chapter > 0) { event.preventDefault(); navigate(position(chapter - 1)); }
          if (event.key === 'ArrowRight' && hasNextChapter) { event.preventDefault(); navigate(position(chapter + 1)); }
        }}
      >
        {reading ? (
          <article ref={article} className={styles.page} data-reader-window-size={reading.parts.length}>
            {before && <div className={styles.previousText}><button className={styles.locate} disabled={loading || flowing} onClick={() => void extend('previous', true)}>← 查看上文</button></div>}
            {reading.parts.map((part, index) => {
              const showTitle = index === 0 || part.partIndex === 0;
              return (
                <section
                  key={partKey(part)}
                  ref={(element) => setSection(part, element)}
                  data-reader-part={partKey(part)}
                  className={index > 0 && part.partIndex === 0 ? styles.chapterStart : styles.textSection}
                  aria-label={part.title}
                >
                  {showTitle && <>
                    <div className={styles.chapterMeta}><span>{reading.index.author || '佚名'} 著{reading.index.source ? ` · 书源：${part.servedFrom || reading.index.source.name}` : ''}</span><span>{String(part.chapterIndex + 1).padStart(2, '0')} / {chapters.length}</span></div>
                    {index === 0
                      ? <h1 ref={heading} tabIndex={-1} className={styles.chapterTitle}>{part.title}</h1>
                      : <h2 className={styles.chapterTitle}>{part.title}</h2>}
                  </>}
                  <div className={styles.prose} data-reader-prose aria-label="章节正文">{bodyText(part)}</div>
                </section>
              );
            })}
            <div className={styles.endMark} aria-hidden="true">· · ·</div>
            <nav className={styles.continueNav} aria-label="接着阅读">
              {after
                ? <button className={styles.primary} disabled={loading || flowing} onClick={() => void extend('next', true)}>
                    {flowing ? '正在接续…' : after.chapterIndex === last?.chapterIndex ? '继续本章 →' : '接着读下一章 →'}
                  </button>
                : <p className={styles.finished}>已读到全书末尾 · 合卷，再寻一径</p>}
              {after && settings.continuous && <p className={styles.continuousHint}>向下滚动，接着读</p>}
            </nav>
          </article>
        ) : (
          <div className={styles.empty}>
            <div className="seal w-14 h-14 text-xl" aria-hidden="true">书径</div>
            <h1>{failure ? '暂时未能打开这本书' : '一页书，一段光阴'}</h1>
            <p>{failure ? session.kind === 'source' ? '可重试书源，或到书库尝试下载全书。' : '可重试，或返回查看书籍的下载状态。' : '书页正在准备中…'}</p>
            {failure && <BackLink from={from} />}
          </div>
        )}
      </main>

      <footer className={styles.footer} hidden={focused}>
        <div className={styles.progressTrack} role="progressbar" aria-label="全书阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(percent.toFixed(1))}><span style={{ width: percent + '%' }} /></div>
        <div className={styles.footerInner}>
          <button className={styles.chapterButton} disabled={!reading || loading || chapter === 0} onClick={() => navigate(position(chapter - 1))}>← 上一章</button>
          <button className={styles.progressButton} disabled={!reading} onClick={() => showPanel('directory')} aria-label="打开目录，查看阅读位置">
            <span>{reading ? '第 ' + (chapter + 1) + ' / ' + chapters.length + ' 章' : '待展卷'}</span>
            <small>{reading ? (reading.index.source ? '按章节估算 ' : '全书 ') + percent.toFixed(1) + '%' : '书径 · 在线阅读'}</small>
          </button>
          <button className={styles.chapterButton} disabled={!reading || loading || !hasNextChapter} onClick={() => navigate(position(chapter + 1))}>下一章 →</button>
        </div>
      </footer>
      {storageFailed && <p className={styles.storageWarning} role="status">浏览器未允许保存，阅读进度与设置暂时无法记住。</p>}
      {panel === 'directory' && reading && <Panel title="目录" side="left" onClose={() => setPanel(null)}><Directory index={reading.index} current={chapter} onSelect={(selected) => navigate(position(selected))} /></Panel>}
      {panel === 'settings' && <Panel title="阅读设置" side="right" onClose={() => setPanel(null)}><Settings value={settings} onChange={updateSettings} /></Panel>}
      {panel === 'sources' && session.kind === 'source' && (
        <Panel title="切换书源" side="right" onClose={() => setPanel(null)}>
          <SourcePanel
            apiFetch={apiFetch}
            title={session.title}
            author={session.author}
            session={reading?.index.source?.session}
            currentSourceName={reading?.index.source?.name}
            currentSourceUrl={reading?.index.source?.url}
            probeCache={probeCache}
            onSwitch={switchSource}
          />
        </Panel>
      )}
      {promptOpen && <FeedbackPrompt title={bookTitle} author={bookAuthor} onDone={leaveReader} />}
    </div>
  );
}

function Panel({ title, side, onClose, children }: { title: string; side: 'left' | 'right'; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true }); };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={styles.panel}
      data-side={side}
      aria-label={title}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <div className={styles.panelHeader}><h2>{title}</h2><button className={styles.tool} onClick={onClose} aria-label={`关闭${title}`}>✕</button></div>
      {children}
    </dialog>
  );
}

function Directory({ index, current, onSelect }: { index: ReaderIndex; current: number; onSelect: (index: number) => void }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(Math.floor(current / DIRECTORY_PAGE_SIZE));
  const [locateRequest, setLocateRequest] = useState(0);
  const locateOnRender = useRef(true);
  const currentButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLElement>(null);
  const filtered = useMemo(() => index.chapters.filter((chapter) => chapter.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [index, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / DIRECTORY_PAGE_SIZE));
  const shown = filtered.slice(page * DIRECTORY_PAGE_SIZE, (page + 1) * DIRECTORY_PAGE_SIZE);
  useEffect(() => {
    // A child effect runs before the parent opens its dialog; wait one frame so
    // the current item has a visible box, and reset scroll on directory paging.
    const frame = requestAnimationFrame(() => {
      if (locateOnRender.current && currentButton.current) currentButton.current.scrollIntoView({ block: 'center', behavior: 'instant' });
      else if (list.current) list.current.scrollTop = 0;
      locateOnRender.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [page, query, locateRequest]);
  return (
    <>
      <div className={styles.directoryIntro}>
        <p>{index.title}</p>
        <span>共 {index.chapters.length} 章</span>
        <input className={styles.input} type="search" aria-label="搜索章节" placeholder="搜索章节标题" value={query} onChange={(event) => { locateOnRender.current = false; setQuery(event.target.value); setPage(0); }} />
        <button className={styles.locate} onClick={() => { locateOnRender.current = true; setQuery(''); setPage(Math.floor(current / DIRECTORY_PAGE_SIZE)); setLocateRequest((value) => value + 1); }}>定位当前章</button>
      </div>
      <nav ref={list} className={styles.directoryList} aria-label="章节目录">
        {shown.length ? shown.map((chapter) => (
          <button key={chapter.index} ref={chapter.index === current ? currentButton : undefined} className={styles.directoryItem} aria-current={chapter.index === current ? 'location' : undefined} onClick={() => onSelect(chapter.index)}>
            <span className={styles.chapterNumber}>{String(chapter.index + 1).padStart(2, '0')}</span>
            <span>{chapter.title}</span>
            {chapter.index === current && <small>在读</small>}
          </button>
        )) : <p className={styles.noResults}>没有找到相应章节</p>}
      </nav>
      {pageCount > 1 && <div className={styles.directoryPager}>
        <button className={styles.tool} disabled={page === 0} onClick={() => { locateOnRender.current = false; setPage(page - 1); }}>上一页</button>
        <span>{page + 1} / {pageCount}</span>
        <button className={styles.tool} disabled={page + 1 >= pageCount} onClick={() => { locateOnRender.current = false; setPage(page + 1); }}>下一页</button>
      </div>}
    </>
  );
}

const SOURCE_STATUS_TEXT: Record<SourceAlternateStatus['status'], string> = {
  ok: '', miss: '该书源没有这本书', unreachable: '该书源暂时无法访问',
};

type SourcePanelProps = {
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  title: string; author: string; session?: string; currentSourceName?: string; currentSourceUrl?: string;
  probeCache: ProbeCache;
  onSwitch: (bookUrl: string, sourceUrl?: string) => void;
};

/**
 * 换源面板(41-panel):先试扇出(候选列表 + 逐源并发 probe);扇出未开(404)时退回旧 alternates 面板。
 * 旧面板以当前源 session 为 key(MS-29:源会话一变就重挂重检);扇出面板不随 session 重挂 ——
 * 重挂会把已计数的 probe 再发一遍,当前源标记改由 currentSourceUrl 实时判定。
 */
function SourcePanel({ probeCache, currentSourceUrl, ...props }: SourcePanelProps) {
  const fanout = useSourceFanout({ apiFetch: props.apiFetch, title: props.title, author: props.author, currentSourceUrl, cache: probeCache });
  if (fanout.phase === 'disabled') return <LegacySourcePanel key={props.session} {...props} />;
  return <FanoutSourcePanel fanout={fanout} title={props.title} currentSourceUrl={currentSourceUrl} onSwitch={props.onSwitch} />;
}

// 单源 probe 九种结论的用户文案(ok 行展示书名/章数,不用这里的文案);不认识的状态走兜底文案且不可切换。
const PROBE_STATUS_TEXT: Record<string, string> = {
  ok: '', similar: '找到相近的书,请确认是哪一本', unreadable: '找到但不可读,该书源暂不支持在线阅读',
  ambiguous: '该书源有多部同名作品,无法确定是哪一本', miss: '该书源没有这本书', no_candidates: '该书源没有搜到结果',
  unreachable: '该书源暂时无法访问', timeout: '检测超时', compile_failed: '该书源规则暂不兼容',
};
const ROW_STATE_TEXT: Record<Exclude<FanoutRow['state'], 'done' | 'failed'>, string> = {
  pending: '等待检测', probing: '检测中...', skipped: '未检测(已暂停)', current: '正在阅读',
};

function probeBookText(book: { title: string; author: string; chapters: number }, title: string): string {
  return `${book.title || title}${book.author ? ` · ${book.author}` : ''} · ${book.chapters} 章`;
}

function probeDetail(row: FanoutRow, title: string): string {
  if (row.state === 'failed') return row.message;
  if (row.state !== 'done') return ROW_STATE_TEXT[row.state];
  const { status, book, candidates } = row.result;
  if (status === 'ok' && book) return probeBookText(book, title);
  const text = PROBE_STATUS_TEXT[status] ?? '暂不支持的检测结果';
  // unreadable 仍展示找到的书(仅展示,不给切换入口)。
  const found = status === 'unreadable' ? book ?? candidates?.[0] : undefined;
  return found ? `${text}(${probeBookText(found, title)})` : text;
}

function FanoutSourcePanel({ fanout, title, currentSourceUrl, onSwitch }: {
  fanout: ReturnType<typeof useSourceFanout>; title: string; currentSourceUrl?: string;
  onSwitch: (bookUrl: string, sourceUrl?: string) => void;
}) {
  const { phase, rows, retryAfter, message, rescan } = fanout;
  const busy = phase === 'loading' || phase === 'running';
  const settled = rows.filter((row) => row.state === 'done' || row.state === 'failed').length;
  return (
    <div className={styles.sources}>
      <p className={styles.sourcesIntro}>逐个检测各书源能否提供这本书,检测完一个显示一个;可切换的书源点「切换到此源」,尽量保留当前阅读进度。</p>
      <div className={styles.sourceActions}>
        <button className={styles.locate} disabled={busy} onClick={rescan}>{busy ? '检测中...' : '重新检测'}</button>
      </div>
      {phase === 'rate_limited' && <p className={styles.sourcesError} role="alert">检测过于频繁,请稍后再试{retryAfter ? `（${retryAfter} 秒）` : ''}。</p>}
      {(phase === 'unavailable' || phase === 'error') && <p className={styles.sourcesError} role="alert">{message}</p>}
      {phase === 'loading' && <p className={styles.noResults}>正在获取候选书源...</p>}
      {phase === 'done' && !rows.length && <p className={styles.noResults}>暂无可检测的书源。</p>}
      {rows.length > 0 && <p className={styles.sourcesNote} role="status">已检测 {settled} / {rows.length}</p>}
      {rows.length > 0 && <ul className={styles.sourceList}>
        {rows.map((row) => {
          const current = row.url === currentSourceUrl;
          const result = row.state === 'done' ? row.result : null;
          // 只有 readable 的 ok / similar 可切换;unreadable 与任何不认识的状态一律仅展示。
          const switchable = !!result && result.readable && !current;
          const book = switchable && result.status === 'ok' ? result.book : undefined;
          const candidates = switchable && result.status === 'similar' ? result.candidates ?? [] : [];
          return (
            <li key={row.url} className={styles.sourceRow} data-probe-status={result ? result.status : row.state} aria-current={current ? 'true' : undefined}>
              <span className={styles.sourceName}>{row.name}{current && <small className={styles.sourceBadge}>当前源</small>}</span>
              <span className={styles.sourceDetail}>{probeDetail(row, title)}</span>
              {book?.bookUrl && <button className={styles.locate} onClick={() => onSwitch(book.bookUrl, result!.sourceUrl)}>切换到此源</button>}
              {candidates.map((candidate) => (
                <button key={candidate.bookUrl} className={styles.similarItem} onClick={() => onSwitch(candidate.bookUrl, result!.sourceUrl)}>
                  <strong>{candidate.title}</strong>
                  <span>{candidate.author || '佚名'}{candidate.alias ? ` · 原名《${candidate.alias}》` : ''} · {candidate.chapters} 章 · 切换到此源</span>
                </button>
              ))}
            </li>
          );
        })}
      </ul>}
    </div>
  );
}

/** 旧换源面板(设计 §4,扇出未开时的回退):打开即检测,一次会话内默认只自动检测一次;「重新检测」手动刷新。 */
function LegacySourcePanel({ apiFetch, title, author, session: catalogSession, currentSourceName, onSwitch }: Omit<SourcePanelProps, 'probeCache' | 'currentSourceUrl'>) {
  const [sources, setSources] = useState<SourceAlternateStatus[] | null>(null);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState('');
  const [detecting, setDetecting] = useState(false);
  const request = useRef<AbortController | null>(null);
  const autoDone = useRef(false);

  const detect = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setDetecting(true); setError('');
    const query = new URLSearchParams({ title, author });
    if (catalogSession) query.set('session', catalogSession);
    void apiFetch('/api/read/source/alternates?' + query, { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : '检测书源失败,请重试。');
        if (controller.signal.aborted) return;
        // 当前源标记以 session 目录实况为准;服务端已标,这里回退用前端已知源名兜底。
        const list: SourceAlternateStatus[] = Array.isArray(data?.sources) ? data.sources : [];
        if (currentSourceName && !list.some((item) => item.current)) {
          for (const item of list) if (item.sourceName === currentSourceName) item.current = true;
        }
        setSources(list); setPartial(data?.partial === true);
      })
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '检测书源失败,请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setDetecting(false); });
  }, [apiFetch, title, author, catalogSession, currentSourceName]);

  useEffect(() => {
    if (autoDone.current) return;
    autoDone.current = true;
    detect();
    return () => request.current?.abort();
  }, [detect]);

  const ordered = sources ? [...sources].sort((a, b) => (a.current ? -1 : 0) - (b.current ? -1 : 0)) : null;
  return (
    <div className={styles.sources}>
      <p className={styles.sourcesIntro}>下方列出各书源能否提供这本书;点击可切换书源,尽量保留当前阅读进度。</p>
      <div className={styles.sourceActions}>
        <button className={styles.locate} disabled={detecting} onClick={detect}>{detecting ? '检测中...' : '重新检测'}</button>
      </div>
      {error && <p className={styles.sourcesError} role="alert">{error}</p>}
      {detecting && !ordered && <p className={styles.noResults}>正在检测各书源...</p>}
      {ordered && <ul className={styles.sourceList}>
        {ordered.map((item) => {
          const clickable = item.status === 'ok' && !item.current && !!item.bookUrl;
          return (
            <li key={item.sourceName + (item.bookUrl ?? '')}>
              <button
                className={styles.sourceItem}
                data-status={item.status}
                disabled={!clickable}
                aria-current={item.current ? 'true' : undefined}
                onClick={() => clickable && onSwitch(item.bookUrl!)}
              >
                <span className={styles.sourceName}>{item.sourceName}</span>
                {item.current && <small className={styles.sourceBadge}>当前源</small>}
                {item.status === 'ok'
                  ? <span>{item.title || title}{item.author ? ` · ${item.author}` : ''} · {item.chapters} 章</span>
                  : <span>{SOURCE_STATUS_TEXT[item.status]}</span>}
              </button>
            </li>
          );
        })}
      </ul>}
      {partial && <p className={styles.sourcesNote}>部分书源未检测完(预算或时间限制),可再次点击「重新检测」。</p>}
    </div>
  );
}

function Settings({ value, onChange }: { value: ReaderSettings; onChange: (value: ReaderSettings) => void }) {
  const themes: { key: ReaderTheme; label: string }[] = [{ key: 'day', label: '日间' }, { key: 'night', label: '夜间' }, { key: 'sage', label: '护眼' }];
  return (
    <div className={styles.settings}>
      <fieldset>
        <legend>字号</legend>
        <div className={styles.fontControl}>
          <button className={styles.secondary} aria-label="减小字号" disabled={value.fontSize <= 16} onClick={() => onChange({ ...value, fontSize: Math.max(16, value.fontSize - 2) })}>A−</button>
          <output aria-live="polite">{value.fontSize}</output>
          <button className={styles.secondary} aria-label="增大字号" disabled={value.fontSize >= 30} onClick={() => onChange({ ...value, fontSize: Math.min(30, value.fontSize + 2) })}>A＋</button>
        </div>
      </fieldset>
      <fieldset>
        <legend>行距</legend>
        <div className={styles.choices}>
          {[{ value: 1.6, label: '紧凑' }, { value: 1.9, label: '适中' }, { value: 2.2, label: '宽松' }].map((line) => <button key={line.value} className={styles.choice} aria-pressed={value.lineHeight === line.value} onClick={() => onChange({ ...value, lineHeight: line.value })}>{line.label}</button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>字体</legend>
        <div className={styles.choices}>
          {([{ key: 'wenkai', label: '文楷' }, { key: 'serif', label: '宋体' }, { key: 'sans', label: '黑体' }] as const).map((font) => <button key={font.key} className={styles.choice} aria-pressed={value.font === font.key} onClick={() => onChange({ ...value, font: font.key })}>{font.label}</button>)}
        </div>
      </fieldset>
      <fieldset className={styles.widthSetting}>
        <legend>阅读宽度</legend>
        <div className={styles.choices}>
          {([{ key: 'narrow', label: '窄' }, { key: 'standard', label: '标准' }, { key: 'wide', label: '宽' }] as const).map((width) => <button key={width.key} className={styles.choice} aria-pressed={value.width === width.key} onClick={() => onChange({ ...value, width: width.key })}>{width.label}</button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>纸色</legend>
        <div className={styles.choices}>
          {themes.map((theme) => <button key={theme.key} className={styles.themeChoice} aria-pressed={value.theme === theme.key} onClick={() => onChange({ ...value, theme: theme.key })}><span data-swatch={theme.key} aria-hidden="true">文</span>{theme.label}</button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>接着阅读</legend>
        <label className={styles.switchRow}><span>滚动自动接续<small>接近章末时载入后文</small></span><input type="checkbox" checked={value.continuous} onChange={(event) => onChange({ ...value, continuous: event.target.checked })} /></label>
        <label className={styles.switchRow}><span>提前载入下一处<small>减少翻章等待，省流量模式下自动暂停</small></span><input type="checkbox" checked={value.preloadNext} onChange={(event) => onChange({ ...value, preloadNext: event.target.checked })} /></label>
      </fieldset>
      <div className={styles.settingSample} style={{ fontSize: value.fontSize, lineHeight: value.lineHeight }}>掬一捧月色，<br />翻一页山河。</div>
      <button className={styles.locate} onClick={() => onChange({ ...DEFAULT_READER_SETTINGS })}>恢复默认设置</button>
      <p className={styles.settingsNote}>设置与阅读进度保存在此浏览器。下次打开，会回到上次读到的地方。</p>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { OwnerProvider, useOwner } from '@/components/OwnerProvider';
import type { ReaderIndex, ReaderPart } from '@/lib/reader-types';
import {
  DEFAULT_READER_SETTINGS,
} from '@/lib/reader-preferences';
import type { ReaderSettings, ReaderTheme, ReadingPosition } from '@/lib/reader-preferences';
import { useReader, partKey } from './useReader';
import { nextReadingPosition, previousReadingPosition } from '@/lib/reader-part-cache';
import styles from './reader.module.css';

interface Props { taskId: number; from: 'library' | 'shelf' }
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

function BackLink({ from }: Pick<Props, 'from'>) {
  return <Link className={styles.back} href={`/?tab=${from}`}>← 返回{from === 'shelf' ? '书架' : '书库'}</Link>;
}

export default function ReaderClient(props: Props) {
  return <OwnerProvider><ReaderGate {...props} /></OwnerProvider>;
}

function ReaderGate(props: Props) {
  const { ready, token } = useOwner();
  if (!ready) return <div className={styles.screen}><p className={styles.empty} role="status">正在打开书页…</p></div>;
  if (!token) return <div className={styles.screen}><AccessForm from={props.from} /></div>;
  // Drop any in-flight work and previously displayed book when credentials change.
  return <ReaderSession key={`${props.taskId}:${token}`} {...props} />;
}

function AccessForm({ from, message }: Pick<Props, 'from'> & { message?: string }) {
  const { setToken } = useOwner();
  const [draft, setDraft] = useState('');
  return (
    <div className={styles.access}>
      <BackLink from={from} />
      <div className={styles.accessCard}>
        <span className="seal w-12 h-12 text-lg" aria-hidden="true">书径</span>
        <h1>推门，入书中</h1>
        <p>输入站点访问口令，继续阅读。</p>
        {message && <p role="alert" className={styles.errorText}>{message}</p>}
        <form onSubmit={(event) => { event.preventDefault(); if (draft.trim()) setToken(draft); }}>
          <label htmlFor="reader-owner-token">访问口令</label>
          <input id="reader-owner-token" className={styles.input} type="password" autoComplete="current-password" value={draft} onChange={(event) => setDraft(event.target.value)} required />
          <button className={styles.primary} type="submit" disabled={!draft.trim()}>开始阅读 →</button>
        </form>
      </div>
    </div>
  );
}

function ReaderSession({ taskId, from }: Props) {
  const { apiFetch } = useOwner();
  const {
    settings, reading, activePart, loading, flowing, failure, percent, notice, storageFailed, focused,
    scroller, article, heading, onScroll, updateSettings, setFocusMode, navigate: requestNavigation,
    extend, retry, markScrollIntent, setSection,
  } = useReader(taskId, apiFetch);
  const [panel, setPanel] = useState<'directory' | 'settings' | null>(null);
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

  function navigate(next: ReadingPosition) { setPanel(null); void requestNavigation(next); }
  function showPanel(next: 'directory' | 'settings') { setFocusMode(false); setPanel(next); }
  function toggleFocus(focusControl = false) {
    const next = !focused;
    setFocusMode(next);
    if (focusControl) requestAnimationFrame(() => (next ? restoreButton : focusButton).current?.focus({ preventScroll: true }));
  }

  if (failure?.status === 401) return <div className={styles.screen} data-theme={settings.theme}><AccessForm from={from} message={failure.message} /></div>;

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
        <BackLink from={from} />
        <div className={styles.bookIdentity}>
          <span className={styles.smallSeal} aria-hidden="true">书径</span>
          <span title={reading?.index.title}>{reading?.index.title ?? '在线阅读'}</span>
        </div>
        <div className={styles.tools}>
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
        </div>
      )}
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
                    <div className={styles.chapterMeta}><span>{reading.index.author || '佚名'} 著</span><span>{String(part.chapterIndex + 1).padStart(2, '0')} / {chapters.length}</span></div>
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
            <p>{failure ? '可重试，或返回查看书籍的下载状态。' : '书页正在准备中…'}</p>
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
            <small>{reading ? '全书 ' + percent.toFixed(1) + '%' : '书径 · 在线阅读'}</small>
          </button>
          <button className={styles.chapterButton} disabled={!reading || loading || !hasNextChapter} onClick={() => navigate(position(chapter + 1))}>下一章 →</button>
        </div>
      </footer>
      {storageFailed && <p className={styles.storageWarning} role="status">浏览器未允许保存，阅读进度与设置暂时无法记住。</p>}
      {panel === 'directory' && reading && <Panel title="目录" side="left" onClose={() => setPanel(null)}><Directory index={reading.index} current={chapter} onSelect={(selected) => navigate(position(selected))} /></Panel>}
      {panel === 'settings' && <Panel title="阅读设置" side="right" onClose={() => setPanel(null)}><Settings value={settings} onChange={updateSettings} /></Panel>}
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

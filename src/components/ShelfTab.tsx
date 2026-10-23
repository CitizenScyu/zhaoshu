'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeedbackStatus, ShelfStatus } from '@/lib/types';
import { feedbackProfileUpdateMessage, MAX_FEEDBACK_NOTE_LENGTH } from '@/lib/feedback';
import { useOwner } from '@/components/OwnerProvider';
import FeedbackForm from '@/components/FeedbackForm';
import ReadBookLink from '@/components/ReadBookLink';
import { readSourceMemory } from '@/lib/source-memory';
import { userReadingProgressKey } from '@/lib/user-scope';
import {
  CLEAR_NEW_TARGET, SHELF_ROW_LIMIT, filterShelfCards, foldShelfItems, nextConfirm, removeTarget,
} from '@/lib/shelf-view';

interface ShelfItem {
  id: number;
  book_id: number;
  query: string;
  match_score: number | null;
  hit_likes: string[] | null;
  risks: string | null;
  reason: string | null;
  status: ShelfStatus;
  note: string;
  feedback_id?: number;
  created_at: string;
  title: string;
  author: string;
  douban_id: string | null;
  douban_rating: number | null;
  douban_rating_count: number | null;
  meta: { category?: string; wordCount?: string };
  read_task_id?: number | null;
  /** zhuigeng42：最新那版全文发布得比该用户最后一次阅读进度更新（服务端按 done 任务与进度项比较）。 */
  has_update?: boolean;
}

const GROUPS: { key: ShelfStatus; label: string; color: string }[] = [
  { key: 'want', label: '想读', color: 'var(--dai)' },
  { key: 'reading', label: '在读', color: 'var(--gold)' },
  { key: 'done', label: '读完', color: 'var(--moss)' },
  { key: 'dropped', label: '弃书', color: 'var(--cinnabar)' },
  { key: 'new', label: '未处理', color: 'var(--ink-faint)' },
];

/** readerux42-C:任务类阅读进度的宽松读取(只取排序与章节展示需要的字段,坏形状一律当没有)。 */
function taskProgressOf(raw: string | null): { updatedAt: number; chapterIndex: number } | null {
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const { chapterIndex, updatedAt } = record;
    if (record.schema !== 1
      || typeof chapterIndex !== 'number' || !Number.isSafeInteger(chapterIndex) || chapterIndex < 0
      || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    return { updatedAt, chapterIndex };
  } catch {
    return null;
  }
}

/** zhuigeng42「有更新」徽标：仅样式提示，不改变卡片其余行为；颜色用现成 css 变量。 */
function UpdateBadge() {
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded border shrink-0"
      style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
      aria-label="有更新"
    >
      有更新
    </span>
  );
}

function readTimeAgo(at: number, now: number): string {
  const minutes = Math.max(1, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/** 「最近在读」时间基准的推进间隔：细到分钟级文案不滞后，又不至于让书架整节无谓重渲染。 */
const RECENT_READS_TICK_MS = 60_000;

export default function ShelfTab() {
  const { apiFetch, user, sessionId, isCurrentSession } = useOwner();
  const [items, setItems] = useState<ShelfItem[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [keyword, setKeyword] = useState('');
  // 两段式确认的当前武装目标（'remove:<id>' / 'clear:new'），同时只允许一个。
  const [armed, setArmed] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; status: FeedbackStatus; clear?: boolean } | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState('');
  // T66：移出书架时的一句话反馈（选填，绝不强制）。草稿按条目存，不会带到下一本。
  const [removeDraft, setRemoveDraft] = useState<{ id: number; text: string } | null>(null);
  // 原因已经 POST 成功、只剩 DELETE 没成功的条目：重试必须只补删除这一步。
  // 再 POST 一次会插一条新 feedback，而 expectedFeedbackId 仍是旧的，必然 409 卡死。
  const [noteSaved, setNoteSaved] = useState<{ id: number; text: string } | null>(null);
  const removeDraftRef = useRef<{ id: number; text: string } | null>(null);
  useEffect(() => { removeDraftRef.current = removeDraft; }, [removeDraft]);
  // 手动操作(移除/清理)的全链路取消器:反馈保存→删除→重载是一整个动作,离页即作废。
  // 没有它,迟到的 JSON 兑现后 doRemove 会拿着稳定 apiFetch 继续走完剩下的 DELETE 和
  // 重载——AuthController.fetch 每次选当前会话,身份已换时就以新用户身份发连续写入。
  // abort 同时中止在途 POST/DELETE;取消不宣称服务端已提交的写入被回滚。
  const operationAbort = useRef<AbortController | null>(null);
  useEffect(() => () => operationAbort.current?.abort(), []);

  const busy = updating || loading || removing || clearing;

  const load = useCallback(async (signal?: AbortSignal) => {
    const current = () => !signal?.aborted && isCurrentSession(sessionId);
    if (!current()) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/recommendations', { signal });
      if (!current()) return;
      const data = await res.json();
      if (!current()) return;
      if (!res.ok) throw new Error(data.error || '书架加载失败');
      setItems(data.recommendations);
    } catch (error) {
      if (!current()) return;
      setError(error instanceof Error ? error.message : '书架加载失败');
    } finally {
      if (current()) setLoading(false);
    }
  }, [apiFetch, sessionId, isCurrentSession]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  const cards = useMemo(() => foldShelfItems(items ?? []), [items]);
  const visible = useMemo(() => filterShelfCards(cards, keyword), [cards, keyword]);
  // 后端一次最多返回 SHELF_ROW_LIMIT 本，拿满就说明后面还有没列出来的。
  const truncated = (items?.length ?? 0) >= SHELF_ROW_LIMIT;

  // render 期不能取当前时间（react-hooks/purity：Date.now() 写在渲染里会让「多久以前」随每次
  // 无关重渲染漂移，SSR 与水合也对不上）。挂载后取一次基准、每 RECENT_READS_TICK_MS 推进一次：
  // 纯度合规，时间文案还能自己走动。now=0 表示基准尚未取到，「最近在读」整节先不渲染——
  // items 本来就是异步取回的（初值 null），用户看不到这一帧。
  const [now, setNow] = useState(0);
  useEffect(() => {
    const stamp = () => setNow(Date.now());
    stamp();
    const timer = window.setInterval(stamp, RECENT_READS_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // readerux42-C「最近在读」:按本地阅读数据(任务进度 localStorage + 源记忆)的最后阅读时间
  // 排序,同一本书取最新一条、最多 5 本;点进走 ReadBookLink 深链,阅读页自己恢复到章节位置。
  // 只做只读合成,不写存储;无进度数据(含未登录)整节不渲染。
  const recentReads = useMemo(() => {
    if (!items || !user || !now) return [];
    const userId = user.id;
    const best = new Map<number, { item: ShelfItem; at: number; chapter: number | null }>();
    for (const item of items) {
      let at = 0;
      let chapter: number | null = null;
      if (typeof item.read_task_id === 'number') {
        let raw: string | null = null;
        try { raw = window.localStorage.getItem(userReadingProgressKey(userId, item.read_task_id)); } catch { raw = null; }
        const progress = taskProgressOf(raw);
        if (progress) { at = progress.updatedAt; chapter = progress.chapterIndex; }
      }
      // 源类在线读没有任务 id:用「按书记住上次读通的源」的时间(身份键即书名+作者归一)。
      const memory = readSourceMemory(item.title, item.author, now);
      if (memory && memory.at > at) at = memory.at;
      if (at <= 0) continue;
      const previous = best.get(item.book_id);
      if (!previous || at > previous.at) best.set(item.book_id, { item, at, chapter });
    }
    return [...best.values()].sort((a, b) => b.at - a.at).slice(0, 5);
  }, [items, user, now]);

  // 两段式确认：第一次点只武装，第二次点同一目标才放行；3 秒无后续点击自动解除。
  // 换目标只重新武装当前目标，不会顺手放行上一个目标。
  function armOrFire(target: string): boolean {
    if (!isCurrentSession(sessionId)) return false;
    const step = nextConfirm(armed, target);
    setArmed(step.armed);
    if (!step.fire) {
      // T66：正在这个目标下写原因的条目不自动解除——3 秒到点把用户写了一半的输入
      // 从眼前抽走太粗暴。清空未处理那条没有草稿，行为与原来完全一致。
      window.setTimeout(() => setArmed((cur) => (
        cur === target && removeDraftRef.current && removeTarget(removeDraftRef.current.id) === target
          && removeDraftRef.current.text ? cur : (cur === target ? null : cur)
      )), 3000);
    }
    return step.fire;
  }

  function askRemove(item: ShelfItem) {
    if (!isCurrentSession(sessionId)) return;
    const target = removeTarget(item.id);
    // T66：第一次点「✕ 移除」时顺带给一个选填的一句话入口（已表过态且还没写原因的书）。
    // 换目标就换草稿，不会把上一本的输入带过来。
    if (armed !== target) {
      setRemoveDraft(item.status !== 'new' && !item.note
        ? { id: item.id, text: noteSaved?.id === item.id ? noteSaved.text : '' }
        : null);
    }
    if (armOrFire(target)) void doRemove(item);
  }

  async function doRemove(item: ShelfItem) {
    if (removing || clearing || operationAbort.current || !isCurrentSession(sessionId)) return;
    setArmed(null);
    setRemoving(true);
    setError('');
    setFeedbackMessage('');
    const draft = removeDraft?.id === item.id ? removeDraft.text.trim() : '';
    // 上次已经存过这条原因就不再 POST：重试只补 DELETE，避免反复插入新 feedback 撞 409。
    let noteIsSaved = noteSaved?.id === item.id;
    // 本操作全链路持同一取消器;重试是全新操作,领新的 controller。
    const controller = new AbortController();
    operationAbort.current = controller;
    const current = () => !controller.signal.aborted && isCurrentSession(sessionId);
    try {
      if (draft && !noteIsSaved) {
        // 先存原因再移除：反馈挂在书上而不是推荐行上，移除后画像仍能用上这一句。
        // 存不下就不移除——用户刚敲的字不能悄悄丢。
        const saved = await apiFetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.title, author: item.author, status: item.status,
            note: draft, expectedFeedbackId: item.feedback_id ?? 0,
          }),
          signal: controller.signal,
        });
        if (!current()) return;
        const data = await saved.json().catch(() => ({}));
        if (!current()) return;
        if (!saved.ok || data.ok !== true) {
          throw new Error(typeof data.error === 'string' ? data.error : '原因未能保存，这本书已留在书架');
        }
        noteIsSaved = true;
        setNoteSaved({ id: item.id, text: draft });
      }
      // F05：按书移除（book_id），服务端删除该用户这本书的全部推荐行；不再传单条推荐 id。
      const res = await apiFetch(`/api/shelf?bookId=${item.book_id}`, { method: 'DELETE', signal: controller.signal });
      if (!current()) return;
      const data = await res.json().catch(() => ({}));
      if (!current()) return;
      // 删除已提交但响应丢失，或另一页已移除时，目标已经达成；刷新以恢复本地视图。
      const alreadyRemoved = res.status === 404 && data.code === 'RECOMMENDATION_NOT_FOUND';
      if (!res.ok && !alreadyRemoved) throw new Error(data.error || '移除失败');
      setRemoveDraft(null);
      setNoteSaved(null);
      await load(controller.signal);
    } catch (error) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : '移除失败';
      // 失败后重新武装这一条并把草稿留在眼前；原因已经落库的要说实话——字没丢，重试只补移除。
      if (noteIsSaved || draft) setArmed(removeTarget(item.id));
      setError(noteIsSaved ? `原因已记下，但这本书还没移出：${message}` : message);
    } finally {
      if (operationAbort.current === controller) operationAbort.current = null;
      if (current()) setRemoving(false);
    }
  }

  async function doClearNew() {
    if (clearing || removing || operationAbort.current || !isCurrentSession(sessionId)) return;
    setClearing(true);
    setError('');
    setFeedbackMessage('');
    // 与 doRemove 同一套全链路取消器:清理→重载是一个动作,离页即作废。
    const controller = new AbortController();
    operationAbort.current = controller;
    const current = () => !controller.signal.aborted && isCurrentSession(sessionId);
    try {
      const res = await apiFetch('/api/shelf/unprocessed', { method: 'DELETE', signal: controller.signal });
      if (!current()) return;
      const data = await res.json().catch(() => ({}));
      if (!current()) return;
      if (!res.ok) throw new Error(data.error || '清理失败');
      const cleared = typeof data.cleared === 'number' ? data.cleared : 0;
      setFeedbackMessage(cleared > 0 ? `已清空 ${cleared} 条未处理推荐` : '没有可清理的未处理推荐');
      await load(controller.signal);
    } catch (error) {
      if (current()) setError(error instanceof Error ? error.message : '清理失败');
    } finally {
      if (operationAbort.current === controller) operationAbort.current = null;
      if (current()) setClearing(false);
    }
  }

  if (items === null && loading) {
    return (
      <div className="flex gap-1.5 py-10 justify-center">
        <span className="ink-drop" />
        <span className="ink-drop" style={{ animationDelay: '0.18s' }} />
        <span className="ink-drop" style={{ animationDelay: '0.36s' }} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {feedbackMessage && (
        <p role="status" className="text-sm" style={{ color: 'var(--moss)' }}>{feedbackMessage}</p>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--cinnabar)' }}>
          <p>{error}</p>
          <button className="chip" onClick={() => void load()} disabled={busy}>
            {loading ? '加载中…' : '重新加载'}
          </button>
        </div>
      )}
      {!error && items?.length === 0 && (
        <p className="text-sm py-10 text-center" style={{ color: 'var(--ink-faint)' }}>
          书架空空，先去「找书」跑一单
        </p>
      )}
      {recentReads.length > 0 && (
        <section aria-label="最近在读">
          <div className="flex flex-wrap items-center gap-2 mb-3 pb-2 border-b border-dashed" style={{ borderColor: 'var(--line)' }}>
            <h2 className="text-sm font-bold tracking-[0.25em]" style={{ color: 'var(--gold)' }}>
              最近在读 · {recentReads.length}
            </h2>
          </div>
          <div className="space-y-2.5">
            {recentReads.map(({ item, at, chapter }) => (
              <div key={item.id} className="book-card px-5 py-3 pl-6 flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1">
                  <span className="font-bold break-words">{item.title}</span>
                  {item.has_update && <span className="ml-2 inline-block align-middle"><UpdateBadge /></span>}
                  <span className="text-xs ml-2 break-words" style={{ color: 'var(--ink-faint)' }}>
                    {item.author}
                  </span>
                </div>
                <span className="text-xs shrink-0" style={{ color: 'var(--ink-faint)' }}>
                  {readTimeAgo(at, now)}
                </span>
                <ReadBookLink
                  taskId={item.read_task_id}
                  title={item.title}
                  author={item.author}
                  from="shelf"
                  label={chapter != null ? `续读 · 第 ${chapter + 1} 章` : '续读'}
                />
              </div>
            ))}
          </div>
        </section>
      )}
      {cards.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="paper-input text-sm !py-1.5 min-w-0 flex-1 w-40 sm:w-64"
            placeholder="搜书名 / 作者"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="书架搜索"
          />
          {keyword && (
            <button className="chip text-xs" onClick={() => setKeyword('')} aria-label="清除书架搜索">
              清除
            </button>
          )}
          <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            共 {cards.length} 本{keyword ? ` · 命中 ${visible.length}` : ''}
          </span>
        </div>
      )}
      {truncated && (
        <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
          书架一次最多显示 {SHELF_ROW_LIMIT} 本，更多的未列出。
        </p>
      )}
      {cards.length > 0 && visible.length === 0 && (
        <p className="text-sm py-10 text-center" style={{ color: 'var(--ink-faint)' }}>
          没有匹配「{keyword}」的书
        </p>
      )}
      {GROUPS.map((g) => {
        const group = visible.filter((c) => (c.master.status || 'new') === g.key);
        if (group.length === 0) return null;
        return (
          <section key={g.key}>
            <div className="flex flex-wrap items-center gap-2 mb-3 pb-2 border-b border-dashed" style={{ borderColor: 'var(--line)' }}>
              <h2 className="text-sm font-bold tracking-[0.25em]" style={{ color: g.color }}>
                {g.label} · {group.length}
              </h2>
              {g.key === 'new' && (
                <button
                  className="chip text-xs"
                  style={armed === CLEAR_NEW_TARGET
                    ? { borderColor: 'var(--cinnabar)', color: 'var(--cinnabar)' }
                    : { color: 'var(--ink-faint)' }}
                  disabled={busy}
                  onClick={() => { if (armOrFire(CLEAR_NEW_TARGET)) void doClearNew(); }}
                  aria-label={armed === CLEAR_NEW_TARGET ? '再次点击确认清空全部未处理推荐' : '清空全部未处理推荐'}
                >
                  {armed === CLEAR_NEW_TARGET ? '确认清空全部未处理?' : '清空未处理'}
                </button>
              )}
            </div>
            <div className="space-y-2.5">
              {group.map((card, i) => {
                const it = card.master;
                return (
                <div
                  key={it.id}
                  className="book-card px-5 py-3.5 pl-6 flex flex-wrap items-center gap-x-4 gap-y-3 ink-rise"
                  style={{ animationDelay: `${i * 0.04}s` }}
                >
                  <div className="w-full sm:w-auto sm:flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2.5">
                      <span className="min-w-0 max-w-full font-bold break-words">{it.title}</span>
                      {it.has_update && <UpdateBadge />}
                      <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
                        {it.author}
                        {it.meta?.category ? ` · ${it.meta.category}` : ''}
                        {it.douban_rating != null ? ` · 豆瓣 ${it.douban_rating}` : ''}
                      </span>
                    </div>
                    {it.reason && (
                      <p className="text-xs mt-1 break-words leading-5" style={{ color: 'var(--ink-soft)' }}>
                        {it.reason}
                      </p>
                    )}
                    {card.queries.length > 1 && (
                      <p className="text-xs mt-1 break-words" style={{ color: 'var(--ink-faint)' }}>
                        来自 {card.queries.length} 次查询：{card.queries.join(' · ')}
                      </p>
                    )}
                    {it.status !== 'new' && (
                      <p className="text-xs mt-2 break-words whitespace-pre-wrap leading-6" style={{ color: 'var(--ink-soft)' }}>
                        <span className="font-bold">反馈原因：</span>{it.note || '尚未填写'}
                      </p>
                    )}
                  </div>
                  <span className="text-xs shrink-0" style={{ color: 'var(--ink-faint)' }}>
                    {new Date(it.created_at).toLocaleDateString('zh-CN')}
                  </span>
                  {/* 状态切换 */}
                  <div className="flex flex-wrap gap-1.5 sm:shrink-0">
                    <ReadBookLink taskId={it.read_task_id} title={it.title} author={it.author} from="shelf" />
                    {(
                      [
                        ['want', '想读'],
                        ['reading', '在读'],
                        ['done', '完'],
                        ['dropped', '弃'],
                      ] as [FeedbackStatus, string][]
                    ).map(([st, label]) => (
                      <button
                        key={st}
                        className="chip text-xs"
                        style={
                          (it.status || 'new') === st
                            ? { borderColor: g.color, color: g.color }
                            : undefined
                        }
                        onClick={() => {
                          setEditing({ id: it.id, status: st });
                          setFeedbackMessage('');
                        }}
                        disabled={busy || it.status === st}
                        aria-label={`将${it.title}标记为${GROUPS.find((group) => group.key === st)?.label}`}
                      >
                        {label}
                      </button>
                    ))}
                    {it.status !== 'new' && (
                      <button
                        className="chip chip-dai text-xs"
                        disabled={busy}
                        aria-expanded={editing?.id === it.id}
                        onClick={() => {
                          if (it.status === 'new') return;
                          setEditing({ id: it.id, status: it.status });
                          setFeedbackMessage('');
                        }}
                      >
                        {it.note ? '编辑反馈' : '补充原因'}
                      </button>
                    )}
                    {it.status !== 'new' && it.note && (
                      <button
                        className="chip text-xs"
                        disabled={busy}
                        aria-label={`清除${it.title}的反馈原因，保留阅读状态`}
                        onClick={() => {
                          if (it.status !== 'new') setEditing({ id: it.id, status: it.status, clear: true });
                        }}
                      >
                        清除原因
                      </button>
                    )}
                    <button
                      className="chip text-xs"
                      style={
                        armed === removeTarget(it.id)
                          ? { borderColor: 'var(--cinnabar)', color: 'var(--cinnabar)' }
                          : { color: 'var(--ink-faint)' }
                      }
                      onClick={() => askRemove(it)}
                      disabled={busy}
                      aria-label={
                        armed === removeTarget(it.id)
                          ? `再次点击确认将${it.title}移出书架`
                          : `将${it.title}移出书架`
                      }
                    >
                      {armed === removeTarget(it.id) ? (removing ? '记录中…' : '确认移除?') : '✕ 移除'}
                    </button>
                  </div>
                  {/* T66：移出书架前的一句话入口，选填；直接点「确认移除」跳过即可。 */}
                  {armed === removeTarget(it.id) && removeDraft?.id === it.id && (
                    <div className="w-full mt-1 border-t border-dashed pt-3" style={{ borderColor: 'var(--line)' }}>
                      {noteSaved?.id === it.id ? (
                        // 原因已经落库，只剩删除没成功。这里不再给编辑入口：
                        // 改了字就得再 POST 一次，而版本号已经对不上，只会卡在 409。
                        <p className="text-xs" style={{ color: 'var(--moss)' }}>原因已记下，重试只补「移出」这一步。</p>
                      ) : (
                        <>
                          <label className="block text-xs" style={{ color: 'var(--ink-soft)' }}>
                            移出前记一句（选填，帮「找书」更准）
                            <textarea
                              className="paper-input mt-1.5 w-full text-sm leading-6 resize-y"
                              rows={2}
                              value={removeDraft.text}
                              onChange={(event) => setRemoveDraft({ id: it.id, text: event.target.value })}
                              maxLength={MAX_FEEDBACK_NOTE_LENGTH}
                              placeholder="为什么不留了？"
                            />
                          </label>
                          <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>不填也可以，点「确认移除」即可。</p>
                        </>
                      )}
                    </div>
                  )}
                  {editing?.id === it.id && (
                    <FeedbackForm
                      key={`${it.id}-${editing.clear ? 'clear' : 'edit'}`}
                      title={it.title} author={it.author} status={editing.status}
                      initialSnapshot={{ version: it.feedback_id ?? 0, note: it.note, status: it.status === 'new' ? null : it.status }}
                      clearInitially={editing.clear}
                      onBusyChange={setUpdating}
                      onSaved={(note, profileStatus) => {
                        if (!isCurrentSession(sessionId)) return;
                        setItems((current) => current?.map((entry) => entry.id === it.id ? { ...entry, status: editing.status, note } : entry) ?? null);
                        setEditing(null);
                        setFeedbackMessage(`「${it.title}」反馈已记录${feedbackProfileUpdateMessage(profileStatus)}`);
                        void load();
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  )}
                </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

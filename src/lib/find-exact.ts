/**
 * 精确找书（按书名直搜，task-77）的纯逻辑：模式切换、结果状态机、响应解析与文案选择。
 *
 * 为什么单独成模块：本仓 vitest 只收 *.test.ts 且没有 jsdom（find-progress.ts / shelf-view
 * 同款理由）。FindTab 里只留 JSX 与 fetch 编排，状态判定全部走这里，才能在 node 里直接测。
 *
 * 关键区分（写死在下面三条文案里，不要合并）：
 *   - 豆瓣**查过但没有这本书** → 未收录，网文常态，不代表书不存在；
 *   - 豆瓣**没查成**（不可达/超时）→ 本轮没查，更不能说成「没这本书」；
 *   - 本地书库命中 → 直接可读，不再打豆瓣。
 */
import { isRecord } from '@/lib/sanitize';

/** 找书页的两个模式。默认仍是口味推荐——不改变现有用户习惯。 */
export type FindMode = 'taste' | 'exact';

export type ExactSource = 'library' | 'douban' | 'none';

/** 精确找书的一条结果。library 来自本地 books 表，douban 来自 subject_suggest。 */
export interface ExactBook {
  title: string;
  author: string;
  source: 'library' | 'douban';
  doubanId?: string;
  doubanUrl?: string;
  rating?: number | null;
  ratingCount?: number | null;
  category?: string;
  wordCount?: string;
  /** 本地命中时：这本书是否已在本用户的书架上（决定「加入书架」按钮的初始态）。 */
  onShelf?: boolean;
}

export interface ExactResponse {
  source: ExactSource;
  items: ExactBook[];
  note?: string;
  /** 豆瓣不可达/超时（区别于「豆瓣查过，没有条目」）。绝不能静默当成「没这本书」。 */
  unavailable?: boolean;
}

export const EXACT_DOUBAN_MISS_NOTE = '豆瓣未收录这本书。未出版的网文常常没有条目，这不代表书不存在。';
export const EXACT_UNAVAILABLE_NOTE = '豆瓣接口暂不可达，本轮没查成——这不代表书不存在。稍后可以重试。';
export const EXACT_LIBRARY_NOTE = '本地书库命中，可以直接阅读。';
export const EXACT_DOUBAN_NOTE = '以下条目来自豆瓣，同名书可能有多本，请按作者挑。';

/* ---------- 模式切换 ---------- */

/** 模式取反。抽出来是为了让「点 tab 会切模式」这条行为可测。 */
export function toggleMode(mode: FindMode): FindMode {
  return mode === 'taste' ? 'exact' : 'taste';
}

/* ---------- 结果状态机 ---------- */

export type ExactPhase = 'idle' | 'searching' | 'done' | 'error';

export interface ExactState {
  phase: ExactPhase;
  /** 本次实际提交的书名。空结果时的「换口味推荐」出路要用它，而不是输入框当前的值。 */
  title: string;
  result: ExactResponse | null;
  error: string;
}

export const EMPTY_EXACT_STATE: ExactState = { phase: 'idle', title: '', result: null, error: '' };

export type ExactEvent =
  | { type: 'submit'; title: string }
  | { type: 'settle'; result: ExactResponse }
  | { type: 'fail'; message: string };

/**
 * submit 时清掉上一次的 result：否则加载中会继续显示上一本书的结果，
 * 用户会以为新搜索秒回且结果没变。settle/fail 都是终态，都保留本次提交的书名。
 */
export function exactReducer(state: ExactState, event: ExactEvent): ExactState {
  switch (event.type) {
    case 'submit':
      return { phase: 'searching', title: event.title, result: null, error: '' };
    case 'settle':
      return { ...state, phase: 'done', result: event.result, error: '' };
    case 'fail':
      return { ...state, phase: 'error', result: null, error: event.message };
    default:
      return state;
  }
}

/** 搜索按钮是否可点：搜索中不可重入，空标题不发请求。 */
export function canSubmitExact(phase: ExactPhase, title: string): boolean {
  return phase !== 'searching' && title.trim().length > 0;
}

/** 空结果提示只在「搜完了且一条都没有」时出现，错误态由 error 文案负责。 */
export function showExactEmpty(state: ExactState): boolean {
  return state.phase === 'done' && state.result !== null && state.result.items.length === 0;
}

/* ---------- 客户端文案 ---------- */

/** 结果区顶部的一行说明；服务端 note 优先（它知道这次到底发生了什么）。 */
export function exactResultNote(result: ExactResponse): string {
  if (result.note) return result.note;
  if (result.source === 'library') return EXACT_LIBRARY_NOTE;
  if (result.source === 'douban') return EXACT_DOUBAN_NOTE;
  return result.unavailable ? EXACT_UNAVAILABLE_NOTE : EXACT_DOUBAN_MISS_NOTE;
}

/** 空结果文案。不可达与未收录必须分开说——前者不是「没这本书」。 */
export function exactEmptyMessage(result: ExactResponse): string {
  return result.unavailable ? EXACT_UNAVAILABLE_NOTE : EXACT_DOUBAN_MISS_NOTE;
}

/* ---------- 请求编排（纯函数部分） ---------- */

/**
 * 客户端侧的响应收窄：网络回来的东西按 unknown 处理，形状不对就当成「没查成」，
 * 而不是渲染出半条结果或谎报「没这本书」。
 */
export function parseExactResponse(payload: unknown): ExactResponse {
  if (!isRecord(payload)) return { source: 'none', items: [], unavailable: true, note: EXACT_UNAVAILABLE_NOTE };
  const items = Array.isArray(payload.items) ? payload.items.flatMap(toExactBook) : [];
  const declared = payload.source;
  const source: ExactSource =
    declared === 'library' || declared === 'douban' || declared === 'none'
      ? declared
      : items.length > 0 ? 'douban' : 'none';
  return {
    source,
    items,
    ...(typeof payload.note === 'string' && payload.note ? { note: payload.note } : {}),
    ...(payload.unavailable === true ? { unavailable: true } : {}),
  };
}

function toExactBook(value: unknown): ExactBook[] {
  if (!isRecord(value)) return [];
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title) return [];
  return [{
    title,
    author: typeof value.author === 'string' ? value.author.trim() : '',
    source: value.source === 'library' ? 'library' : 'douban',
    ...(typeof value.doubanId === 'string' && value.doubanId ? { doubanId: value.doubanId } : {}),
    ...(typeof value.doubanUrl === 'string' && value.doubanUrl ? { doubanUrl: value.doubanUrl } : {}),
    rating: typeof value.rating === 'number' && Number.isFinite(value.rating) ? value.rating : null,
    ratingCount: typeof value.ratingCount === 'number' && Number.isInteger(value.ratingCount)
      ? value.ratingCount : null,
    ...(typeof value.category === 'string' && value.category ? { category: value.category } : {}),
    ...(typeof value.wordCount === 'string' && value.wordCount ? { wordCount: value.wordCount } : {}),
    ...(value.onShelf === true ? { onShelf: true } : {}),
  }];
}

/**
 * 豆瓣找不到时的出路：把书名包成一句**口味描述**再走口味推荐。
 * 裸书名喂给 recall 会被理解成「我喜欢这本」而召回相似书——那正是本模式要避开的行为，
 * 所以这里显式写成「类似《X》的书」，让用户知道自己在问什么。
 */
export function tasteFallbackQuery(title: string): string {
  return `类似《${title.trim()}》的书`;
}

/** 出路句只在真的搜过一本书时给；没搜过就给不出（按钮也就不该出现）。 */
export function exactFallbackQuery(state: ExactState): string | null {
  return state.title.trim() ? tasteFallbackQuery(state.title) : null;
}

/* ---------- 加入书架 ---------- */

export type ShelfPhase = 'idle' | 'saving' | 'saved' | 'error';

/** 409 ALREADY_ON_SHELF 对用户就是「已经在书架里」，不是失败。 */
export function shelfOutcome(status: number): ShelfPhase {
  return status === 200 || status === 409 ? 'saved' : 'error';
}

export function shelfButtonLabel(phase: ShelfPhase): string {
  if (phase === 'saving') return '加入中…';
  if (phase === 'saved') return '✓ 已在书架';
  return '加入书架';
}

/** 已在书架（本地命中带回的 onShelf）不给点，按钮直接是终态。 */
export function initialShelfPhase(onShelf: boolean | undefined): ShelfPhase {
  return onShelf ? 'saved' : 'idle';
}

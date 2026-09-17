/**
 * 「读完了吗」反馈引导的纯逻辑：什么时候该问、问过没有、点返回时要不要接管。
 * 与 find-progress.ts 同款——不依赖 DOM，才能在本仓 node 环境（vitest 无 jsdom）直接测。
 *
 * 本仓没有 jsdom / testing-library，组件级接线测不了。所以「判定 + 要不要记账」这一层
 * 全部收在这里：ReaderClient 的 handleBack 只剩三行搬运，判定逻辑改动才会被测试打到。
 *
 * 这里只决定「入口出不出现」；真正的提交仍然走既有的 FeedbackForm → /api/feedback，
 * 引导链路和回写画像的语义都不在本次改动范围内。
 */

import type { ReaderOrigin } from './reader-types';

export const FEEDBACK_PROMPT_BASE = 'novel-finder-feedback-prompt';

/** 本次至少读到 5% 才算「阅读痕迹」，刚翻开就返回的人不该被拦下来问读后感。 */
export const READ_TRACE_PERCENT = 5;

/**
 * 引导去重键。按 userId 分命名空间：同一浏览器换身份阅读时，
 * 别人的「问过了」不该替这个人做决定（口径同 user-scope.ts 的私人数据）。
 * 书名/作者用 JSON 数组编码，避免「甲·乙」被书名里带的分隔符拼成另一本书的键。
 */
export function feedbackPromptKey(userId: number, title: string, author: string): string {
  return `${FEEDBACK_PROMPT_BASE}-u${userId}-${JSON.stringify([title, author])}`;
}

export interface FeedbackPromptFacts {
  /** 有阅读痕迹：本机存过这本书的进度，或本次已经读够阈值。 */
  read: boolean;
  /** 已有反馈：状态或原因至少填过一个。 */
  hasFeedback: boolean;
  /** 这本书此前已经引导过一次。 */
  prompted: boolean;
}

/**
 * 引导只在「读过、还没说过、也没被问过」时出现，三个条件缺一都回到静默。
 * 宁可漏一次引导，也不能去打扰没读的人，更不能同一本书反复弹。
 */
export function shouldPromptFeedback({ read, hasFeedback, prompted }: FeedbackPromptFacts): boolean {
  return read && !hasFeedback && !prompted;
}

/**
 * 哪些入口该引导：只放行能保证 `books` 有行的会话。
 *
 * 核实（2026-09-17，全仓非测试代码里 INSERT INTO books 只有两处：user-data.ts:52
 * POST /api/shelf、user-data.ts:191 由 /api/find:280 调用）：`books` 与书库的
 * `labeled_books` 是两张表、彼此不同步——/api/library 读的是 labeled_books
 * （library/route.ts:103/107/113）；而 `/api/feedback` 只认 `books`，定位不到就
 * 404 BOOK_NOT_FOUND（db.ts:205-208）。所以「书库的书也在 books 表里」不成立：
 * 从书库直接下载、没跑过 find、也没进书架的书，引导出来也存不下反馈。
 *
 * 判据看 `from` 而不是 `session.kind`：library + taskId 是 download 会话却可能没有
 * books 行，find 是 source 会话却一定有（同一次请求刚落库，user-data.ts:191）——
 * 两者恰好相反，所以会话类型判不出 book 身份。
 *
 * 要让书库的书也能收反馈，得在服务端做（下载时同步 books，或让 feedback 认
 * labeled_books），属 schema/路由语义的改动，不在「只加入口」的范围内。
 */
export function promptableOrigin(from: ReaderOrigin): boolean {
  // 逐入口列出而不是直接比较：三条入口各自为什么放行/排除，看上面的核实结论。
  return from === 'shelf' || from === 'find';
}

/**
 * 阅读痕迹：本机存过这本书的进度（回到开头重看时 percent 为 0），或本次已读够阈值。
 * 阈值是下限而不是刻度——刚点开就返回的人不该被拦下来。
 */
export function hasReadingTrace(percent: number, storedProgress: boolean): boolean {
  return percent >= READ_TRACE_PERCENT || storedProgress;
}

export interface FeedbackPromptDecision {
  /** 是否接管这次返回、展示引导卡。 */
  offer: boolean;
  /** 是否写去重键。与 offer 同进同出：没展示就不该消耗掉这本书唯一的一次引导。 */
  remember: boolean;
}

/**
 * 点「返回」时的完整编排。组件的 handleBack 只负责把结果搬进 state ——
 * 判定与「要不要记账」都在这里，改动会被测试打到。
 *
 * 未登录（userId <= 0）既不展示也不记账：u0 的键会把登录前后的同一个人拆成两次引导，
 * 而在 ReaderClient 里未登录本来就到不了阅读页，这里只是把口径写死。
 */
export function planFeedbackPrompt(facts: FeedbackPromptFacts & { userId: number; from: ReaderOrigin }): FeedbackPromptDecision {
  const offer = facts.userId > 0
    && promptableOrigin(facts.from)
    && shouldPromptFeedback({ read: facts.read, hasFeedback: facts.hasFeedback, prompted: facts.prompted });
  return { offer, remember: offer };
}

/**
 * 反馈快照是否算「已经反馈过」。
 * 快照缺失或读不出来时返回 true：读不到线上状态就不引导，避免在已有反馈的书上再问一次。
 */
export function snapshotHasFeedback(snapshot: { status: unknown; note: unknown } | null): boolean {
  if (!snapshot) return true;
  const { status, note } = snapshot;
  // 形状不认识（status 非 string/null，note 非 string）时同样按「已反馈」处理：
  // 读到的不是我们能解释的快照，就不该据此去问用户。
  if (typeof status !== 'string' && status !== null) return true;
  if (typeof note !== 'string') return true;
  return Boolean(typeof status === 'string' && status.trim() || note.trim());
}

type PromptStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * 存储不可用时返回 true（视作已引导过一次）。
 * 记不住就宁可不引导：否则每次返回都弹同一张卡，正是要避免的弹窗轰炸。
 */
export function hasPromptedFeedback(area: PromptStorage | null, key: string): boolean {
  if (!area) return true;
  try {
    return area.getItem(key) !== null;
  } catch {
    return true;
  }
}

/** 只记时间戳；存不下就下次再说，绝不因为存储失败打断阅读或返回。 */
export function markFeedbackPrompted(area: PromptStorage | null, key: string, at: number): void {
  if (!area) return;
  try {
    area.setItem(key, String(at));
  } catch {
    // 浏览器禁用存储：下次还会问一次，但不影响任何主流程。
  }
}

/** 浏览器禁用存储时按 null 处理，判定处会退回「不引导」。 */
export function promptStorage(): PromptStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

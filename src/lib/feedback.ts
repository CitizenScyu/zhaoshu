import type { FeedbackStatus } from '@/lib/types';

export const FEEDBACK_REASONS = ['节奏慢', '烂尾', '主角不喜欢', '感情线问题', '题材不合'] as const;
export const MAX_FEEDBACK_NOTE_LENGTH = 1_000;

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  want: '想读',
  reading: '在读',
  done: '读完',
  dropped: '弃书',
};

export type FeedbackReason = typeof FEEDBACK_REASONS[number];

export interface FeedbackDraft {
  reasons: FeedbackReason[];
  text: string;
}

export interface FeedbackSnapshot {
  version: number;
  status: FeedbackStatus | null;
  note: string;
}

export function readFeedbackSnapshot(value: unknown): FeedbackSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (!Number.isSafeInteger(data.version) || (data.version as number) < 0 || typeof data.note !== 'string'
    || (data.status !== null && !Object.hasOwn(FEEDBACK_STATUS_LABELS, String(data.status)))) return null;
  return { version: data.version as number, status: data.status as FeedbackStatus | null, note: data.note };
}

export function feedbackNeedsConfirmation(previous: string, next: string): boolean {
  return next.trim().length < previous.trim().length;
}

// F15：反馈是否有信息量——只有「读完/弃书 + 原因」才会给画像补充偏好。与 F04 的
// recentInformativeFeedbackForUserQuery 判定口径一致（status IN (done,dropped) 且 note 非空）。
export function isInformativeFeedback(status: string | null, note: string): boolean {
  return (status === 'done' || status === 'dropped') && note.trim() !== '';
}

// 是否需要登记一条待吸收事件：本次反馈有信息量，或本次把先前有信息量的反馈撤回/改成了
// 无信息量（撤回也要吸收——否则旧偏好会留在画像里）。其余（want/reading、无不含撤回）
// 对画像零影响，返回 false，写路径也就不产生队列事件。
export function feedbackQueuesProfileAbsorption(
  status: string, note: string, previousStatus: string | null, previousNote: string,
): boolean {
  return isInformativeFeedback(status, note) || isInformativeFeedback(previousStatus, previousNote);
}

export function feedbackReductionMessage(previous: string, next: string): string {
  return `反馈原因将从 ${previous.trim().length} 字减少到 ${next.trim().length} 字${next.trim() ? '' : '（清空）'}。\n\n原反馈：${previous}\n\n确认保存？`;
}

export function composeFeedbackNote({ reasons, text }: FeedbackDraft): string {
  const selected = FEEDBACK_REASONS.filter((reason) => reasons.includes(reason));
  return [selected.join('；'), text.trim()].filter(Boolean).join('\n');
}

export function parseFeedbackNote(note: string): FeedbackDraft {
  const [firstLine, ...rest] = note.split(/\r?\n/);
  const reasons = firstLine.split('；');
  // 只识别完整的预设原因行，旧反馈和自由文本原样保留在补充说明中。
  if (reasons.every((reason): reason is FeedbackReason =>
    FEEDBACK_REASONS.includes(reason as FeedbackReason))) {
    return { reasons: [...new Set(reasons)], text: rest.join('\n') };
  }
  return { reasons: [], text: note };
}

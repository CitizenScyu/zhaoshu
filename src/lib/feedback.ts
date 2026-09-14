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

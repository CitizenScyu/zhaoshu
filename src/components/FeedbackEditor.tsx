'use client';

import { useId, useState } from 'react';
import type { FeedbackStatus } from '@/lib/types';
import {
  composeFeedbackNote, FEEDBACK_REASONS, FEEDBACK_STATUS_LABELS,
  MAX_FEEDBACK_NOTE_LENGTH, parseFeedbackNote,
} from '@/lib/feedback';

export default function FeedbackEditor({
  status,
  initialNote = '',
  busy,
  saveDisabled = false,
  clearInitially = false,
  onSubmit,
  onCancel,
}: {
  status: FeedbackStatus;
  initialNote?: string;
  busy: boolean;
  saveDisabled?: boolean;
  clearInitially?: boolean;
  onSubmit: (note: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => parseFeedbackNote(clearInitially ? '' : initialNote));
  const hintId = useId();
  const note = composeFeedbackNote(draft);
  const tooLong = note.length > MAX_FEEDBACK_NOTE_LENGTH;

  return (
    <form
      className="w-full mt-3 border-t border-dashed pt-3"
      style={{ borderColor: 'var(--line)' }}
      aria-label={`${FEEDBACK_STATUS_LABELS[status]}反馈`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !tooLong && !saveDisabled) void onSubmit(note);
      }}
    >
      <fieldset disabled={busy}>
        <legend className="text-xs mb-2" style={{ color: 'var(--ink-soft)' }}>
          标记为「{FEEDBACK_STATUS_LABELS[status]}」· 原因可多选，也可以只更新状态
        </legend>
        <div className="flex flex-wrap gap-2">
          {FEEDBACK_REASONS.map((reason) => {
            const selected = draft.reasons.includes(reason);
            return (
              <button
                key={reason}
                type="button"
                aria-pressed={selected}
                className={`chip cursor-pointer disabled:opacity-50 ${selected ? 'chip-risk' : ''}`}
                onClick={() => setDraft((current) => ({
                  ...current,
                  reasons: current.reasons.includes(reason)
                    ? current.reasons.filter((value) => value !== reason)
                    : [...current.reasons, reason],
                }))}
              >
                {selected && '✓ '}{reason}
              </button>
            );
          })}
        </div>
        <label className="block mt-3 text-xs" style={{ color: 'var(--ink-soft)' }}>
          补充说明（选填）
          <textarea
            className="paper-input mt-1.5 w-full text-sm leading-6 resize-y"
            rows={2}
            value={draft.text}
            onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
            maxLength={MAX_FEEDBACK_NOTE_LENGTH}
            aria-describedby={hintId}
            aria-invalid={tooLong}
            placeholder="还喜欢或介意哪些地方？"
          />
        </label>
        <p
          id={hintId}
          className="mt-1 text-xs"
          aria-live="polite"
          style={{ color: tooLong ? 'var(--cinnabar)' : 'var(--ink-faint)' }}
        >
          原因与补充说明合计 {note.length}/{MAX_FEEDBACK_NOTE_LENGTH} 字{tooLong && '，请精简后再保存'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="chip chip-dai disabled:opacity-50" type="submit" disabled={tooLong || busy || saveDisabled}>
            {busy ? '保存中…' : note ? '记下反馈' : initialNote ? '清除原因' : '只更新状态'}
          </button>
          <button className="chip" type="button" onClick={onCancel} disabled={busy}>取消</button>
        </div>
      </fieldset>
    </form>
  );
}

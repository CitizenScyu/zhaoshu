import { describe, expect, it } from 'vitest';
import { composeFeedbackNote, parseFeedbackNote } from './feedback';

describe('feedback note editing', () => {
  it('round-trips multiple reasons and multiline custom text', () => {
    const draft = { reasons: ['节奏慢', '主角不喜欢'] as const, text: '中段重复铺垫\n结尾还不错' };
    const note = composeFeedbackNote({ ...draft, reasons: [...draft.reasons] });

    expect(note).toBe('节奏慢；主角不喜欢\n中段重复铺垫\n结尾还不错');
    expect(parseFeedbackNote(note)).toEqual(draft);
  });

  it.each([
    '节奏慢，但伏笔收得好\n最后一卷很好',
    '节奏慢；角色成长好',
    '喜欢世界观和群像，没什么雷点',
  ])('preserves legacy free-form feedback: %s', (note) => {
    expect(parseFeedbackNote(note)).toEqual({ reasons: [], text: note });
    expect(composeFeedbackNote(parseFeedbackNote(note))).toBe(note);
  });

  it('allows all reasons and custom text to be cleared to an empty note', () => {
    expect(composeFeedbackNote({ reasons: [], text: ' \n ' })).toBe('');
    expect(parseFeedbackNote('')).toEqual({ reasons: [], text: '' });
  });
});

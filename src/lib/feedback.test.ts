import { describe, expect, it } from 'vitest';
import { composeFeedbackNote, feedbackNeedsConfirmation, feedbackProfileUpdateMessage, feedbackProfileUpdateSentence, parseFeedbackNote, readFeedbackProfileStatus, readFeedbackSnapshot } from './feedback';

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

describe('feedback snapshot contract', () => {
  it('accepts a well-formed online snapshot and rejects malformed ones', () => {
    expect(readFeedbackSnapshot({ version: 4, status: 'want', note: '说明' })).toEqual({ version: 4, status: 'want', note: '说明' });
    expect(readFeedbackSnapshot({ version: 4, status: null, note: '' })).toEqual({ version: 4, status: null, note: '' });
    expect(readFeedbackSnapshot({ version: -1, status: 'want', note: '' })).toBeNull();
    expect(readFeedbackSnapshot({ version: 1, status: 'bogus', note: '' })).toBeNull();
    expect(readFeedbackSnapshot(null)).toBeNull();
  });

  // MS-32b:原型链污染对照。快照 status 走 hasOwnProperty 判定,
  // 'constructor'/'toString' 这类原型链上的键不是合法状态,不得借道通过。
  it('rejects statuses that only exist on the prototype chain', () => {
    expect(readFeedbackSnapshot({ version: 4, status: 'constructor', note: '' })).toBeNull();
    expect(readFeedbackSnapshot({ version: 4, status: 'toString', note: '' })).toBeNull();
  });

  it('detects destructive note reductions so the client can confirm before saving', () => {
    expect(feedbackNeedsConfirmation('长反馈', '')).toBe(true);
    expect(feedbackNeedsConfirmation('短', '长一点的反馈')).toBe(false);
  });
});

// F15：异步吸收后用户侧文案必须能区分「反馈已保存、画像待更新」与「无需修改画像」。
// （组件测试需要 jsdom，本仓 vitest 是 node 环境，所以文案逻辑抽成纯函数在这里断言。）
describe('feedback saved profile-status messaging (F15)', () => {
  it('maps only the explicit pending status to pending, everything else to unchanged', () => {
    expect(readFeedbackProfileStatus('pending')).toBe('pending');
    expect(readFeedbackProfileStatus('unchanged')).toBe('unchanged');
    // 旧/缺失/非法值一律按 unchanged 处理（不误报"待更新"）。
    expect(readFeedbackProfileStatus(undefined)).toBe('unchanged');
    expect(readFeedbackProfileStatus(false)).toBe('unchanged');
    expect(readFeedbackProfileStatus('failed')).toBe('unchanged');
  });

  it('never promises the profile was updated while absorption is still pending', () => {
    expect(feedbackProfileUpdateMessage('pending')).toBe('，画像待更新');
    expect(feedbackProfileUpdateMessage('unchanged')).toBe('');
    expect(feedbackProfileUpdateSentence('pending')).toBe('口味画像待更新。');
    expect(feedbackProfileUpdateSentence('unchanged')).toBe('');
    // 关键不变量：任何状态都不会出现「已更新」的承诺。
    for (const status of ['pending', 'unchanged'] as const) {
      expect(feedbackProfileUpdateMessage(status)).not.toContain('已更新');
      expect(feedbackProfileUpdateSentence(status)).not.toContain('已更新');
    }
  });
});

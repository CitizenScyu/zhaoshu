import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { composeFeedbackNote, MAX_FEEDBACK_NOTE_LENGTH } from '@/lib/feedback';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  getProfileForUser: vi.fn(),
  saveProfileForUser: vi.fn(),
  getFeedbackSnapshotForUser: vi.fn(),
  chatRobust: vi.fn(),
  // 事务批次的原始返回：默认空数组表示"测试不关心每条语句的影响行数"。
  writeResults: [] as unknown[],
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'), values,
  })),
  transaction: vi.fn(),
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/db')>(),
  recordFeedbackForUser: async (userId: number, book: { title: string; author: string }, status: string, note: string, expectedVersion: number) => {
    const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
    await actual.recordFeedbackForUser(userId, book, status, note, expectedVersion, async (batch) => {
      await mocks.transaction(batch(mocks.sql as never));
      return mocks.writeResults as Record<string, unknown>[][];
    });
  },
  ensureSchema: mocks.ensureSchema,
  getSql: mocks.getSql,
  getProfileForUser: mocks.getProfileForUser,
  saveProfileForUser: mocks.saveProfileForUser,
  getFeedbackSnapshotForUser: mocks.getFeedbackSnapshotForUser,
}));
vi.mock('@/lib/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/llm')>(),
  chatRobust: async (...args: unknown[]) => ({ content: await mocks.chatRobust(...args) }),
}));

import { LlmError } from '@/lib/llm';
import { POST } from './route';

const previousVersion = '2026-09-15 00:00:00.123456+00';
const nextVersion = '2026-09-15 00:00:00.123457+00';

function request(status: string, note: string) {
  return new NextRequest('http://localhost/api/feedback', {
    method: 'POST',
    headers: { Authorization: 'Bearer feedback-test-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '测试书', author: '作者', status, note }),
  });
}

describe('POST /api/feedback note contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APP_OWNER_TOKEN', 'feedback-test-owner');
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.getSql.mockReturnValue(Object.assign(mocks.sql, { transaction: mocks.transaction }));
    mocks.transaction.mockResolvedValue([]);
    mocks.writeResults = [];
    // 每本书默认还没有反馈：CAS 期望版本 0 与读到的快照一致。
    mocks.getFeedbackSnapshotForUser.mockResolvedValue({ version: 0, status: null, note: '' });
    mocks.getProfileForUser.mockResolvedValue({ seeds: [], content: '原画像', updatedAt: previousVersion });
    mocks.chatRobust.mockResolvedValue('更新后的画像');
    mocks.saveProfileForUser.mockResolvedValue(nextVersion);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('saves combined reasons and custom text through the existing profile feedback loop', async () => {
    const note = composeFeedbackNote({ reasons: ['节奏慢', '感情线问题'], text: '后期剧情重复' });

    const res = await POST(request('dropped', note));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, profileUpdated: true, updatedAt: nextVersion });
    const insert = mocks.sql.mock.results.find((result) => result.value.text.includes('INSERT INTO feedback'));
    expect(insert?.value.values).toEqual([1, 'dropped', note, '测试书', '作者']);
    expect(mocks.chatRobust.mock.calls[0][1]).toContain(JSON.stringify({
      title: '测试书', author: '作者', status: 'dropped', note,
    }));
    expect(mocks.saveProfileForUser).toHaveBeenCalledWith(1, [], '更新后的画像', previousVersion, expect.any(Function));
  });

  it('reports profileUpdated false when the model returns the profile byte-for-byte unchanged', async () => {
    // 生产实测：模型对回写提示词原样返回输入画像，CAS 仍然命中。
    mocks.chatRobust.mockResolvedValue('原画像');
    mocks.saveProfileForUser.mockResolvedValue(previousVersion); // 内容没变，版本号不推进

    const res = await POST(request('dropped', '题材不合'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, profileUpdated: false, updatedAt: previousVersion });
    expect(mocks.saveProfileForUser).toHaveBeenCalledWith(1, [], '原画像', previousVersion, expect.any(Function));
  });

  it('fails explicitly with BOOK_NOT_FOUND instead of reporting a save that wrote nothing', async () => {
    // 6 条语句：索引 0 是 route B 补 books 行的 upsert，第 5 条（索引 4）
    // INSERT ... RETURNING id 表示按 title/author 定位后追加历史。
    // 仍定位不到这本书时它是 0 行——旧行为是 200 + "保存成功"。
    mocks.writeResults = [
      [], [{ id: 1 }], [{ id: 1 }], [{ feedback_version_matches: 1 }], [], [],
    ];

    const res = await POST(request('dropped', '题材不合'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '这本书不在书库中，未能保存反馈。', code: 'BOOK_NOT_FOUND' });
    expect(mocks.chatRobust).not.toHaveBeenCalled();
  });

  it('still records feedback when the INSERT really appended a row', async () => {
    mocks.writeResults = [
      [], [{ id: 1 }], [{ id: 1 }], [{ feedback_version_matches: 1 }], [{ id: 7 }], [],
    ];

    const res = await POST(request('dropped', '题材不合'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, profileUpdated: true, updatedAt: nextVersion });
  });

  it('logs the failing stage and error class instead of swallowing the reason', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.chatRobust.mockRejectedValue(new LlmError('长度截断', false));

    expect((await POST(request('dropped', '节奏拖沓'))).status).toBe(200);

    expect(logged).toHaveBeenCalledWith('反馈回写画像失败，反馈本身已保存',
      { stage: 'model', name: 'LlmError', code: null });
  });

  it.each(['done', 'dropped'])('records an empty note for %s while retaining the status and profile', async (status) => {
    const res = await POST(request(status, ''));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, profileUpdated: false });
    const queries = mocks.sql.mock.results.map((result) => result.value);
    expect(queries.find((query) => query.text.includes('INSERT INTO feedback'))?.values).toEqual([1, status, '', '测试书', '作者']);
    expect(queries.find((query) => query.text.includes('UPDATE recommendations'))?.values).toEqual([status, 1, '测试书', '作者']);
    expect(queries.find((query) => query.text.includes('UPDATE recommendations'))?.text).toMatch(/WHERE user_id = \? AND book_id IN/);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.getProfileForUser).not.toHaveBeenCalled();
    expect(mocks.chatRobust).not.toHaveBeenCalled();
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
  });

  it('accepts a combined note at the shared 1000-character limit', async () => {
    const prefix = composeFeedbackNote({ reasons: ['节奏慢'], text: '' });
    const note = composeFeedbackNote({
      reasons: ['节奏慢'], text: '字'.repeat(MAX_FEEDBACK_NOTE_LENGTH - prefix.length - 1),
    });

    expect(note).toHaveLength(MAX_FEEDBACK_NOTE_LENGTH);
    expect((await POST(request('reading', note))).status).toBe(200);
  });

  it('rejects an oversized combined note before writing feedback', async () => {
    const note = composeFeedbackNote({ reasons: ['节奏慢'], text: '字'.repeat(MAX_FEEDBACK_NOTE_LENGTH) });

    const res = await POST(request('dropped', note));

    expect(res.status).toBe(400);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.chatRobust).not.toHaveBeenCalled();
  });

  it.each(['', ' \n ', null, false, '字'.repeat(5_001), 'bad' + String.fromCharCode(0), '\ud800'])(
    'retains feedback without saving invalid model profile %#', async (updated) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks.chatRobust.mockResolvedValue(updated);
      const res = await POST(request('done', '喜欢严谨设定'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, profileUpdated: false });
      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    },
  );

  it.each(['长度截断', '上游错误', '坏 SSE 事件', '无终止标记 EOF', '调用已取消'])(
    'does not save a profile after %s', async (message) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks.chatRobust.mockRejectedValue(new LlmError(message, false));
      const res = await POST(request('dropped', '节奏拖沓'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, profileUpdated: false });
      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    },
  );

  it('does not save if the request was cancelled as the model returned', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new AbortController();
    const req = new NextRequest(request('done', '喜欢设定'), { signal: controller.signal });
    mocks.chatRobust.mockImplementation(async () => {
      controller.abort();
      return '更新后的画像';
    });
    const res = await POST(req);
    expect(await res.json()).toEqual({ ok: true, profileUpdated: false });
    expect(mocks.chatRobust.mock.calls[0][2].signal.aborted).toBe(true);
    expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
  });

  it('keeps the recorded feedback when another writer wins and never retries the model', async () => {
    mocks.saveProfileForUser.mockResolvedValue(null);
    const res = await POST(request('done', '喜欢严谨设定'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, profileUpdated: false });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.saveProfileForUser).toHaveBeenCalledExactlyOnceWith(1, [], '更新后的画像', previousVersion, expect.any(Function));
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
  });

  it('stops the profile rewrite and still saves feedback when the budget expires before reading the profile', async () => {
    vi.useFakeTimers();
    try {
      let began!: () => void;
      const reading = new Promise<void>((resolve) => { began = resolve; });
      mocks.getProfileForUser.mockImplementation(() => { began(); return new Promise(() => {}); });
      const pending = POST(request('done', '喜欢严谨设定'));
      await reading; // 明确反馈已经提交，再消耗画像读取预算。
      await vi.advanceTimersByTimeAsync(285_000); // expire the budget
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, profileUpdated: false });
      expect(mocks.transaction).toHaveBeenCalledOnce(); // feedback still committed
      expect(mocks.chatRobust).not.toHaveBeenCalled();
      expect(mocks.saveProfileForUser).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // 同 find：ceiling 就是 chatRobust 的总时限，220s 对推理模型的长思考流太紧。
  it('hands the profile write-back the full 260s ceiling, not the old 220s', async () => {
    const res = await POST(request('done', '喜欢严谨设定'));
    expect(res.status).toBe(200);
    expect(mocks.chatRobust).toHaveBeenCalledOnce();
    const { totalTimeoutMs } = mocks.chatRobust.mock.calls[0][2];
    expect(totalTimeoutMs).toBe(260_000);
    expect(totalTimeoutMs).toBeGreaterThan(220_000);
    expect(totalTimeoutMs + 12_000).toBeLessThan(295_000);
  });
});

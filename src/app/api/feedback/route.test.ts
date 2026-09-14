import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { composeFeedbackNote, MAX_FEEDBACK_NOTE_LENGTH } from '@/lib/feedback';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  getSql: vi.fn(),
  upsertBook: vi.fn(),
  getProfile: vi.fn(),
  saveProfile: vi.fn(),
  chatRobust: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'), values,
  })),
  transaction: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  ensureSchema: mocks.ensureSchema,
  getSql: mocks.getSql,
  upsertBook: mocks.upsertBook,
  getProfile: mocks.getProfile,
  saveProfile: mocks.saveProfile,
}));
vi.mock('@/lib/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/llm')>(),
  chatRobust: mocks.chatRobust,
}));

import { LlmError } from '@/lib/llm';
import { POST } from './route';

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
    mocks.upsertBook.mockResolvedValue(42);
    mocks.transaction.mockResolvedValue([]);
    mocks.getProfile.mockResolvedValue({ seeds: [], content: '原画像', updatedAt: 'previous-version' });
    mocks.chatRobust.mockResolvedValue('更新后的画像');
    mocks.saveProfile.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('saves combined reasons and custom text through the existing profile feedback loop', async () => {
    const note = composeFeedbackNote({ reasons: ['节奏慢', '感情线问题'], text: '后期剧情重复' });

    const res = await POST(request('dropped', note));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, profileUpdated: true });
    const insert = mocks.sql.mock.results.find((result) => result.value.text.includes('INSERT INTO feedback'));
    expect(insert?.value.values).toEqual([42, 'dropped', note]);
    expect(mocks.chatRobust.mock.calls[0][1]).toContain(JSON.stringify({
      title: '测试书', author: '作者', status: 'dropped', note,
    }));
    expect(mocks.saveProfile).toHaveBeenCalledWith([], '更新后的画像', 'previous-version');
  });

  it.each(['done', 'dropped'])('records an empty note for %s while retaining the status and profile', async (status) => {
    const res = await POST(request(status, ''));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, profileUpdated: false });
    const queries = mocks.sql.mock.results.map((result) => result.value);
    expect(queries.find((query) => query.text.includes('INSERT INTO feedback'))?.values).toEqual([42, status, '']);
    expect(queries.find((query) => query.text.includes('UPDATE recommendations'))?.values).toEqual([status, 42]);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.getProfile).not.toHaveBeenCalled();
    expect(mocks.chatRobust).not.toHaveBeenCalled();
    expect(mocks.saveProfile).not.toHaveBeenCalled();
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
      expect(mocks.saveProfile).not.toHaveBeenCalled();
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
      expect(mocks.saveProfile).not.toHaveBeenCalled();
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
    expect(mocks.saveProfile).not.toHaveBeenCalled();
  });
});

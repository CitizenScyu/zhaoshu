import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Query = { text: string; values: unknown[]; then: Promise<unknown>['then'] };
const mocks = vi.hoisted(() => ({ getSql: vi.fn(), ensureSchema: vi.fn(), upsertBook: vi.fn(), getProfile: vi.fn(), saveProfile: vi.fn(), transaction: vi.fn() }));
vi.mock('./db', () => mocks);
vi.mock('./llm', async (original) => ({ ...await original<typeof import('./llm')>(), chatRobust: vi.fn() }));
import { appendFeedback, FeedbackConflictError, getFeedbackSnapshot } from './feedback-store';
import { feedbackNeedsConfirmation, readFeedbackSnapshot } from './feedback';
import { GET, POST } from '@/app/api/feedback/route';

let current: { id: number; note: string; status: string } | null;
let queries: Query[];
let competingWrite: boolean;
function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/feedback', { method: 'POST',
    headers: { Authorization: 'Bearer feedback-cas-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '书', author: '作者', status: 'reading', ...body }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_OWNER_TOKEN', 'feedback-cas-owner');
  queries = []; current = { id: 4, note: '已经保存的长反馈', status: 'want' }; competingWrite = false;
  mocks.upsertBook.mockResolvedValue(42);
  const sql = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?').replace(/\s+/g, ' ').trim();
    const result = { text, values, then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(current ? [{ ...current }] : [])) } as Query;
    queries.push(result);
    return result;
  };
  mocks.transaction.mockImplementation(async (batch: Query[]) => {
    const guard = batch.find((query) => query.text.includes('feedback_version_matches'))!;
    if (competingWrite) { current = { id: 5, note: '另一个页面的新反馈', status: 'done' }; competingWrite = false; }
    if ((current?.id ?? 0) !== guard.values[1]) throw Object.assign(new Error('stale'), { code: '22012' });
    const insert = batch.find((query) => query.text.startsWith('INSERT INTO feedback'))!;
    current = { id: (current?.id ?? 0) + 1, status: insert.values[1] as string, note: insert.values[2] as string };
    return [];
  });
  mocks.getSql.mockReturnValue(Object.assign(sql, { transaction: mocks.transaction }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('feedback snapshot and append-only concurrency guard', () => {
  it('returns the latest feedback id, note, and status as a versioned snapshot', async () => {
    expect(await getFeedbackSnapshot('书', '作者')).toEqual({ version: 4, note: '已经保存的长反馈', status: 'want' });
    expect(queries[0].text).toContain('f.user_id = 1');
    expect(queries[0].text).toContain('ORDER BY f.id DESC');
    current = null;
    expect(await getFeedbackSnapshot('书', '作者')).toEqual({ version: 0, note: '', status: null });
  });

  it('locks the book, compares the latest version, appends audit history, and changes status in one transaction', async () => {
    await appendFeedback(42, 'reading', '新反馈', 4, new AbortController().signal);
    const batch = mocks.transaction.mock.calls[0][0] as Query[];
    expect(batch.findIndex((query) => query.text.endsWith('FOR UPDATE'))).toBeLessThan(batch.findIndex((query) => query.text.includes('feedback_version_matches')));
    expect(batch.find((query) => query.text.startsWith('UPDATE recommendations'))?.text).toContain('user_id = 1');
    expect(batch.some((query) => /DELETE|UPDATE feedback/.test(query.text))).toBe(false);
    expect(mocks.transaction.mock.calls[0][1].isolationLevel).toBe('ReadCommitted');
  });

  it('maps a lost comparison to an explicit conflict rather than retrying an overwrite', async () => {
    await expect(appendFeedback(42, 'reading', '', 3, new AbortController().signal)).rejects.toBeInstanceOf(FeedbackConflictError);
    expect(current?.note).toBe('已经保存的长反馈');
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it('rejects an old or absent client version before writing', async () => {
    for (const body of [{ expectedFeedbackId: 3, note: '' }, { note: '' }]) {
      const res = await POST(request(body));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'FEEDBACK_CONFLICT', current: { version: 4, note: current!.note } });
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('inherits the old note for a status-only update', async () => {
    const previousNote = current!.note;
    expect((await POST(request({ expectedFeedbackId: 4 }))).status).toBe(200);
    expect(current).toMatchObject({ note: previousNote, status: 'reading' });
  });

  it('requires confirmation to shorten or clear a note', async () => {
    const res = await POST(request({ note: '', expectedFeedbackId: 4 }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('FEEDBACK_CONFIRM_REQUIRED');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect((await POST(request({ note: '', expectedFeedbackId: 4, confirmNoteReduction: true }))).status).toBe(200);
    expect(current?.note).toBe('');
  });

  it('returns the new online snapshot when another write wins after the initial read', async () => {
    competingWrite = true;
    const res = await POST(request({ note: '我的草稿长反馈', expectedFeedbackId: 4, confirmNoteReduction: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'FEEDBACK_CONFLICT', current: { version: 5, note: '另一个页面的新反馈' } });
    expect(current?.note).toBe('另一个页面的新反馈');
  });

  it('protects first creation (version 0) with the same CAS guard', async () => {
    current = null; competingWrite = true;
    const res = await POST(request({ note: '新反馈', expectedFeedbackId: 0 }));
    expect(res.status).toBe(409);
    expect(current).toMatchObject({ note: '另一个页面的新反馈' });
  });

  it.each([-1, '4', 0.5, null, false])('rejects malformed feedback versions: %j', async (expectedFeedbackId) => {
    expect((await POST(request({ note: '说明', expectedFeedbackId }))).status).toBe(400);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
  });

  it('exposes a private read endpoint for FindTab to start from the latest note', async () => {
    const res = await GET(new NextRequest('http://localhost/api/feedback?title=书&author=作者', { headers: { Authorization: 'Bearer feedback-cas-owner' } }));
    expect(await res.json()).toMatchObject({ current: { version: 4, note: current!.note } });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Authorization, X-Owner-Token');
  });

  it('validates snapshots and detects destructive note reductions', () => {
    expect(readFeedbackSnapshot({ version: 4, status: 'want', note: '说明' })).toEqual({ version: 4, status: 'want', note: '说明' });
    expect(readFeedbackSnapshot({ version: -1, status: 'want', note: '' })).toBeNull();
    expect(readFeedbackSnapshot({ version: 1, status: 'bogus', note: '' })).toBeNull();
    expect(feedbackNeedsConfirmation('长反馈', '')).toBe(true);
    expect(feedbackNeedsConfirmation('短', '长一点的反馈')).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { ensureSchema, getSql, runAdmissionRound } = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getSql: vi.fn(), runAdmissionRound: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ ensureSchema, getSql }));
// 开关解析用真实现（admissionOwnCronEnabled），只把整轮准入换成桩：批次本身在 shuyuan.admission-round.test.ts 验。
vi.mock('@/lib/shuyuan', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/shuyuan')>(), runAdmissionRound,
}));

import { GET, maxDuration } from './route';
import { ADMISSION_ROUND_BUDGET_MS } from '@/lib/shuyuan';

const SECRET = 'shuyuan-admission-test-secret';
const fetchMock = vi.fn<typeof fetch>();

function request(secret?: string) {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
  return new NextRequest('http://localhost/api/shuyuan/admission', { headers });
}

function expectNothingTouched() {
  expect(ensureSchema).not.toHaveBeenCalled();
  expect(getSql).not.toHaveBeenCalled();
  expect(runAdmissionRound).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
}

describe('GET /api/shuyuan/admission（42-admbudget 独立准入轮）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ensureSchema.mockResolvedValue(undefined);
    getSql.mockImplementation(() => { throw new Error('route touched database'); });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('maxDuration 足以容纳整份准入预算', () => {
    expect(maxDuration).toBe(295);
    expect(ADMISSION_ROUND_BUDGET_MS).toBeLessThan(maxDuration * 1000);
  });

  it('未配置 CRON_SECRET 时 fail closed（开关开也一样）', async () => {
    vi.stubEnv('ADMISSION_OWN_CRON', '1');
    const res = await GET(request('anything'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', code: 'FORBIDDEN' });
    expectNothingTouched();
  });

  it.each([
    ['错误 secret', 'wrong-secret'],
    ['缺 Authorization 头', undefined],
    ['同长度错误 secret', 'x'.repeat(SECRET.length)],
  ])('%s ⇒ 403，不触达数据库与网络', async (_label, secret) => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('ADMISSION_OWN_CRON', '1');
    const res = await GET(request(secret));
    expect(res.status).toBe(403);
    expectNothingTouched();
  });

  it('非 Bearer 方案即便值正确也拒', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('ADMISSION_OWN_CRON', '1');
    const res = await GET(new NextRequest('http://localhost/api/shuyuan/admission', { headers: { Authorization: SECRET } }));
    expect(res.status).toBe(403);
    expectNothingTouched();
  });

  it.each([undefined, '0', 'false'])('开关关（ADMISSION_OWN_CRON=%s）：鉴权通过后空转返回，不碰库、不探', async (flag) => {
    vi.stubEnv('CRON_SECRET', SECRET);
    if (flag !== undefined) vi.stubEnv('ADMISSION_OWN_CRON', flag);
    const res = await GET(request(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: 'disabled' });
    expectNothingTouched();
  });

  it('开关开：ensureSchema 后跑一整轮，响应即计数摘要', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('ADMISSION_OWN_CRON', '1');
    const summary = {
      sources: 1780, candidates: 646, surveyRejectedExisting: 1, compileOk: 472, compileRejected: 175, probed: 60, written: 60,
    };
    runAdmissionRound.mockResolvedValue(summary);
    const req = request(SECRET);
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(ensureSchema).toHaveBeenCalledTimes(1);
    expect(runAdmissionRound).toHaveBeenCalledTimes(1);
    expect(runAdmissionRound.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it('租约被占：透传 skipped:lease（200，不当失败）', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('ADMISSION_OWN_CRON', '1');
    runAdmissionRound.mockResolvedValue({ skipped: 'lease' });
    const res = await GET(request(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: 'lease' });
  });

  it('整轮抛错 ⇒ 502 固定文案，不回显上游 URL', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('ADMISSION_OWN_CRON', '1');
    runAdmissionRound.mockRejectedValue(new Error('fetch https://upstream.example/secret-path failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(request(SECRET));
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: '准入轮失败', code: 'ADMISSION_FAILED' });
    expect(body).not.toContain('upstream.example');
  });
});

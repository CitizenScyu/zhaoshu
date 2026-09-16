import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockSql } from '@/lib/fixtures/mock-sql';

const mocks = vi.hoisted(() => ({
  getSql: vi.fn(),
  ensureSchema: vi.fn(),
  probeModel: vi.fn(),
  resetModelCache: vi.fn(),
  findSessionByToken: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ getSql: mocks.getSql, ensureSchema: mocks.ensureSchema }));
// 探针替身：保存前验证的调用顺序与"不通过不写库"由本文件断言；探针自身行为由
// src/lib/llm-model.test.ts 覆盖。
vi.mock('@/lib/llm', () => ({ probeModel: mocks.probeModel, resetModelCache: mocks.resetModelCache }));
vi.mock('@/lib/auth-session', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth-session')>(),
  findSessionByToken: mocks.findSessionByToken,
}));

import { GET, PATCH } from './route';

const OWNER_TOKEN = 'admin-llm-owner-token';
const MEMBER_SESSION = 'nf-dev-session=member-session-token';

let db: ReturnType<typeof mockSql>;

function req(
  method: 'GET' | 'PATCH',
  options: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): NextRequest {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? OWNER_TOKEN}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  return new NextRequest('http://localhost/api/admin/llm', {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

// 只统计写 app_settings 的语句；读库查询不参与"写没写库"的判定。
const settingWrites = () =>
  db.queries.filter((query) => query.text.includes('app_settings') && /\b(INSERT|UPDATE)\b/.test(query.text));

function memberRecord() {
  return {
    userId: 7, username: 'member', role: 'member',
    canFind: true, canRead: true, canDownload: true,
    authMethod: 'password', ownerCredentialTag: null, membersEnabled: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('APP_OWNER_TOKEN', OWNER_TOKEN);
  db = mockSql();
  mocks.getSql.mockReturnValue(db.sql);
  mocks.ensureSchema.mockResolvedValue(undefined);
  mocks.probeModel.mockResolvedValue({ ok: true, reasoning: false, reason: '', warning: '' });
  db.resolve.mockResolvedValue([{ llm_model: null, updated_at: null }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/admin/llm', () => {
  it('匿名 → 401，且在鉴权前不碰数据库', async () => {
    const res = await GET(req('GET', { token: null }));
    expect(res.status).toBe(401);
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
  });

  it('口令错误 → 401', async () => {
    expect((await GET(req('GET', { token: 'wrong' }))).status).toBe(401);
  });

  it('成员会话 → 403（owner 专用）', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    mocks.findSessionByToken.mockResolvedValue(memberRecord());
    const res = await GET(req('GET', { token: null, headers: { cookie: MEMBER_SESSION } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('owner 读到数据库覆盖值，并带上来源与更新时间', async () => {
    db.resolve.mockResolvedValue([{ llm_model: 'vendor/model', updated_at: '2026-09-16T10:00:00.000Z' }]);
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      model: 'vendor/model',
      defaultModel: 'claude-opus-5-88',
      source: 'database',
      updatedAt: '2026-09-16T10:00:00.000Z',
      reasoning: null,
    });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
  });

  it('没有数据库覆盖值时报告环境变量来源', async () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    const body = await (await GET(req('GET'))).json();
    expect(body).toMatchObject({ model: 'env-model', defaultModel: 'env-model', source: 'environment' });
  });

  it('环境变量也没有时报告缺省来源', async () => {
    vi.stubEnv('LLM_MODEL', '');
    const body = await (await GET(req('GET'))).json();
    expect(body).toMatchObject({ model: 'claude-opus-5-88', source: 'default', updatedAt: null });
  });

  it('读库失败 → 503，不把数据库异常细节回给前端', async () => {
    db.resolve.mockRejectedValue(new Error('connection string rejected'));
    const res = await GET(req('GET'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'SETTINGS_UNAVAILABLE' });
    expect(JSON.stringify(body)).not.toContain('connection string');
  });

  it('响应里只有模型名，绝不出现接口地址或密钥', async () => {
    vi.stubEnv('LLM_BASE_URL', 'https://secret-upstream.example/v1');
    vi.stubEnv('LLM_API_KEY', 'sk-should-never-be-returned');
    db.resolve.mockResolvedValue([{ llm_model: 'vendor/model', updated_at: null }]);
    const raw = await (await GET(req('GET'))).text();
    expect(raw).not.toContain('secret-upstream');
    expect(raw).not.toContain('sk-should-never-be-returned');
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort())
      .toEqual(['defaultModel', 'model', 'reasoning', 'source', 'updatedAt']);
  });
});

describe('PATCH /api/admin/llm', () => {
  it('匿名 → 401，不碰数据库也不发探测', async () => {
    const res = await PATCH(req('PATCH', { token: null, body: { model: 'x' } }));
    expect(res.status).toBe(401);
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.probeModel).not.toHaveBeenCalled();
  });

  it('成员会话 → 403', async () => {
    vi.stubEnv('AUTH_ACCOUNTS_ENABLED', 'true');
    mocks.findSessionByToken.mockResolvedValue(memberRecord());
    const res = await PATCH(req('PATCH', {
      token: null, headers: { cookie: MEMBER_SESSION, origin: 'http://localhost', 'x-nf-csrf': '1' }, body: { model: 'x' },
    }));
    expect(res.status).toBe(403);
    expect(mocks.probeModel).not.toHaveBeenCalled();
    expect(settingWrites()).toHaveLength(0);
  });

  it.each([
    ['空串', ''], ['空白', ' '], ['含空格', 'bad model'], ['含换行', 'bad\nmodel'],
    ['含控制字符', `bad${String.fromCharCode(0)}model`], ['非允许标点', 'model;drop'],
    ['超长', 'a'.repeat(201)], ['非字符串', 42], ['缺字段', undefined],
  ])('非法模型名（%s）→ 400，且不探测不写库', async (_name, model) => {
    const res = await PATCH(req('PATCH', { body: { model } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_MODEL' });
    expect(mocks.probeModel).not.toHaveBeenCalled();
    expect(settingWrites()).toHaveLength(0);
    expect(mocks.resetModelCache).not.toHaveBeenCalled();
  });

  // 回归护栏：删掉"保存前验证"这段，本用例必须失败（会把没验证的模型写进库）。
  it('保存前验证失败 → 502，绝不写库', async () => {
    mocks.probeModel.mockResolvedValue({
      ok: false, reasoning: false, reason: '模型验证失败：模型服务暂时不可用（HTTP 400），请稍后重试。', warning: '',
    });
    const res = await PATCH(req('PATCH', { body: { model: 'broken/model' } }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: 'MODEL_PROBE_FAILED',
      error: '模型验证失败：模型服务暂时不可用（HTTP 400），请稍后重试。',
    });
    expect(mocks.probeModel).toHaveBeenCalledWith('broken/model');
    expect(settingWrites()).toHaveLength(0);
    expect(mocks.resetModelCache).not.toHaveBeenCalled();
  });

  it('验证通过才写库，并清缓存立即生效', async () => {
    db.resolve.mockResolvedValue([{ updated_at: '2026-09-16T10:00:00.000Z' }]);
    const res = await PATCH(req('PATCH', { body: { model: 'vendor/model' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      model: 'vendor/model',
      defaultModel: 'claude-opus-5-88',
      source: 'database',
      updatedAt: '2026-09-16T10:00:00.000Z',
      reasoning: false,
    });
    const writes = settingWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain('INSERT INTO app_settings');
    expect(writes[0].values).toEqual(['vendor/model']);
    expect(mocks.resetModelCache).toHaveBeenCalledTimes(1);
  });

  it('推理模型照常保存，但把提示透出给前端', async () => {
    mocks.probeModel.mockResolvedValue({
      ok: true, reasoning: true, reason: '', warning: '该模型是推理模型：思维链与正文共享 max_tokens。',
    });
    db.resolve.mockResolvedValue([{ updated_at: '2026-09-16T10:00:00.000Z' }]);
    const body = await (await PATCH(req('PATCH', { body: { model: 'reasoner/model' } }))).json();
    expect(body).toMatchObject({ model: 'reasoner/model', reasoning: true, warning: '该模型是推理模型：思维链与正文共享 max_tokens。' });
  });

  it('恢复默认清空覆盖值，且不需要通过验证', async () => {
    mocks.probeModel.mockResolvedValue({ ok: false, reasoning: false, reason: '不该被调用', warning: '' });
    const res = await PATCH(req('PATCH', { body: { model: null } }));
    expect(res.status).toBe(200);
    expect(mocks.probeModel).not.toHaveBeenCalled();
    const writes = settingWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain('UPDATE app_settings SET llm_model = NULL');
    expect(mocks.resetModelCache).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ source: 'default', updatedAt: null });
  });

  it('写库失败 → 503，不谎报成功', async () => {
    db.resolve.mockRejectedValue(new Error('write rejected'));
    const res = await PATCH(req('PATCH', { body: { model: 'vendor/model' } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'SETTINGS_UNAVAILABLE' });
    expect(mocks.resetModelCache).not.toHaveBeenCalled();
  });

  it('带 Origin 的写请求缺固定 CSRF 头 → 403，且不探测不写库', async () => {
    const res = await PATCH(req('PATCH', { body: { model: 'vendor/model' }, headers: { origin: 'http://localhost' } }));
    expect(res.status).toBe(403);
    expect(mocks.probeModel).not.toHaveBeenCalled();
    expect(settingWrites()).toHaveLength(0);
  });

  it('带 Origin 的写请求跨源 → 403', async () => {
    const res = await PATCH(req('PATCH', {
      body: { model: 'vendor/model' },
      headers: { origin: 'https://evil.example', 'x-nf-csrf': '1' },
    }));
    expect(res.status).toBe(403);
    expect(settingWrites()).toHaveLength(0);
  });

  it('同源 + CSRF 头 + owner 口令可以通过（浏览器路径）', async () => {
    db.resolve.mockResolvedValue([{ updated_at: '2026-09-16T10:00:00.000Z' }]);
    const res = await PATCH(req('PATCH', {
      body: { model: 'vendor/model' },
      headers: { origin: 'http://localhost', 'x-nf-csrf': '1' },
    }));
    expect(res.status).toBe(200);
    expect(settingWrites()).toHaveLength(1);
  });
});

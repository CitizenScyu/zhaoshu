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
  mocks.probeModel.mockResolvedValue({ ok: true, reasoning: 'unknown', reason: '', warning: '' });
  // 库里的行（含默认值那三列）。缺省是「两列都没有覆盖值」，回落到环境变量。
  db.resolve.mockResolvedValue([{
    llm_model: null, llm_reasoning: null, updated_at: null,
    default_model: null, default_model_reasoning: null, default_model_updated_at: null,
  }]);
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
      defaultSource: 'default',
      updatedAt: '2026-09-16T10:00:00.000Z',
      defaultUpdatedAt: null,
      reasoning: null,
    });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toBe('Cookie, Authorization, X-Owner-Token');
  });

  // 回归护栏（warning 落库）：GET 不读那一列 / 不把它放进响应 → 本用例必须失败，
  // 「当前模型是推理模型」的告警就会只在保存成功那一次闪现，刷新即失。
  it('刷新后仍读得到上次保存时落库的推理判定', async () => {
    db.resolve.mockResolvedValue([
      { llm_model: 'vendor/model', llm_reasoning: 'yes', updated_at: '2026-09-16T10:00:00.000Z' },
    ]);
    const body = await (await GET(req('GET'))).json();
    expect(body).toEqual({
      model: 'vendor/model',
      defaultModel: 'claude-opus-5-88',
      source: 'database',
      defaultSource: 'default',
      updatedAt: '2026-09-16T10:00:00.000Z',
      defaultUpdatedAt: null,
      reasoning: 'yes',
    });
  });

  it('库里是脏判定值时当未知，不把它递给前端', async () => {
    db.resolve.mockResolvedValue([{ llm_model: 'vendor/model', llm_reasoning: 'maybe', updated_at: null }]);
    expect(await (await GET(req('GET'))).json()).toMatchObject({ reasoning: null });
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
      .toEqual(['defaultModel', 'defaultSource', 'defaultUpdatedAt', 'model', 'reasoning', 'source', 'updatedAt']);
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
      ok: false, reasoning: 'unknown', reason: '模型验证失败：模型服务暂时不可用（HTTP 400），请稍后重试。', warning: '',
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
      defaultSource: 'default',
      updatedAt: '2026-09-16T10:00:00.000Z',
      defaultUpdatedAt: null,
      reasoning: 'unknown',
    });
    const writes = settingWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain('INSERT INTO app_settings');
    // 判定值一并落库：刷新页面后 GET 还要靠它显示「当前模型是推理模型」。
    expect(writes[0].values).toEqual(['vendor/model', 'unknown']);
    expect(mocks.resetModelCache).toHaveBeenCalledTimes(1);
  });

  // S1：判为推理模型时不直接写库，先要一次显式确认。危害不在于模型本身，而在于
  // owner 在不知道后果的情况下保存它——正是 2026-09-16 那次故障的形态。
  describe('推理模型需要显式确认', () => {
    const reasoningProbe = () => mocks.probeModel.mockResolvedValue({
      ok: true, reasoning: 'yes', reason: '', warning: '该模型是推理模型：思维链与正文共享 max_tokens。',
    });

    // 回归护栏：删掉确认分支 → 本用例必须失败（会直接 200 写库）。
    it('不带确认标志 → 409，且绝不写库、不清缓存', async () => {
      reasoningProbe();
      const res = await PATCH(req('PATCH', { body: { model: 'reasoner/model' } }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('REASONING_MODEL_REQUIRES_CONFIRMATION');
      expect(body.error).toMatch(/推理模型/);
      expect(body.error).toMatch(/acknowledgeReasoning/);
      expect(settingWrites()).toHaveLength(0);
      expect(mocks.resetModelCache).not.toHaveBeenCalled();
    });

    it('带 acknowledgeReasoning: true 才写库，并照旧把 warning 透出', async () => {
      reasoningProbe();
      db.resolve.mockResolvedValue([{ updated_at: '2026-09-16T10:00:00.000Z' }]);
      const res = await PATCH(req('PATCH', { body: { model: 'reasoner/model', acknowledgeReasoning: true } }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        model: 'reasoner/model',
        reasoning: 'yes',
        warning: '该模型是推理模型：思维链与正文共享 max_tokens。',
      });
      expect(settingWrites()[0].values).toEqual(['reasoner/model', 'yes']);
    });

    it('acknowledgeReasoning: false 等同于没确认', async () => {
      reasoningProbe();
      expect((await PATCH(req('PATCH', { body: { model: 'reasoner/model', acknowledgeReasoning: false } }))).status).toBe(409);
      expect(settingWrites()).toHaveLength(0);
    });

    it.each([['字符串', 'true'], ['数字', 1], ['null', null]])(
      'acknowledgeReasoning 是 %s → 400，不探测也不写库', async (_name, value) => {
        const res = await PATCH(req('PATCH', { body: { model: 'vendor/model', acknowledgeReasoning: value } }));
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'INVALID_CONFIRMATION' });
        expect(mocks.probeModel).not.toHaveBeenCalled();
        expect(settingWrites()).toHaveLength(0);
      },
    );

    // 不谎报：判定不是 'yes'（unknown / 从没探测出思维链）时不拦，也不需要确认。
    it.each(['unknown', 'no'])('判定是 %s 时不要求确认', async (verdict) => {
      mocks.probeModel.mockResolvedValue({ ok: true, reasoning: verdict, reason: '', warning: '' });
      db.resolve.mockResolvedValue([{ updated_at: '2026-09-16T10:00:00.000Z' }]);
      const res = await PATCH(req('PATCH', { body: { model: 'vendor/model' } }));
      expect(res.status).toBe(200);
      expect(settingWrites()).toHaveLength(1);
    });

    // 🔴 死锁护栏：恢复默认必须永远不需要确认、永远不被挡住，
    // 哪怕当前探测（这里根本不发生）本会判成推理模型。
    it('恢复默认永远不需要确认，哪怕探测会判成推理模型', async () => {
      reasoningProbe();
      const res = await PATCH(req('PATCH', { body: { model: null } }));
      expect(res.status).toBe(200);
      expect(mocks.probeModel).not.toHaveBeenCalled();
      expect(await res.json()).toMatchObject({ source: 'default', updatedAt: null, reasoning: null });
      expect(settingWrites()).toHaveLength(1);
    });

    it('恢复默认也不接受畸形确认标志之外的任何门槛（带标志同样成功）', async () => {
      reasoningProbe();
      const res = await PATCH(req('PATCH', { body: { model: null, acknowledgeReasoning: true } }));
      expect(res.status).toBe(200);
    });
  });

  it('恢复默认清空覆盖值，且不需要通过验证', async () => {
    mocks.probeModel.mockResolvedValue({ ok: false, reasoning: 'unknown', reason: '不该被调用', warning: '' });
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

  // task-69：默认值本身可改（llm_model 没有覆盖值时用的那个模型）。
  // 走的是与 model 完全相同的护栏：探测在前、确认在后、写库最后。
  describe('默认值（defaultModel）', () => {
    it('只写默认值那三列，不碰 llm_model / llm_reasoning，并清缓存立即生效', async () => {
      db.resolve.mockResolvedValue([{ default_model_updated_at: '2026-09-17T00:00:00.000Z' }]);
      const res = await PATCH(req('PATCH', { body: { defaultModel: 'vendor/default-1' } }));
      expect(res.status).toBe(200);
      const writes = settingWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0].text).toContain('default_model = EXCLUDED.default_model');
      expect(writes[0].text).not.toContain('llm_model');
      expect(writes[0].text).not.toContain('llm_reasoning');
      expect(writes[0].values).toEqual(['vendor/default-1', 'unknown']);
      // 不清缓存的话，30s 内运行时还在用旧值——界面就会看起来「改了但没生效」。
      expect(mocks.resetModelCache).toHaveBeenCalledTimes(1);
    });

    it('没有当前覆盖值时，默认值就是生效模型（来源 database，但不谎报 updatedAt）', async () => {
      db.resolve.mockResolvedValue([{ default_model_updated_at: '2026-09-17T00:00:00.000Z' }]);
      const body = await (await PATCH(req('PATCH', { body: { defaultModel: 'vendor/default-1' } }))).json();
      expect(body).toEqual({
        model: 'vendor/default-1',
        defaultModel: 'vendor/default-1',
        source: 'database',
        defaultSource: 'database',
        updatedAt: null,
        defaultUpdatedAt: '2026-09-17T00:00:00.000Z',
        reasoning: 'unknown',
      });
    });

    // 反向护栏：改默认值**不能**把当前生效模型说成默认值。已有 llm_model 覆盖时它必须原样不动。
    it('已有当前覆盖值时，改默认值不动当前模型', async () => {
      db.resolve.mockResolvedValue([{
        llm_model: 'vendor/current', llm_reasoning: 'yes', updated_at: '2026-09-16T10:00:00.000Z',
        default_model_updated_at: '2026-09-17T00:00:00.000Z',
      }]);
      const body = await (await PATCH(req('PATCH', { body: { defaultModel: 'vendor/default-1' } }))).json();
      expect(body).toMatchObject({
        model: 'vendor/current',
        defaultModel: 'vendor/default-1',
        source: 'database',
        defaultSource: 'database',
        updatedAt: '2026-09-16T10:00:00.000Z',
        reasoning: 'yes',
      });
    });

    it('非法默认值名 → 400，且不探测不读库不写库', async () => {
      const res = await PATCH(req('PATCH', { body: { defaultModel: 'bad name' } }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_MODEL' });
      expect(mocks.probeModel).not.toHaveBeenCalled();
      expect(mocks.getSql).not.toHaveBeenCalled();
      expect(settingWrites()).toHaveLength(0);
    });

    it('保存前验证失败 → 502，绝不写库', async () => {
      mocks.probeModel.mockResolvedValue({
        ok: false, reasoning: 'unknown', reason: '模型验证失败：模型服务暂时不可用（HTTP 400），请稍后重试。', warning: '',
      });
      const res = await PATCH(req('PATCH', { body: { defaultModel: 'broken/model' } }));
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'MODEL_PROBE_FAILED' });
      expect(mocks.probeModel).toHaveBeenCalledWith('broken/model');
      expect(settingWrites()).toHaveLength(0);
      expect(mocks.resetModelCache).not.toHaveBeenCalled();
    });

    it('判为推理模型时同样要确认，带标志才写库', async () => {
      mocks.probeModel.mockResolvedValue({ ok: true, reasoning: 'yes', reason: '', warning: '' });
      const denied = await PATCH(req('PATCH', { body: { defaultModel: 'reasoner/model' } }));
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ code: 'REASONING_MODEL_REQUIRES_CONFIRMATION' });
      expect(settingWrites()).toHaveLength(0);

      db.resolve.mockResolvedValue([{ default_model_updated_at: '2026-09-17T00:00:00.000Z' }]);
      const allowed = await PATCH(req('PATCH', { body: { defaultModel: 'reasoner/model', acknowledgeReasoning: true } }));
      expect(allowed.status).toBe(200);
      expect(settingWrites()[0].values).toEqual(['reasoner/model', 'yes']);
    });

    // 死锁护栏：清除库内默认值必须永远可行，不被一个坏模型挡住。
    it('清除默认值不做探测，回退到环境变量/硬编码缺省', async () => {
      mocks.probeModel.mockResolvedValue({ ok: false, reasoning: 'unknown', reason: '不该被调用', warning: '' });
      const res = await PATCH(req('PATCH', { body: { defaultModel: null } }));
      expect(res.status).toBe(200);
      expect(mocks.probeModel).not.toHaveBeenCalled();
      const writes = settingWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0].text).toContain('default_model = NULL');
      expect(writes[0].text).toContain('default_model_reasoning = NULL');
      expect(writes[0].text).toContain('default_model_updated_at = NULL');
      expect(writes[0].text).not.toContain('llm_model');
      expect(await res.json()).toMatchObject({ source: 'default', defaultSource: 'default', updatedAt: null });
      expect(mocks.resetModelCache).toHaveBeenCalledTimes(1);
    });

    it('清除默认值不动当前覆盖值', async () => {
      db.resolve.mockResolvedValue([{ llm_model: 'vendor/current', updated_at: '2026-09-16T10:00:00.000Z' }]);
      const body = await (await PATCH(req('PATCH', { body: { defaultModel: null } }))).json();
      expect(body).toMatchObject({ model: 'vendor/current', source: 'database', defaultSource: 'default' });
    });

    // 两个目标一次只能改一个：各自要做一次最长 30s 的保存前验证，串起来会顶破 maxDuration 60s。
    it('同时带 model 与 defaultModel → 400，不探测不写库', async () => {
      const res = await PATCH(req('PATCH', { body: { model: 'vendor/a', defaultModel: 'vendor/b' } }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'AMBIGUOUS_TARGET' });
      expect(mocks.probeModel).not.toHaveBeenCalled();
      expect(settingWrites()).toHaveLength(0);
    });
  });

  // 向后兼容：加 defaultModel 之前的调用形态（只带 model）语义逐字不变。
  it('旧调用形态（只带 model / model: null）不受 defaultModel 影响', async () => {
    db.resolve.mockResolvedValue([{ default_model: 'vendor/default-1', default_model_updated_at: 'x' }]);
    const set = await (await PATCH(req('PATCH', { body: { model: 'vendor/model' } }))).json();
    expect(set).toMatchObject({ model: 'vendor/model', defaultModel: 'vendor/default-1', source: 'database' });
    expect(mocks.probeModel).toHaveBeenCalledWith('vendor/model');

    db.resolve.mockResolvedValue([{ default_model: 'vendor/default-1', default_model_updated_at: 'x' }]);
    const cleared = await (await PATCH(req('PATCH', { body: { model: null } }))).json();
    // 恢复默认：当前模型回到**库内默认值**（不是环境变量），而默认值本身不受影响。
    expect(cleared).toMatchObject({
      model: 'vendor/default-1', defaultModel: 'vendor/default-1', source: 'database', defaultSource: 'database',
    });
  });
});

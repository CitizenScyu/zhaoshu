import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 只替换设置读取这一层：解析优先级、缓存、失败回退与保存前验证都走真实实现。
const settings = vi.hoisted(() => ({ readModelSetting: vi.fn() }));
vi.mock('./app-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('./app-settings')>(),
  readModelSetting: settings.readModelSetting,
}));

const fetchMock = vi.fn();
let client: typeof import('./llm');

const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const sse = (events: string[]) => new Response(events.join(''), {
  headers: { 'Content-Type': 'text/event-stream' },
});
const content = (text: string) => data({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const reasoning = (text: string) => data({ choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] });
const finish = (reason: string) => data({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const DONE = 'data: [DONE]\n\n';
const sentBody = (call = 0) => JSON.parse(String(fetchMock.mock.calls[call][1]?.body)) as Record<string, unknown>;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('LLM_API_KEY', 'test-key');
  vi.stubEnv('LLM_BASE_URL', 'https://llm.test/v1');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  settings.readModelSetting.mockReset();
  settings.readModelSetting.mockResolvedValue({ model: null, updatedAt: null });
  client = await import('./llm');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resolveModel：数据库设置 → 环境变量 → 硬编码缺省', () => {
  it('数据库有覆盖值时优先于环境变量', async () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    settings.readModelSetting.mockResolvedValue({ model: 'db-model', updatedAt: null });
    await expect(client.resolveModel()).resolves.toBe('db-model');
  });

  it('数据库没有覆盖值时用环境变量', async () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    await expect(client.resolveModel()).resolves.toBe('env-model');
  });

  it('两者都没有时用硬编码缺省', async () => {
    const saved = process.env.LLM_MODEL;
    delete process.env.LLM_MODEL;
    try {
      await expect(client.resolveModel()).resolves.toBe('claude-opus-5-88');
    } finally {
      if (saved === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = saved;
    }
  });

  it('连续多次解析只读一次库（30s 进程内缓存）', async () => {
    settings.readModelSetting.mockResolvedValue({ model: 'db-model', updatedAt: null });
    await client.resolveModel();
    await client.resolveModel();
    await client.resolveModel();
    expect(settings.readModelSetting).toHaveBeenCalledTimes(1);
  });

  it('缓存过期后重新读库', async () => {
    vi.useFakeTimers();
    settings.readModelSetting.mockResolvedValue({ model: 'db-model', updatedAt: null });
    await expect(client.resolveModel()).resolves.toBe('db-model');
    vi.setSystemTime(Date.now() + client.MODEL_CACHE_TTL_MS + 1);
    settings.readModelSetting.mockResolvedValue({ model: 'db-model-2', updatedAt: null });
    await expect(client.resolveModel()).resolves.toBe('db-model-2');
    expect(settings.readModelSetting).toHaveBeenCalledTimes(2);
  });

  it('清缓存后立即生效（PATCH 写库后的路径）', async () => {
    settings.readModelSetting.mockResolvedValue({ model: 'old-model', updatedAt: null });
    await expect(client.resolveModel()).resolves.toBe('old-model');
    settings.readModelSetting.mockResolvedValue({ model: 'new-model', updatedAt: null });
    expect(await client.resolveModel()).toBe('old-model');
    client.resetModelCache();
    await expect(client.resolveModel()).resolves.toBe('new-model');
  });

  it('读库失败时静默回退到环境变量，且不把故障缓存住', async () => {
    vi.stubEnv('LLM_MODEL', 'env-model');
    settings.readModelSetting.mockRejectedValue(new Error('db down'));
    await expect(client.resolveModel()).resolves.toBe('env-model');
    await expect(client.resolveModel()).resolves.toBe('env-model');
    expect(settings.readModelSetting).toHaveBeenCalledTimes(2);
  });

  it('读库挂住时 2 秒上限后回退，不会拖住模型调用', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LLM_MODEL', 'env-model');
    settings.readModelSetting.mockImplementation(() => new Promise(() => {}));
    const pending = client.resolveModel();
    await vi.advanceTimersByTimeAsync(client.MODEL_SETTINGS_READ_TIMEOUT_MS - 1);
    await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('env-model');
  });
});

// 回归护栏：模型一旦退回模块加载期读一次的常量，本用例必须失败。
describe('chat / chatRobust 用的是每次调用解析出来的模型', () => {
  it('chatRobust（三个调用点唯一入口）跟随运行时解析结果', async () => {
    settings.readModelSetting.mockResolvedValue({ model: 'db/model-a', updatedAt: null });
    fetchMock.mockImplementation(() => sse([content('正文'), finish('stop'), DONE]));
    await client.chatRobust('system', 'user');
    expect(sentBody().model).toBe('db/model-a');

    client.resetModelCache();
    settings.readModelSetting.mockResolvedValue({ model: 'db/model-b', updatedAt: null });
    await client.chatRobust('system', 'user');
    expect(sentBody(1).model).toBe('db/model-b');
    expect(settings.readModelSetting).toHaveBeenCalledTimes(2);
  });

  it('chat 默认用解析结果，显式传入的候选模型只影响那一次调用', async () => {
    settings.readModelSetting.mockResolvedValue({ model: 'db/model-a', updatedAt: null });
    fetchMock.mockImplementation(() => sse([content('正文'), finish('stop'), DONE]));
    await client.chat('system', 'user');
    expect(sentBody().model).toBe('db/model-a');
    fetchMock.mockImplementation(() => sse([content('正文'), finish('stop'), DONE]));
    await client.chat('system', 'user', { model: 'candidate/model' });
    expect(sentBody(1).model).toBe('candidate/model');
    await client.chat('system', 'user');
    expect(sentBody(2).model).toBe('db/model-a');
  });
});

describe('probeModel：保存前验证', () => {
  it('极小请求：候选模型 + 很小的 max_tokens，正文非空即通过', async () => {
    fetchMock.mockImplementation(() => sse([content('OK'), finish('stop'), DONE]));
    await expect(client.probeModel('candidate/model')).resolves.toEqual({
      ok: true, reasoning: false, reason: '', warning: '',
    });
    const body = sentBody();
    expect(body.model).toBe('candidate/model');
    expect(body.max_tokens).toBe(client.MODEL_PROBE_MAX_TOKENS);
    expect(body.max_tokens).toBe(64);
    expect(body.stream).toBe(true);
  });

  it('返回里有 reasoning_content 就报告是推理模型', async () => {
    fetchMock.mockImplementation(() => sse([reasoning('先想一会'), content('OK'), finish('stop'), DONE]));
    await expect(client.probeModel('reasoner')).resolves.toMatchObject({ ok: true, reasoning: true, warning: '' });
  });

  it('推理模型把探测预算用在思维链上时仍判可用，但必须给出提示', async () => {
    fetchMock.mockImplementation(() => sse([reasoning('想很久'), finish('length'), DONE]));
    const probe = await client.probeModel('reasoner');
    expect(probe.ok).toBe(true);
    expect(probe.reasoning).toBe(true);
    expect(probe.warning).toMatch(/推理模型/);
  });

  it('上游拒绝时判失败，可读原因里不含上游正文', async () => {
    fetchMock.mockImplementation(() => new Response('channel error: sk-secret-value upstream', { status: 400 }));
    const probe = await client.probeModel('missing/model');
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain('HTTP 400');
    expect(probe.reason).not.toContain('sk-secret-value');
    expect(probe.reason).not.toContain('upstream');
  });

  it('HTTP 正常但正文为空时判失败', async () => {
    fetchMock.mockImplementation(() => sse([content(''), finish('stop'), DONE]));
    const probe = await client.probeModel('silent/model');
    expect(probe.ok).toBe(false);
    expect(probe.reason).toMatch(/空正文/);
  });

  it('有独立的 20 秒上限，超时即判失败（不沿用路由的模型预算）', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = client.probeModel('slow/model');
    await vi.advanceTimersByTimeAsync(client.MODEL_PROBE_TIMEOUT_MS);
    const probe = await pending;
    expect(probe.ok).toBe(false);
    expect(probe.reason).toMatch(/总超时（20s）/);
  });
});

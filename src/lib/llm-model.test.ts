import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRobust } from './llm';

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
// 真实记录形态：网关不在 delta 里吐思维链，只在最后的 usage 块里报思维链 token 数。
const usageBlock = (usage: Record<string, unknown>) => data({ choices: [], usage });
const REASONING_USAGE = {
  prompt_tokens: 30, completion_tokens: 180, total_tokens: 210,
  completion_tokens_details: { reasoning_tokens: 150 },
};
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

  it('解析设置期间被取消时，这次调用立刻以取消失败，请求不会真的打到上游', async () => {
    const controller = new AbortController();
    let releaseRead: (setting: { model: string | null; updatedAt: string | null }) => void = () => {};
    settings.readModelSetting.mockImplementation(() => new Promise((resolve) => { releaseRead = resolve; }));
    const pending = client.chatRobust('system', 'user', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    releaseRead({ model: 'db/model-a', updatedAt: null });
    await expect(pending).rejects.toMatchObject({ message: '模型调用已取消。', retryable: false });
    // 取消补在解析之后：这次调用带着已经中止的信号失败，上游不会被真的调用。
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('probeModel：保存前验证的三态推理判定', () => {
  it('探测请求本身必须有机会触发思考：分步计算的题、预算远大于一个词', async () => {
    fetchMock.mockImplementation(() => sse([content('307.8'), finish('stop'), DONE]));
    await expect(client.probeModel('candidate/model')).resolves.toEqual({
      ok: true, reasoning: 'unknown', reason: '', warning: '',
    });
    const body = sentBody();
    expect(body.model).toBe('candidate/model');
    expect(body.max_tokens).toBe(client.MODEL_PROBE_MAX_TOKENS);
    expect(body.stream).toBe(true);
    // 旧探针是「只回一个词 / Say OK」+ 64 token，模型不需要思考，于是永远测不到思维链。
    expect(client.MODEL_PROBE_MAX_TOKENS).toBeGreaterThanOrEqual(256);
    const messages = body.messages as { content: string }[];
    expect(messages[0].content).not.toContain('只回一个词');
    expect(messages[1].content).not.toBe('Say OK');
    expect(messages[1].content).toMatch(/分步|计算/);
  });

  // 回归护栏（判据说谎）：没有观测到思维链时只能说 unknown，绝不能说成「不是推理模型」。
  // 还原成旧的 boolean 写法（observedDelta ? true : false）时本用例必须失败。
  it('没观测到思维链时判 unknown，绝不判「不是推理模型」', async () => {
    fetchMock.mockImplementation(() => sse([content('307.8'), finish('stop'), DONE]));
    const probe = await client.probeModel('maybe-reasoner');
    expect(probe.reasoning).toBe('unknown');
    expect(probe.reasoning).not.toBe('no');
  });

  it('返回里有 reasoning_content 就报告是推理模型', async () => {
    fetchMock.mockImplementation(() => sse([reasoning('先算 17×23'), content('307.8'), finish('stop'), DONE]));
    await expect(client.probeModel('reasoner')).resolves.toMatchObject({ ok: true, reasoning: 'yes', warning: '' });
  });

  // 真实记录形态：delta 里没有 reasoning_content，只有 usage 里的 reasoning_tokens。
  // 只看 delta 的写法会漏报成 unknown，这条用例钉住 usage 旁证。
  it('只在 usage 里报 reasoning_tokens 也判是推理模型', async () => {
    fetchMock.mockImplementation(() => sse([content('307.8'), finish('stop'), usageBlock(REASONING_USAGE), DONE]));
    const probe = await client.probeModel('usage-only-reasoner');
    expect(probe.reasoning).toBe('yes');
    expect(probe.ok).toBe(true);
  });

  it('另一种真实形态：usage 的思维链计数放在 output_tokens_details 下', async () => {
    fetchMock.mockImplementation(() => sse([
      content('307.8'), finish('stop'),
      usageBlock({ completion_tokens: 90, output_tokens_details: { reasoning_tokens: 60 } }),
      DONE,
    ]));
    await expect(client.probeModel('output-details-reasoner')).resolves.toMatchObject({ reasoning: 'yes' });
  });

  it('usage 明写 reasoning_tokens=0 且没有思维链增量时仍是 unknown（0 不是「不是推理模型」的证据）', async () => {
    fetchMock.mockImplementation(() => sse([
      content('307.8'), finish('stop'),
      usageBlock({ prompt_tokens: 30, completion_tokens: 12, total_tokens: 42, completion_tokens_details: { reasoning_tokens: 0 } }),
      DONE,
    ]));
    await expect(client.probeModel('plain/model')).resolves.toMatchObject({ ok: true, reasoning: 'unknown' });
  });

  it('推理模型把探测预算用在思维链上时仍判可用，但必须给出提示', async () => {
    fetchMock.mockImplementation(() => sse([reasoning('想很久'), finish('length'), DONE]));
    const probe = await client.probeModel('reasoner');
    expect(probe.ok).toBe(true);
    expect(probe.reasoning).toBe('yes');
    expect(probe.warning).toMatch(/推理模型/);
  });

  it('usage 旁证 + 预算被截断也走「可用 + 提示」这条既有裁决', async () => {
    fetchMock.mockImplementation(() => sse([usageBlock(REASONING_USAGE), finish('length'), DONE]));
    const probe = await client.probeModel('reasoner');
    expect(probe.ok).toBe(true);
    expect(probe.reasoning).toBe('yes');
    expect(probe.warning).toMatch(/推理模型/);
  });

  it('预算被截断但没观测到思维链时不豁免：仍判失败（不能凭空断言它是推理模型）', async () => {
    fetchMock.mockImplementation(() => sse([content('半截'), finish('length'), DONE]));
    const probe = await client.probeModel('truncated/model');
    expect(probe.ok).toBe(false);
    expect(probe.reasoning).toBe('unknown');
    expect(probe.reason).toMatch(/思考/);
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
    // 上游答复了、只是内容不合要求：那是语义结论，不重试。
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('有独立的 30 秒上限，超时即判失败（不沿用路由的模型预算）', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = client.probeModel('slow/model');
    await vi.advanceTimersByTimeAsync(client.MODEL_PROBE_TIMEOUT_MS);
    const probe = await pending;
    expect(probe.ok).toBe(false);
    expect(probe.reason).toMatch(/总超时（30s）/);
  });

  it('探测独立超时仍远小于路由的 maxDuration，慢模型不会被平台砍掉', async () => {
    expect(client.MODEL_PROBE_TIMEOUT_MS).toBeLessThan(60_000);
    expect(client.MODEL_PROBE_TIMEOUT_MS).toBeGreaterThan(20_000);
  });
});

// 2026-09-17 实测：真实网关 5 次探测里 3 次是**进程内第一个**请求在 ~11s 被掐成
// UND_ERR_CONNECT_TIMEOUT（fetch failed），模型明明可用，owner 点保存却拿到 502。
describe('probeModel：冷连接重试', () => {
  const connectFailure = () => Promise.reject(new TypeError('fetch failed'));

  // 回归护栏：把重试删掉（两次尝试改成一次）本用例必须失败。
  it('第一次冷连接失败 → 同一次探测内重试成功 → 判定为可用', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(connectFailure)
      .mockImplementationOnce(() => sse([content('307.8'), finish('stop'), DONE]));
    const pending = client.probeModel('cold/model');
    await vi.advanceTimersByTimeAsync(client.MODEL_PROBE_RETRY_DELAY_MS);
    await expect(pending).resolves.toMatchObject({ ok: true, reasoning: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('两次都是冷连接失败时如实判失败，且失败原因不含地址或密钥', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(connectFailure);
    const pending = client.probeModel('dead/model');
    await vi.advanceTimersByTimeAsync(client.MODEL_PROBE_RETRY_DELAY_MS);
    const probe = await pending;
    expect(probe.ok).toBe(false);
    expect(probe.reason).toMatch(/LLM 请求失败/);
    expect(probe.reason).not.toMatch(/https?:|sk-|Bearer/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // 不变量：两次尝试共享同一个截止时间，第二次拿不到整份预算。第一次就耗掉 ~28s 时，
  // 剩下的 2s 连重试等待都不够——不能开第二次，否则总时长会越过 MODEL_PROBE_TIMEOUT_MS。
  it('剩余预算不够时不开第二次，探测总时长仍被 30s 封住', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new TypeError('fetch failed')), 28_000);
    }));
    const pending = client.probeModel('slow-cold/model');
    await vi.advanceTimersByTimeAsync(28_000);
    await vi.advanceTimersByTimeAsync(client.MODEL_PROBE_TIMEOUT_MS);
    const probe = await pending;
    expect(probe.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('第一次被自己的预算掐掉（用光 30s）后不开第二次，最坏墙钟仍是 30s', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = client.probeModel('always-slow/model');
    await vi.advanceTimersByTimeAsync(client.MODEL_PROBE_TIMEOUT_MS);
    const probe = await pending;
    expect(probe.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(client.MODEL_PROBE_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('第二次拿的是剩余预算，墙钟合计不超过 MODEL_PROBE_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let calls = 0;
    fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      calls += 1;
      const index = calls;
      const fail = () => reject(index === 1 ? new TypeError('fetch failed') : new DOMException('aborted', 'AbortError'));
      if (index === 1) setTimeout(fail, 10_000); // 冷连接在 10s 被掐掉
      else init?.signal?.addEventListener('abort', fail);
    }));
    const pending = client.probeModel('cold-then-slow/model');
    // 10s（第一次连接失败）+ 0.5s（等待）+ 剩余 ~19.5s（第二次自己超时）
    await vi.advanceTimersByTimeAsync(client.MODEL_PROBE_TIMEOUT_MS);
    const probe = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(probe.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(client.MODEL_PROBE_TIMEOUT_MS);
  });

  // 上游答复了失败状态码就不是「没答复」：429/5xx 虽然 LlmError.retryable 为真，
  // 也不该在这里重试——重试只会拿到同一个答案，还把 owner 的等待拖长。
  it.each([
    [429, /请求过于频繁或额度不足/],
    [500, /HTTP 500/],
    [503, /HTTP 503/],
  ])('上游答复 HTTP %i 时不重试（那是语义结论，不是冷连接）', async (status, expected) => {
    fetchMock.mockImplementation(() => new Response('upstream said no', { status }));
    const probe = await client.probeModel('busy/model');
    expect(probe.ok).toBe(false);
    expect(probe.reason).toMatch(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('重试间隔与最小剩余预算都远小于探测上限，不会自己顶破预算', () => {
    expect(client.MODEL_PROBE_RETRY_DELAY_MS + client.MODEL_PROBE_MIN_RETRY_MS)
      .toBeLessThan(client.MODEL_PROBE_TIMEOUT_MS);
  });
});

// 29.5：三个既有调用点（find 的 recall/rerank、profile、feedback）都只经 chatRobust/chat，
// 模型只能来自运行时解析——不写死模型名、不读 LLM_MODEL，类型上也没有 model 覆盖入口。
describe('既有调用点没有模型旁路', () => {
  const sources = import.meta.glob('../app/api/**/route.ts', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>;

  it.each(['find', 'profile', 'feedback'])('%s 路由不写死模型名也不读 LLM_MODEL', (route) => {
    const source = sources[`../app/api/${route}/route.ts`];
    expect(source).toBeDefined();
    expect(source).toMatch(/from '@\/lib\/llm'/);
    expect(source).not.toContain('claude-opus-5-88');
    expect(source).not.toContain('LLM_MODEL');
  });

  it('chatRobust 的选项里没有 model，调用点在类型上就无法旁路运行时解析', () => {
    // @ts-expect-error chatRobust 只接受 Pick<ChatOptions, ...> 的子集，model 不在其中。
    // 一旦有人把 model 加回 chatRobust 的选项，这行会变成「未使用的 @ts-expect-error」，
    // tsc --noEmit 直接失败。
    const rejectedAtCompileTime = () => chatRobust('system', 'user', { model: 'hardcoded-model' });
    expect(rejectedAtCompileTime).toBeTypeOf('function');
  });
});

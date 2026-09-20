import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_TIMEOUT_MS, triggerDownloadWorkflow } from './github';

// 触发下载 worker 的 dispatch：有明确超时与体积边界（无业务载荷）。
// 测试不读 .env、不触碰真实 GitHub；GITHUB_TOKEN 在 beforeEach 注入占位。
describe('triggerDownloadWorkflow', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('GITHUB_TOKEN', 'offline-github-token');
    vi.stubEnv('LEGACY_DOWNLOAD_DISPATCH_ENABLED', '1');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('throws a clear error when GITHUB_TOKEN is missing before any request', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('LEGACY_DOWNLOAD_DISPATCH_ENABLED', '1');
    await expect(triggerDownloadWorkflow()).rejects.toThrow('GITHUB_TOKEN is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a ref-only dispatch (no payload) within the shared github timeout', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await triggerDownloadWorkflow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/api\.github\.com\/repos\/.*\/actions\/workflows\/download\.yml\/dispatches$/);
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main' });
    // 明确超时边界：dispatch 挂在独立的 AbortSignal.timeout 上，与正文流预算分开
    const signal = init?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    await triggerDownloadWorkflow(); // 请求已快速完成，signal 仍保持未中止
  });

  it('maps a non-2xx dispatch to an error carrying the status', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 403 }));
    await expect(triggerDownloadWorkflow()).rejects.toThrow('HTTP 403');
  });

  it('never dispatches system requests, or user requests with default/off configuration', async () => {
    await triggerDownloadWorkflow('system');
    vi.stubEnv('LEGACY_DOWNLOAD_DISPATCH_ENABLED', '');
    await triggerDownloadWorkflow();
    vi.stubEnv('LEGACY_DOWNLOAD_DISPATCH_ENABLED', '0');
    await triggerDownloadWorkflow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the dispatch timeout at its explicit bound', () => {
    expect(GITHUB_TIMEOUT_MS).toBe(10_000);
    // 单个 dispatch 只许 10s：比 60s 下载路由、正文流式读取的 55s 预算更紧
    expect(GITHUB_TIMEOUT_MS).toBeLessThan(55_000);
  });
});
// 触发 zhaoshu-books 私库的下载 worker workflow

const REPO = process.env.ZHAOSHU_BOOKS_REPO || 'CitizenScyu/zhaoshu-books';
const WORKFLOW = 'download.yml';
const REF = 'main';
const DISPATCH_TIMEOUT_MS = 10_000;
// 建任务后的 dispatch 超时：worker 提交（commitFile）在 zhaoshu-books 侧有独立超时。
export const GITHUB_TIMEOUT_MS = 10_000;

// 建任务后立即触发一次 workflow_dispatch:cron 是 */5,但 GitHub 对高频 schedule
// 有静默节流(实测可 3 小时不跑),不主动 dispatch 任务会一直 pending。
// 调用方用 try/catch 兜底,这里失败只抛错,由调用方决定怎么记录。
export async function triggerDownloadWorkflow(): Promise<void> {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not configured');
  }
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'zhaoshu-downloader/1.0',
      },
      body: JSON.stringify({ ref: REF }),
      cache: 'no-store',
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    // dispatch 成功是 204 无 body,失败时读一下 body 方便定位
    const detail = await res.text().catch(() => '');
    throw new Error(`workflow dispatch HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}

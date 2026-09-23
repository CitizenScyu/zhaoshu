import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

// MS-32a:selectTab 的 replaceState 必须透传 window.history.state。
// Next 16 在 history.state 里注入路由状态(含 __NA 标记);传 null 会把它抹掉,
// 之后浏览器回退/前进时 Next 判不出这是自家路由,退回整页刷新。
// renderToStaticMarkup 测不到 history 交互,这里用源码级回归护栏钉住调用形态。
describe('首页 tab 切换的 history 状态透传(MS-32a)', () => {
  it('replaceState 透传 window.history.state,不用 null 覆盖', async () => {
    const source = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
    expect(source).toContain("window.history.replaceState(window.history.state, '', url)");
    expect(source).not.toContain("window.history.replaceState(null, '', url)");
  });
});

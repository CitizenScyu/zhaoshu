// 子进程 preload（artifact.test.ts 专用夹具）：把全局 fetch 替换为立即抛 TypeError('fetch failed')。
// 由 --import 在产物模块图加载前注入：产物 bundle 内的裸 fetch 调用全部落到本桩，
// dry-run 在第一步抓 INDEX_URL 时即确定性失败，测试不再依赖真实网络（yckceo 不可达路径
// 曾因网络挂起 >5s 撞 testTimeout，见 artifact.test.ts 用例注释）。
const failing = () => { throw new TypeError('fetch failed'); };
globalThis.fetch = failing;

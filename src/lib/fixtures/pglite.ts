// PGlite 真库夹具的加载器：route.pglite.test.ts 与 route.e2e.pglite.test.ts 共用。
//
// @electric-sql/pglite 是 package.json 里的 devDependency（^0.5.8），干净机器 `npm ci` 就有。
//
// 为什么缺依赖必须是**硬失败**：2026-09-17 的邀请码 bug 就是这么逃逸的。桩测试全绿，而唯一能
// 看见真库语义的两个用例文件因为解析不到 PGlite 而整文件静默 skip（只打一条 warn、Tests 5 skipped、
// 退出码 0），`npm test` 依然全绿。护栏静默消失和护栏不存在没有区别——所以缺依赖直接抛错，
// 让 `npm test` 变红，而不是悄悄地少测一半。
//
// 唯一的豁免通道：显式设 NF_PGLITE_OPTIONAL=1（例如只装 production 依赖的产物镜像）才允许 skip，
// 且一定会打印告警。默认路径上没有任何「解析不到就跳过」的兜底。

export type PGliteLike = {
  exec(sql: string): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
};

export type PGliteCtor = new () => PGliteLike;

/**
 * 加载 PGlite 构造器。
 * - 正常（依赖在）：返回构造器。
 * - 缺依赖且设了 NF_PGLITE_OPTIONAL=1：打印告警并返回 null（调用方走 describe.skip）。
 * - 缺依赖且没设开关：**抛错**，测试文件加载失败，`npm test` 退出码非 0。
 *
 * 用 `@vite-ignore` 是为了让解析发生在运行时（Node 的 node_modules 解析）而不是 Vite 转换期——
 * 转换期解析失败会绕过这里的豁免逻辑，让 NF_PGLITE_OPTIONAL 失效。
 */
export async function loadPGlite(): Promise<PGliteCtor | null> {
  let failure = '';
  try {
    const mod = (await import(/* @vite-ignore */ '@electric-sql/pglite')) as { PGlite: PGliteCtor };
    if (typeof mod.PGlite === 'function') return mod.PGlite;
    failure = '模块里没有导出 PGlite 构造器';
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (process.env.NF_PGLITE_OPTIONAL === '1') {
    console.warn(
      `[pglite fixture] NF_PGLITE_OPTIONAL=1：跳过全部真库用例（正常情况下应执行 npm ci 装上 devDependencies）。原因：${failure}`,
    );
    return null;
  }
  throw new Error(
    `[@electric-sql/pglite] 真库用例无法加载：${failure}\n` +
      '它是 package.json 里的 devDependency，正常环境请先 `npm ci`。\n' +
      '真库用例静默消失正是邀请码 bug 逃逸的模式，所以这里默认硬失败；' +
      '确实要在没有 devDependencies 的环境里跑，请显式设 NF_PGLITE_OPTIONAL=1。',
  );
}

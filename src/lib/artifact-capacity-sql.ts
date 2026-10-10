// capacity948：把内核抽象端口 CapacitySql 接到**当前实际安装**的数据库客户端
// （@neondatabase/serverless 1.1.0 的 neon() 返回值），不加无用包装、不新建连接、不读 env。
//
// 承接点（948 F1）：现有工厂 getSql 公开返回 `ReturnType<typeof neon>` = `NeonQueryFunction<boolean, boolean>`
// （宽泛型，见 db.ts:15/17–27 与 index.d.ts:575 对泛型函数取 ReturnType 的语义）。故适配器入参即取该**公开泛型**
// 宽类型，不把工厂强断言成 false/false。运行模式改由**本适配器在 transaction 调用处显式固定**：
// `arrayMode:false`、`fullResults:false`，并保留调用者传入的 ReadCommitted。
//
// 依据（只读实测，路径行号为安装包内实测，见报告）：
//   - index.d.ts:884 transaction(queriesOrFn, opts?: HTTPTransactionOptions)：builder 形参为
//     NeonQueryFunctionInTransaction，返回 NeonQueryInTransaction[]；opts 含 isolationLevel?: 'ReadCommitted'
//     （:479）、arrayMode?: ArrayMode（:437）、fullResults?: FullResults（:447）；:1118 QueryRows<false>
//     = Record<string,any>[]（false 模式下逐语句行对象数组）。
//   - index.mjs:1280 若首个实参是函数即以其自身（neon 函数）为参数调用；:1281 逐条要求
//     instanceof NeonQueryPromise 再读 .queryData/.opts；:1284-1285、:1290 从 opts 读 arrayMode/fullResults/
//     isolationLevel 并落批头 ⇒ 传给 transaction 的选项真的落到底层。
//   - 因此内核标签语句（tx`` 的产物）在运行期正是驱动要求的 NeonQueryPromise，可原样透传。
//
// 为何需要适配而非纯类型桥接：内核 CapacityStatement = unknown（opaque），驱动 builder 必须返回
// NeonQueryInTransaction[]，`unknown[]` 不可赋给 `NeonQueryInTransaction[]`。这里只做**最小**适配：
// 一次局部断言（非双重 unknown 强转），其正确性由上面的实现源证据保证（语句对象即驱动可消费的句柄）。

import type { NeonQueryFunction, NeonQueryFunctionInTransaction, NeonQueryInTransaction } from '@neondatabase/serverless';
import type { CapacitySql } from './artifact-capacity';

/** 现有工厂 getSql 的公开返回宽类型（= `ReturnType<typeof neon>`），不预设结果模式。 */
export type NeonCapacityClient = NeonQueryFunction<boolean, boolean>;

/**
 * 由调用者注入的既有客户端构造 CapacitySql 端口：不新建连接、不读 env。
 * 标签原样转发；事务批在**调用处显式固定** `arrayMode:false`、`fullResults:false`，并透传调用者传入的
 * ReadCommitted 隔离选项——保持有序非交互惰性批；不逐条 await、不 Promise.all、不吞错、不重试、不加探针。
 */
export function capacitySqlFromNeon(client: NeonCapacityClient): CapacitySql {
  const capacityTag = (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown> =>
    client(strings, ...params);

  const transaction: CapacitySql['transaction'] = (build, options) =>
    // 显式 <false, false> 固定逐语句结果为行对象数组，与内核 batchRows 取第 2 句行数组一致；
    // 选项对象把两项 false 放在展开之后，避免被覆盖。运行期驱动以 neon 函数本身作为 builder 参数
    // （index.mjs:1280），故此处 tx 即真实客户端，内核 tx`` 产出的语句就是驱动可消费的句柄。
    client.transaction<false, false>(
      (tx: NeonQueryFunctionInTransaction<false, false>) =>
        build(tx) as NeonQueryInTransaction[],
      { ...options, arrayMode: false, fullResults: false },
    );

  return Object.assign(capacityTag, { transaction });
}

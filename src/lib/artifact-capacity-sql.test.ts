// capacity948 边界草稿：只 mock **客户端边界**，消费**真实** artifact-capacity-sql.ts
// （不 mock 适配器本身）。合成客户端以**公开宽类型**声明（= 现有工厂 getSql 的返回类型
// `NeonQueryFunction<boolean, boolean>`），据此检查宽类型可直接注入、无需把工厂断言成 false/false。
// 断言事务只发起一次、语句不提前执行、顺序与参数保留、底层实际收到 arrayMode/fullResults 两项 false
// 与 ReadCommitted、返回与异常保持原样、错误失败关闭且不重试；并用真实内核一个入口穿过适配器到边界。
//
// 本文件为静态草稿，未在本次任务中执行（禁跑测试）。

import { describe, expect, it } from 'vitest';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { capacitySqlFromNeon } from './artifact-capacity-sql';
import {
  CAPACITY_REQUIRED_ISOLATION, reserveCapacityAndPath, type CapacitySql, type CapacityTx,
} from './artifact-capacity';

type Row = Record<string, unknown>;

interface Stmt { queryData: { strings: TemplateStringsArray; params: unknown[] } }
interface Received { statements: Stmt[]; options: { arrayMode?: boolean; fullResults?: boolean; isolationLevel?: string } }

/**
 * 客户端边界桩：模仿真实驱动结构（index.mjs:1278-1281）——
 * 标签调用即**构造**带 queryData 的句柄（不执行）；transaction 以自身标签为 builder 参数调用之，
 * 逐条执行 respond 并返回逐语句结果数组。respond 只在 transaction 内运行，用于证明“未提前执行”。
 */
function boundary(respond: (index: number, stmt: Stmt) => Row[]) {
  const constructed: Stmt[] = [];
  const batches: Received[] = [];
  const tag = (strings: TemplateStringsArray, ...params: unknown[]): Stmt => {
    const stmt = { queryData: { strings, params } };
    constructed.push(stmt);
    return stmt;
  };
  const transaction = async (buildOrArray: unknown, options: Received['options']) => {
    const statements = (typeof buildOrArray === 'function'
      ? (buildOrArray as (t: typeof tag) => Stmt[])(tag)
      : buildOrArray) as Stmt[];
    batches.push({ statements, options });
    return statements.map((stmt, index) => respond(index, stmt));
  };
  const client = Object.assign(tag, { transaction });
  // 边界断言：桩缺 NeonQueryFunction 的 query/unsafe 成员，仅顶替真实客户端边界。
  // 注意此处声明的即为**公开宽类型**（非 false/false）——证明既有工厂返回类型可直接注入。
  return { client: client as unknown as NeonQueryFunction<boolean, boolean>, constructed, batches };
}

const binding = {
  requestKey: 'req-1', labeledBookId: 1, identityKey: 'id-a', blobSha: 'a'.repeat(40),
  repositoryId: 1, branch: 'release/a', canonicalPath: 'books/x.txt', logicalBytes: BigInt(60),
};
const lease = { taskId: 7, owner: 'service-100', generation: 3 };
const input = { binding, lease, accountingEpoch: 'epoch-1', admissionVersion: 'adm-1' };

describe('capacitySqlFromNeon adapter boundary', () => {
  it('forwards one ordered batch, fixes arrayMode/fullResults false on the underlying call, keeps ReadCommitted', async () => {
    const stub = boundary(() => []);
    const port = capacitySqlFromNeon(stub.client);
    const results = await port.transaction(
      (tx: CapacityTx) => [tx`SELECT ${1} AS n`, tx`SELECT ${'a'} AS s`],
      CAPACITY_REQUIRED_ISOLATION,
    );
    expect(stub.batches).toHaveLength(1);                        // 只发起一次事务批
    const received = stub.batches[0].options;
    expect(received.arrayMode).toBe(false);                      // 底层实际收到 arrayMode:false
    expect(received.fullResults).toBe(false);                    // 底层实际收到 fullResults:false
    expect(received.isolationLevel).toBe('ReadCommitted');       // 调用者传入的隔离保留（不再要求同引用）
    expect(results).toEqual([[], []]);
    expect(stub.batches[0].statements).toHaveLength(2);
    expect(stub.batches[0].statements[0].queryData.params).toEqual([1]);   // 参数与顺序保留
    expect(stub.batches[0].statements[1].queryData.params).toEqual(['a']);
  });

  it('does not execute a statement until it is placed in a transaction batch', () => {
    const stub = boundary(() => { throw new Error('must not execute'); });
    const port = capacitySqlFromNeon(stub.client);
    port`SELECT ${1}`;                                          // 仅构造，未进批、未执行
    expect(stub.constructed).toHaveLength(1);                   // 句柄确已构造
    expect(stub.batches).toHaveLength(0);                       // 未发起事务、未执行
  });

  it('returns driver results per statement and preserves their order', async () => {
    const stub = boundary((index) => (index === 0 ? [{ n: 1 }] : [{ n: 2 }, { n: 3 }]));
    const port = capacitySqlFromNeon(stub.client);
    const results = await port.transaction(
      (tx: CapacityTx) => [tx`SELECT ${1}`, tx`SELECT ${2}`],
      CAPACITY_REQUIRED_ISOLATION,
    );
    expect(results).toEqual([[{ n: 1 }], [{ n: 2 }, { n: 3 }]]);
  });

  it('propagates a driver error unchanged, fails closed and does not retry', async () => {
    const boom = Object.assign(new Error('pg'), { code: '23505', constraint: 'artifact_capacity_path_active_idx' });
    const stub = boundary(() => { throw boom; });
    const port = capacitySqlFromNeon(stub.client);
    await expect(port.transaction((tx: CapacityTx) => [tx`SELECT ${1}`], CAPACITY_REQUIRED_ISOLATION))
      .rejects.toBe(boom);                                      // 原样抛出，未被吞或改写
    expect(stub.batches).toHaveLength(1);                       // 失败不重试
  });

  it('routes a real kernel entry through the adapter to the boundary (lock first, false modes + ReadCommitted passed)', async () => {
    const stub = boundary((index) => (index === 0 ? [] : [{ status: 'reserved', atomic_ok: 1, reservation_id: 42 }]));
    const port: CapacitySql = capacitySqlFromNeon(stub.client);
    await expect(reserveCapacityAndPath(port, input)).resolves.toEqual({ status: 'reserved', reservationId: 42 });
    expect(stub.batches).toHaveLength(1);
    expect(stub.batches[0].options.arrayMode).toBe(false);
    expect(stub.batches[0].options.fullResults).toBe(false);
    expect(stub.batches[0].options.isolationLevel).toBe('ReadCommitted');
    expect(stub.batches[0].statements).toHaveLength(2);         // 首句锁 + 正文
    expect(stub.batches[0].statements[0].queryData.strings.join('')).toContain('pg_advisory_xact_lock');
  });
});

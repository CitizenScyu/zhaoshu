// capacity952 边界草稿 ＋ capacity953 六项定点修复 ＋ capacity954 A/B 两处残余及 lockedge 账→仓依赖修复对应的边界/结构断言。
// 只 mock **SQL 边界**与**受信来源边界**，消费**真实入口** reconcileInitialization（不 mock 入口本身）。
//
// 诚实边界（F7 收窄）：SQL 内部的条件门（零 DML、条件 INSERT/UPDATE、锁序、proof 不变量、回滚）**不能靠 mock
// 自证已执行**——mock 只返回被断言的行形状。本文件证明的是**入口契约**：端口消费、私有快照冻结、原始身份/目标/
// 引用核验、参数装配、状态解析与异常透传；涉及 SQL 语义的项仅作**结构断言**（文本存在关键构造），不声称数据库已运行。
//
// 本文件为静态草稿，未在本次任务中执行（禁跑测试）。

import { describe, expect, it } from 'vitest';
import type { CapacitySql } from './artifact-capacity';
import {
  reconcileInitialization,
  type CurrentActivation,
  type OriginalVerification,
  type ReconciliationSource,
  type ReconcileInput,
  type VerifiedOriginalIdentity,
} from './artifact-capacity-reconcile';

interface Stmt { queryData: { strings: TemplateStringsArray; params: unknown[] } }
interface Batch { statements: Stmt[]; options: unknown }

/** SQL 边界桩：标签调用即构造句柄（不执行）；transaction 逐条执行 respond 并返回逐语句结果数组。 */
function sqlBoundary(respond: (index: number, stmt: Stmt) => unknown[]) {
  const batches: Batch[] = [];
  const tag = (strings: TemplateStringsArray, ...params: unknown[]): Stmt => ({ queryData: { strings, params } });
  const transaction = async (buildOrArray: unknown, options: unknown): Promise<unknown[]> => {
    const statements = (typeof buildOrArray === 'function'
      ? (buildOrArray as (t: typeof tag) => Stmt[])(tag)
      : buildOrArray) as Stmt[];
    batches.push({ statements, options });
    return statements.map((stmt, index) => respond(index, stmt));
  };
  return { port: Object.assign(tag, { transaction }) as unknown as CapacitySql, batches };
}

/** 受信来源桩：直接以给定原始身份结果与当前激活许可调用 work（真实入口消费其返回值）。 */
function source(original: OriginalVerification, activation: CurrentActivation): ReconciliationSource {
  return { reconcile: async (_input, work) => work(original, activation) };
}

const target = { repositoryId: 11, branch: 'release/a' };
const raw = { reconciliationVersion: 'v1', occupancyProofRef: 'proof-1', barrierRef: 'bar-1', admissionRef: 'adm-1' };

function original(over: Partial<VerifiedOriginalIdentity> = {}): VerifiedOriginalIdentity {
  return {
    repositoryId: 11, branch: 'release/a', logicalTxtScope: 'txt/v1',
    targetBytes: 1_000_000n, registeredBytes: 0n, activeReservations: [],
    reconciliationVersion: 'v1', occupancyProofDigest: 'sha:abc',
    admissionBinding: { version: 'adm-1', target: { repositoryId: 11, branch: 'release/a' } },
    barrierRef: 'bar-1', fingerprint: 'fp-raw-1',
    ...over,
  };
}
const granted: CurrentActivation = {
  status: 'granted',
  admission: { version: 'adm-1', validUntil: '2099-01-01T00:00:00Z', target: { repositoryId: 11, branch: 'release/a' } },
};

const text = (b: Batch): string => b.statements[1].queryData.strings.join('');
const params = (b: Batch): unknown[] => b.statements[1].queryData.params;

describe('reconcileInitialization (first activation / ready idempotency)', () => {
  it('V1: valid empty-repo activation issues one ordered batch and a conditional ready insert', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'initialized', atomic_ok: 1 }]));
    const res = await reconcileInitialization(stub.port, source({ status: 'verified', original: original() }, granted), { target, raw });
    expect(res).toEqual({ status: 'initialized' });
    expect(stub.batches).toHaveLength(1);
    const b = stub.batches[0];
    expect(b.statements).toHaveLength(2);
    expect(b.statements[0].queryData.strings.join('')).toContain('pg_advisory_xact_lock');
    expect((b.options as { isolationLevel?: string }).isolationLevel).toBe('ReadCommitted');
    expect(text(b)).toContain('INSERT INTO repository_capacity_ledger');
    expect(text(b)).toContain('NOT g.ledger_exists');              // 条件 INSERT（账不存在）
    expect(text(b)).not.toMatch(/SET state = 'uninitialized'/);    // 无 seed 中间态
    const p = params(b);
    expect(p).toContain('fp-raw-1');                               // 受信身份指纹
    expect(p).toContain('1000000');                                // targetBytes（bigint 字符串）
    expect(p).toContain('0');                                      // registered=0（空仓）
    expect(p).toContain('adm-1');                                  // 受信准入版本
    expect(p).toContain('2099-01-01T00:00:00Z');                   // 受信准入有效期
    expect(p).toContain(true);                                     // input_active_empty=true
  });

  it('V2: writes the verified registered total verbatim (no re-summing; unregistered books counted once by the port)', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'initialized', atomic_ok: 1 }]));
    await reconcileInitialization(
      stub.port, source({ status: 'verified', original: original({ registeredBytes: 12345n }) }, granted), { target, raw },
    );
    expect(params(stub.batches[0])).toContain('12345');
    expect(text(stub.batches[0])).not.toMatch(/registered_bytes\s*\+/);   // 入口不做累加
  });

  it('V3: missing source / incomplete occupancy / wrong target reject before any SQL (zero write)', async () => {
    const stub = sqlBoundary(() => { throw new Error('must not run SQL'); });
    expect(await reconcileInitialization(stub.port, source({ status: 'no_authoritative_source' }, granted), { target, raw }))
      .toEqual({ status: 'no_authoritative_source' });
    expect(await reconcileInitialization(stub.port, source({ status: 'incomplete_occupancy' }, granted), { target, raw }))
      .toEqual({ status: 'incomplete_occupancy' });
    expect(await reconcileInitialization(
      stub.port, source({ status: 'verified', original: original({ repositoryId: 99 }) }, granted), { target, raw },
    )).toEqual({ status: 'binding_conflict' });                    // 原始身份与目标不符
    expect(stub.batches).toHaveLength(0);                          // 全部零写、未发 SQL
  });

  it('V3b: missing controlled source fails closed (throws), no SQL', async () => {
    const stub = sqlBoundary(() => { throw new Error('must not run SQL'); });
    await expect(reconcileInitialization(stub.port, null, { target, raw }))
      .rejects.toMatchObject({ code: 'TRANSACTION_PORT_UNAVAILABLE' });
  });

  // F4：当前许可/屏障拒绝只否决首次激活；ready 同身份零写不受影响。当前许可目标错绑不再入口提前返回。
  it('F4: current admission/barrier denial rejects first activation but never affects ready same-identity', async () => {
    const stub1 = sqlBoundary(i => (i === 0 ? [] : [{ status: 'admission_invalid', atomic_ok: 1 }]));
    expect(await reconcileInitialization(
      stub1.port, source({ status: 'verified', original: original() }, { status: 'admission_invalid' }), { target, raw },
    )).toEqual({ status: 'admission_invalid' });
    const stub2 = sqlBoundary(i => (i === 0 ? [] : [{ status: 'already_initialized', atomic_ok: 1 }]));
    expect(await reconcileInitialization(
      stub2.port, source({ status: 'verified', original: original() }, { status: 'quiescence_unproven' }), { target, raw },
    )).toEqual({ status: 'already_initialized' });                 // ready 同身份不受当前屏障失败影响
    expect(params(stub2.batches[0])).toContain('quiescence_unproven');
    // 结构断言：ready 分支只比身份（不入仓可写/准入门）；F4 运行时优先级由 SQL 分支承载，mock 不证明执行。
    const ready = text(stub2.batches[0]);
    expect(ready).toContain("existing_state = 'ready' AND identity_match THEN 'already_initialized'");
    expect(ready).toContain("existing_state = 'ready' THEN 'binding_conflict'");
  });

  it('F4b: granted current admission bound to a different target becomes a first-activation input, not an entry-level return', async () => {
    // 源给 granted 但其目标错绑（99/other）。入口不直接返回，交给 SQL 作首次激活拒绝输入。
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'admission_invalid', atomic_ok: 1 }]));
    const wrongAdm: CurrentActivation = {
      status: 'granted',
      admission: { version: 'adm-x', validUntil: '2099-01-01T00:00:00Z', target: { repositoryId: 99, branch: 'other' } },
    };
    expect(await reconcileInitialization(
      stub.port, source({ status: 'verified', original: original() }, wrongAdm), { target, raw },
    )).toEqual({ status: 'admission_invalid' });
    expect(stub.batches).toHaveLength(1);                          // 进入了 SQL（非入口提前返回）
    expect(params(stub.batches[0])).toContain(false);              // activation_target_ok=false
  });

  // F1：非法/过期许可为首次 admission_invalid；SQL 门用 clock_timestamp（非事务起点 now）核期限。
  it('F1: illegal admission time normalizes to admission_invalid; SQL gates validity on clock_timestamp, not now', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'admission_invalid', atomic_ok: 1 }]));
    const badTime: CurrentActivation = {
      status: 'granted',
      admission: { version: 'adm-1', validUntil: 'not-a-time', target: { repositoryId: 11, branch: 'release/a' } },
    };
    expect(await reconcileInitialization(
      stub.port, source({ status: 'verified', original: original() }, badTime), { target, raw },
    )).toEqual({ status: 'admission_invalid' });
    const sql = text(stub.batches[0]);
    expect(sql).toContain('clock_timestamp()');                    // 真实时钟求值
    expect(sql).toContain('admission_time_ok');                    // 期限谓词落在首次激活门
    // 954 B：两次插值各自显式定型 timestamptz（空值检测不再依赖后一次 cast 定型）。
    expect(sql).toContain('::timestamptz IS NOT NULL AND ::timestamptz > clock_timestamp()');
  });

  // 954 B：当前许可为 null（首次 admission_invalid）也须 SQL 可解析，且 ready 同身份仍幂等零写。
  it('954B: null current license is SQL-parseable and ready same-identity still returns already_initialized', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'already_initialized', atomic_ok: 1 }]));
    // 端口给当前许可拒绝：入口把 validUntil 规范化为 null 传入 SQL（activation_granted=false）。
    expect(await reconcileInitialization(
      stub.port, source({ status: 'verified', original: original() }, { status: 'admission_invalid' }), { target, raw },
    )).toEqual({ status: 'already_initialized' });
    const p = params(stub.batches[0]);
    expect(p).toContain(null);                                     // 许可版本/期限为 null 参数
    expect(params(stub.batches[0]).some(v => v === false)).toBe(true);  // activation_granted=false
  });

  // F2：旧 uninitialized 须核旧 target/目标绑定；结构断言 SQL 比较旧 target。
  it('F2: legacy uninitialized with drifted target/binding conflicts; SQL compares the stored target', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'binding_conflict', atomic_ok: 1 }]));
    expect(await reconcileInitialization(
      stub.port, source({ status: 'verified', original: original() }, granted), { target, raw },
    )).toEqual({ status: 'binding_conflict' });
    const sql = text(stub.batches[0]);
    expect(sql).toContain('old_target_bytes = ');                  // 核实际旧 target，不无条件覆盖
    expect(sql).toContain('old_admission_target IS NULL');
    expect(sql).toContain('OR old_admission_target = jsonb_build_object');
  });

  // F3：实际锁依赖链（账锁 → stage → repo_lock(仓行 FOR UPDATE) → 活动/时钟）。结构断言，不证明取锁已执行。
  it('F3: SQL chains ledger lock → stage → repo_lock → activity (structural only)', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'initialized', atomic_ok: 1 }]));
    await reconcileInitialization(stub.port, source({ status: 'verified', original: original() }, granted), { target, raw });
    const sql = text(stub.batches[0]);
    expect(sql).toMatch(/FROM repository_capacity_ledger l[\s\S]*FOR UPDATE/);            // 账行锁
    expect(sql).toMatch(/repo_lock AS MATERIALIZED[\s\S]*JOIN storage_repositories r[\s\S]*FOR UPDATE OF r/); // 仓行锁
    expect(sql).toContain('FROM stage s');                                                  // 账阶段一行输出
    expect(sql).toContain('ledger_exists');                                                // 账不存在仍保留状态
  });

  // 954 A：空活动集合不能使 gate 时钟先于仓锁完成——结构断言 gate 行来源含仓锁完成结果、时钟为 gate 投影。
  it('954A: gate rows depend on the lock-completed repo_lock so empty activity cannot bypass the repo lock (structural only)', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'initialized', atomic_ok: 1 }]));
    await reconcileInitialization(stub.port, source({ status: 'verified', original: original() }, granted), { target, raw });
    const sql = text(stub.batches[0]);
    expect(sql).toMatch(/gate AS MATERIALIZED[\s\S]*FROM stage s LEFT JOIN repo_lock rl/);   // 完成结果为真实行来源
    expect(sql).toMatch(/gate AS MATERIALIZED[\s\S]*clock_timestamp\(\)/);                   // 时钟在完成结果之后取
  });

  // 954 lockedge：repo_lock 以 stage 为**驱动行来源**（消费 s.ledger_exists），使账阶段成为仓锁的强制性前驱。
  it('954lockedge: repo_lock consumes stage, forcing the ledger stage before the repository lock (structural only)', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'initialized', atomic_ok: 1 }]));
    await reconcileInitialization(stub.port, source({ status: 'verified', original: original() }, granted), { target, raw });
    const sql = text(stub.batches[0]);
    // 依赖证据：repo_lock 的 SELECT 消费了 stage 的列 → stage（进而 existing 的 FOR UPDATE）必须先完成。
    expect(sql).toMatch(/repo_lock AS MATERIALIZED[\s\S]*SELECT s\.ledger_exists AS ledger_exists, r\.id AS repo_id\s*FROM stage s/);
    // 反例防护：不得再出现“只读仓表、不引用 stage”的独立仓锁分支。
    expect(sql).not.toMatch(/repo_lock AS MATERIALIZED\s*\(\s*SELECT r\.id\s+FROM storage_repositories r\s+WHERE/);
  });

  it('V5: same-identity retry is zero-write regardless of DB activity/counts; different identity conflicts', async () => {
    // 原始元组**不变**（含 fingerprint）；激活后的活动/计数是 DB 状态，不由入口传入、不参与身份。
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'already_initialized', atomic_ok: 1 }]));
    expect(await reconcileInitialization(stub.port, source({ status: 'verified', original: original() }, granted), { target, raw }))
      .toEqual({ status: 'already_initialized' });
    const stub2 = sqlBoundary(i => (i === 0 ? [] : [{ status: 'binding_conflict', atomic_ok: 1 }]));
    expect(await reconcileInitialization(
      stub2.port, source({ status: 'verified', original: original({ fingerprint: 'fp-v2' }) }, granted), { target, raw },
    )).toEqual({ status: 'binding_conflict' });                    // 原始版本/快照/容量变即异身份
  });

  it('V6: first activation with reserved or uncertain activity rejects; SQL checks activity in the lock window', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'active_reservations_present', atomic_ok: 1 }]));
    expect(await reconcileInitialization(stub.port, source({ status: 'verified', original: original() }, granted), { target, raw }))
      .toEqual({ status: 'active_reservations_present' });
    const sql = text(stub.batches[0]);
    expect(sql).toMatch(/state IN \('reserved','uncertain'\)/);
    expect(sql).toContain('NOT g.ledger_exists');                  // 活动门为首次激活门
  });

  it('V7: SQL exception is rethrown as-is, no retry, no read-failed-batch result', async () => {
    const boom = Object.assign(new Error('division by zero'), { code: '22012' });
    const stub = sqlBoundary(i => { if (i === 1) throw boom; return []; });
    await expect(reconcileInitialization(
      stub.port, source({ status: 'verified', original: original() }, granted), { target, raw },
    )).rejects.toBe(boom);
    expect(stub.batches).toHaveLength(1);                          // 不重试、不补查询
  });

  // F6：最终 proof 独立不变量。结构断言 SQL 含“状态↔RETURNING 计数一致”分母（mock 不证明执行）。
  it('F6: final proof independently enforces status vs RETURNING counts (structural only)', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'initialized', atomic_ok: 1 }]));
    await reconcileInitialization(stub.port, source({ status: 'verified', original: original() }, granted), { target, raw });
    const sql = text(stub.batches[0]);
    expect(sql).toContain('write_invariant_ok');
    expect(sql).toContain('1 / CASE WHEN write_invariant_ok THEN 1 ELSE 0 END');
    expect(sql).toMatch(/WHEN status = 'initialized' THEN\s*\(CASE WHEN ledger_exists THEN \(update_ok = 1 AND insert_ok = 0\)/);
    expect(sql).toContain('ELSE (update_ok = 0 AND insert_ok = 0)');
  });

  // F5：交给端口的是独立且运行时冻结的副本；改动它不能漂移 SQL 使用的私有请求快照。
  it('F5: port receives its own frozen copies; mutating them cannot drift the SQL target', async () => {
    const stub = sqlBoundary(i => (i === 0 ? [] : [{ status: 'initialized', atomic_ok: 1 }]));
    let inputFrozen = false;
    let seenRepo = 0;
    const src: ReconciliationSource = {
      reconcile: async (input, work) => {
        inputFrozen = Object.isFrozen(input) && Object.isFrozen(input.target) && Object.isFrozen(input.raw);
        // 尝试把端口收到的目标漂移到 22/B：冻结副本应拒绝（严格模式下抛 TypeError）。
        try { (input.target as { repositoryId: number }).repositoryId = 22; } catch { /* frozen */ }
        seenRepo = input.target.repositoryId;
        return work({ status: 'verified', original: original() }, granted);
      },
    };
    expect(await reconcileInitialization(stub.port, src, { target, raw })).toEqual({ status: 'initialized' });
    expect(inputFrozen).toBe(true);
    expect(seenRepo).toBe(11);                                     // 端口侧未被改写
    const p = params(stub.batches[0]);
    expect(p).toContain(11);
    expect(p).not.toContain(22);
  });

  it('F5b: a port returning an identity bound to a different target/raw is rejected without request drift (no SQL)', async () => {
    const stub = sqlBoundary(() => { throw new Error('must not run SQL'); });
    const src: ReconciliationSource = {
      reconcile: async (_input, work) => work({ status: 'verified', original: original({ repositoryId: 22, branch: 'B' }) }, granted),
    };
    expect(await reconcileInitialization(stub.port, src, { target, raw })).toEqual({ status: 'binding_conflict' });
    expect(stub.batches).toHaveLength(0);
  });

  it('F5c: original version/barrier must bind to the request raw reference (else binding_conflict, no SQL)', async () => {
    const stub = sqlBoundary(() => { throw new Error('must not run SQL'); });
    const src: ReconciliationSource = {
      reconcile: async (_input, work) => work({ status: 'verified', original: original({ reconciliationVersion: 'v2' }) }, granted),
    };
    expect(await reconcileInitialization(stub.port, src, { target, raw })).toEqual({ status: 'binding_conflict' });
    expect(stub.batches).toHaveLength(0);
  });
});

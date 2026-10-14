// 合成 PGlite 用例：host-occupancy 的物理互斥/续期/释放与两阶段门语义（无真实网络与环境值，不在此运行）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostOccupancy, HostOccupiedError } from './host-occupancy';
import type { HostOccupancySql } from './host-occupancy';
import { loadPGlite, type PGliteLike } from './testing/pglite';
import { createPGliteSql } from '../src/lib/fixtures/pglite-sql';
import type { SourceTransport } from './engine';

const PGliteCtor = await loadPGlite();
const maybe = PGliteCtor ? describe : describe.skip;

const TTL = { downloadTtlMs: 60_000, scanTtlMs: 30_000 };

interface Emissions { count: number; urls: string[] }

interface FakePlan {
  redirects?: string[];
  emissions?: Emissions;
  onEmit?: (url: string) => void | Promise<void>;
}

// 单门序列（engine 无 limiter 时 afterAcquire 紧随 callerGate）：初始/302/换 host 每跳
// 都先过 beforeFetch 与 afterAcquire 两道门再发射，跳转路径同样走双门。
function fakeTransport(plan: FakePlan = {}): SourceTransport {
  return async (url, options) => {
    const { signal, beforeFetch, afterAcquire } = options;
    let current = url;
    const redirects = [...(plan.redirects ?? [])];
    for (;;) {
      signal.throwIfAborted();
      await beforeFetch?.(signal, current);
      await afterAcquire?.(signal, current);
      signal.throwIfAborted();
      if (plan.emissions) { plan.emissions.count += 1; plan.emissions.urls.push(current); }
      await plan.onEmit?.(current);
      const location = redirects.shift();
      if (location === undefined) return { url: current, text: 'ok' };
      current = location;
    }
  };
}

interface TwoPhasePlan {
  emissions?: Emissions;
  /** limiter.acquire 的等待段：在 afterAcquire 之前执行，模拟限速排队。 */
  duringWait?: () => void | Promise<void>;
  onEmit?: (url: string) => void | Promise<void>;
}

// 两阶段门形状（engine 的调用序）：beforeFetch(callerGate→occupy) → limiter 排队
// → afterAcquire(occupy 复查) → 查 abort → 发射。与「acquire 后 await afterAcquire，再由
// source-fetch 查 abort 并发 HTTP」的合同一致。
function twoPhaseTransport(plan: TwoPhasePlan = {}): SourceTransport {
  return async (url, options) => {
    const { signal, beforeFetch, afterAcquire } = options;
    signal.throwIfAborted();
    await beforeFetch?.(signal, url);
    await plan.duringWait?.();
    await afterAcquire?.(signal, url);
    signal.throwIfAborted();
    if (plan.emissions) { plan.emissions.count += 1; plan.emissions.urls.push(url); }
    await plan.onEmit?.(url);
    return { url, text: 'ok' };
  };
}

const freshSignal = () => new AbortController().signal;

const rows = async (pg: PGliteLike, text: string) => (await pg.query(text)).rows;

maybe('host occupancy：下载/预扫的物理 host 互斥', () => {
  let pg: PGliteLike;
  let sql: HostOccupancySql;

  beforeEach(async () => {
    pg = new PGliteCtor!();
    sql = createPGliteSql(pg) as unknown as HostOccupancySql;
    await pg.exec(`
      CREATE TABLE download_host_occupancy (
        host text PRIMARY KEY, holder text NOT NULL, kind text NOT NULL,
        task_id integer, claimed_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  });

  afterEach(async () => { await pg.close(); });

  it('scan 与 download 互斥：未过期 download 拒 scan 且 0 HTTP，download 也不能抢未过期 prefetch', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const downloadEmissions: Emissions = { count: 0, urls: [] };
    const scanEmissions: Emissions = { count: 0, urls: [] };
    let releaseDownload!: () => void;
    let confirmOccupied!: () => void;
    const hold = new Promise<void>(resolve => { releaseDownload = resolve; });
    // 首跳两门已过、DB 已见占位行后才启动 scan，消除竞态。
    const occupied = new Promise<void>(resolve => { confirmOccupied = resolve; });
    const download = occ.runDownload(7, freshSignal(), async () => {
      await occ.wrapTransport(twoPhaseTransport({
        emissions: downloadEmissions,
        onEmit: () => { confirmOccupied(); },
      }))('https://a.test/book', { signal: freshSignal() });
      await hold;
      return 'downloaded';
    });
    await occupied;
    expect(await rows(pg, `SELECT kind, task_id, expires_at > now() AS active
      FROM download_host_occupancy WHERE host = 'a.test'`))
      .toEqual([{ kind: 'download', task_id: 7, active: true }]);
    const scan = occ.wrapTransport(twoPhaseTransport({ emissions: scanEmissions }));
    await expect(scan('https://a.test/other', { signal: freshSignal() }))
      .rejects.toMatchObject({ code: 'HOST_OCCUPIED' });
    expect(scanEmissions.count).toBe(0);

    await pg.query(`INSERT INTO download_host_occupancy(host, holder, kind, task_id, expires_at)
      VALUES ('b.test', 'other-scan', 'prefetch', NULL, now() + interval '1 minute')`);
    await expect(occ.runDownload(8, freshSignal(), () =>
      occ.wrapTransport(twoPhaseTransport({}))('https://b.test/x', { signal: freshSignal() })))
      .rejects.toBeInstanceOf(HostOccupiedError);
    // 被拒的 download 零写：他 holder 的行原样保留
    expect(await rows(pg, `SELECT holder, kind FROM download_host_occupancy WHERE host = 'b.test'`))
      .toEqual([{ holder: 'other-scan', kind: 'prefetch' }]);

    releaseDownload();
    await expect(download).resolves.toBe('downloaded');
    expect(downloadEmissions.count).toBe(1);
    // a.test 已释放；人工插入的 b.test（1 分钟未过期）应保留，不能断全表空。
    expect(await rows(pg, `SELECT host, holder, kind FROM download_host_occupancy ORDER BY host`))
      .toEqual([{ host: 'b.test', holder: 'other-scan', kind: 'prefetch' }]);
  });

  it('下载释放后该 host 可参与扫描', async () => {
    const occ = createHostOccupancy(sql, TTL);
    await occ.runDownload(1, freshSignal(), () =>
      occ.wrapTransport(twoPhaseTransport({}))('https://a.test/b', { signal: freshSignal() }));
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);
    const emissions: Emissions = { count: 0, urls: [] };
    await occ.wrapTransport(twoPhaseTransport({ emissions }))('https://a.test/b', { signal: freshSignal() });
    expect(emissions.count).toBe(1);
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);
  });

  it('下载作用域覆盖多物理 host（初始/302/换 host），结束后全释放', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const midFlight: Record<string, unknown>[] = [];
    let fires = 0;
    await occ.runDownload(7, freshSignal(), () =>
      occ.wrapTransport(fakeTransport({
        redirects: ['https://jump.test/landing', 'https://final.test/book'],
        onEmit: async () => {
          fires += 1;
          if (fires === 3) midFlight.push(
            ...(await rows(pg, `SELECT host, kind, task_id, expires_at > now() AS active FROM download_host_occupancy ORDER BY host`)) as Record<string, unknown>[]);
        },
      }))('https://start.test/book', { signal: freshSignal() }));
    expect(midFlight).toEqual([
      { host: 'final.test', kind: 'download', task_id: 7, active: true },
      { host: 'jump.test', kind: 'download', task_id: 7, active: true },
      { host: 'start.test', kind: 'download', task_id: 7, active: true },
    ]);
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);
  });

  it('独立 scan 作用域：kind=prefetch、task_id NULL，请求结束释放全部物理 host', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const mid: Record<string, unknown>[] = [];
    let fires = 0;
    const scan = occ.wrapTransport(fakeTransport({
      redirects: ['https://s2.test/q'],
      onEmit: async () => {
        fires += 1;
        if (fires === 2) mid.push(
          ...(await rows(pg, `SELECT host, kind, task_id, expires_at > now() AS active FROM download_host_occupancy ORDER BY host`)) as Record<string, unknown>[]);
      },
    }));
    await scan('https://s1.test/q', { signal: freshSignal() });
    expect(mid).toEqual([
      { host: 's1.test', kind: 'prefetch', task_id: null, active: true },
      { host: 's2.test', kind: 'prefetch', task_id: null, active: true },
    ]);
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);
  });

  it('两阶段门同 holder 幂等：callerGate 只执行一次，两门后仍单行且续期', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const emissions: Emissions = { count: 0, urls: [] };
    let callerGateRuns = 0;
    let midLease: { renewed: boolean }[] = [];
    const transport = occ.wrapTransport(twoPhaseTransport({
      emissions,
      duringWait: async () => {
        await pg.query(`UPDATE download_host_occupancy
          SET expires_at = now() + interval '1 second' WHERE host = 'a.test'`);
        expect(await rows(pg, `SELECT expires_at < now() + interval '2 seconds' AS shortened
          FROM download_host_occupancy WHERE host = 'a.test'`)).toEqual([{ shortened: true }]);
      },
      onEmit: async () => {
        midLease = (await rows(pg, `SELECT expires_at > now() + interval '20 seconds' AS renewed
          FROM download_host_occupancy WHERE host = 'a.test'`)) as { renewed: boolean }[];
      },
    }));
    await transport('https://a.test/x', {
      signal: freshSignal(),
      beforeFetch: async () => { callerGateRuns += 1; },
    });
    expect(emissions.count).toBe(1);
    expect(callerGateRuns).toBe(1);
    expect(midLease).toEqual([{ renewed: true }]);
    expect(midLease).toHaveLength(1);
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);
  });

  it('限速排队期间 gateSignal 中止：afterAcquire 二次门拒绝发射，0 HTTP', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const emissions: Emissions = { count: 0, urls: [] };
    const controller = new AbortController();
    const transport = occ.wrapTransport(twoPhaseTransport({
      emissions,
      duringWait: () => { controller.abort(new Error('limiter_wait_aborted')); },
    }));
    await expect(transport('https://w.test/x', { signal: controller.signal }))
      .rejects.toThrow('limiter_wait_aborted');
    expect(emissions.count).toBe(0);
    // 首门写入的 host 已由 scope finally 按 holder 释放
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);
  });

  it('限速排队期间租约被接管：afterAcquire 复查抛 HOST_OCCUPIED，不动新租约', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const emissions: Emissions = { count: 0, urls: [] };
    const transport = occ.wrapTransport(twoPhaseTransport({
      emissions,
      duringWait: async () => {
        await pg.query(`UPDATE download_host_occupancy SET expires_at = now() - interval '1 second' WHERE host = 'tk.test'`);
        await pg.query(`INSERT INTO download_host_occupancy(host, holder, kind, task_id, expires_at)
          VALUES ('tk.test', 'taker', 'download', 99, now() + interval '1 minute')
          ON CONFLICT (host) DO UPDATE
            SET holder = 'taker', kind = 'download', task_id = 99, expires_at = now() + interval '1 minute'`);
      },
    }));
    await expect(transport('https://tk.test/x', { signal: freshSignal() }))
      .rejects.toMatchObject({ code: 'HOST_OCCUPIED' });
    expect(emissions.count).toBe(0);
    expect(await rows(pg, `SELECT holder, task_id FROM download_host_occupancy WHERE host = 'tk.test'`))
      .toEqual([{ holder: 'taker', task_id: 99 }]);
  });

  it('调用方已有 afterAcquire：先原回调再复查，原语义保持', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const sawRow: boolean[] = [];
    const transport = occ.wrapTransport(twoPhaseTransport({
      onEmit: async () => {
        sawRow.push((await rows(pg, `SELECT 1 FROM download_host_occupancy WHERE host = 'aa.test'`)).length === 1);
      },
    }));
    await transport('https://aa.test/x', {
      signal: freshSignal(),
      afterAcquire: async () => {
        sawRow.push((await rows(pg, `SELECT 1 FROM download_host_occupancy WHERE host = 'aa.test'`)).length === 1);
      },
    });
    // 原回调先跑（首门写入已存在）、发射时仍在：[true, true]
    expect(sawRow).toEqual([true, true]);
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);
  });

  it('operation 抛错/父 signal 中止都走 finally 释放并保留原异常', async () => {
    const occ = createHostOccupancy(sql, TTL);
    await expect(occ.runDownload(4, freshSignal(), async () => {
      await occ.wrapTransport(twoPhaseTransport({}))('https://t1.test/x', { signal: freshSignal() });
      throw new Error('op_fail');
    })).rejects.toThrow('op_fail');
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);

    const controller = new AbortController();
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    await expect(occ.runDownload(5, controller.signal, async () => {
      await occ.wrapTransport(twoPhaseTransport({}))('https://t2.test/x', { signal: freshSignal() });
      controller.abort(new Error('parent_abort'));
      await aborted;
    })).rejects.toThrow('parent_abort');
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);

    // 父 signal 已中止后门不再写库（先查 signal 再 occupy）
    await expect(occ.runDownload(6, controller.signal, async () =>
      occ.wrapTransport(twoPhaseTransport({}))('https://t3.test/x', { signal: freshSignal() })))
      .rejects.toThrow('parent_abort');
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);
  });

  it('释放 DELETE 失败不升级成源站失败，残留行交 TTL 兜底', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const originalQuery = pg.query.bind(pg);
    const query = vi.spyOn(pg, 'query');
    query.mockImplementation(async (text: string, params?: unknown[]) => {
      if (/^DELETE FROM download_host_occupancy/.test(text)) throw new Error('synthetic_release_down');
      return originalQuery(text, params);
    });
    await expect(occ.runDownload(9, freshSignal(), async () => {
      await occ.wrapTransport(twoPhaseTransport({}))('https://r.test/x', { signal: freshSignal() });
      return 'ok';
    })).resolves.toBe('ok');
    expect(await rows(pg, `SELECT host FROM download_host_occupancy WHERE host = 'r.test'`)).toHaveLength(1);
    query.mockRestore();
  });

  it('occupy 数据库失败 fail-closed：包裹 HOST_OCCUPANCY_UNAVAILABLE（cause 内存保留）、0 HTTP', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const emissions: Emissions = { count: 0, urls: [] };
    const query = vi.spyOn(pg, 'query');
    query.mockRejectedValueOnce(new Error('synthetic_db_down'));
    const scan = occ.wrapTransport(twoPhaseTransport({ emissions }));
    const failure = await scan('https://d.test/x', { signal: freshSignal() }).then(
      () => undefined, (error: unknown) => error) as { code?: string; cause?: unknown };
    expect(failure?.code).toBe('HOST_OCCUPANCY_UNAVAILABLE');
    expect((failure?.cause as Error)?.message).toBe('synthetic_db_down');
    expect(emissions.count).toBe(0);
    // 门失败登记过的 host 已由 finally 兜删
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);
    query.mockRestore();
  });

  it('callerGate 先于 occupy 执行，其错误原样透传不吞', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const sawRowBeforeOccupy: boolean[] = [];
    const ordered = occ.wrapTransport(twoPhaseTransport({
      onEmit: async () => {
        sawRowBeforeOccupy.push((await rows(pg, `SELECT 1 FROM download_host_occupancy WHERE host = 'g.test'`)).length === 1);
      },
    }));
    await ordered('https://g.test/x', {
      signal: freshSignal(),
      beforeFetch: async () => {
        // callerGate 运行时 occupy 尚未发生
        sawRowBeforeOccupy.push((await rows(pg, `SELECT 1 FROM download_host_occupancy WHERE host = 'g.test'`)).length === 1);
      },
    });
    expect(sawRowBeforeOccupy).toEqual([false, true]);

    const emissions: Emissions = { count: 0, urls: [] };
    const rejecting = occ.wrapTransport(twoPhaseTransport({ emissions }));
    await expect(rejecting('https://h.test/x', {
      signal: freshSignal(),
      beforeFetch: async () => { throw new Error('caller_gate_rejected'); },
    })).rejects.toThrow('caller_gate_rejected');
    expect(emissions.count).toBe(0);
    expect(await rows(pg, `SELECT * FROM download_host_occupancy WHERE host = 'h.test'`)).toEqual([]);
  });

  it('SQL 等待期间 scope 已关闭：迟到门不复活，自行清理并报 HOST_SCOPE_CLOSED', async () => {
    const occ = createHostOccupancy(sql, TTL);
    const originalQuery = pg.query.bind(pg);
    let confirmInserted!: () => void;
    const entered = new Promise<void>(resolve => { confirmInserted = resolve; });
    let settle!: () => void;
    const held = new Promise<void>(resolve => { settle = resolve; });
    const query = vi.spyOn(pg, 'query');
    query.mockImplementation(async (text: string, params?: unknown[]) => {
      const result = await originalQuery(text, params);
      // INSERT 行已真落库、确认被扣住：此刻才放行外层关 scope，才谈得上证明迟到清理。
      if (text.includes('INSERT INTO download_host_occupancy')) {
        confirmInserted();
        await held;
      }
      return result;
    });
    let lateGate: Promise<unknown> | undefined;
    await expect(occ.runDownload(10, freshSignal(), async () => {
      lateGate = occ.wrapTransport(fakeTransport({}))('https://late.test/x', { signal: freshSignal() });
      await entered;
      return 'op_done';
    })).resolves.toBe('op_done');
    const expectation = expect(lateGate).rejects.toThrow('HOST_SCOPE_CLOSED');
    settle();
    await expectation;
    expect(await rows(pg, `SELECT * FROM download_host_occupancy WHERE host = 'late.test'`)).toEqual([]);
    query.mockRestore();
  });

  it('旧 holder 释放只删自己的租约，不动被接管的新租约', async () => {
    const occ = createHostOccupancy(sql, TTL);
    let occupiedBySecond!: () => void;
    const occupied = new Promise<void>(resolve => { occupiedBySecond = resolve; });
    let releaseSecond!: () => void;
    const hold = new Promise<void>(resolve => { releaseSecond = resolve; });
    let second: Promise<string> | undefined;
    await expect(occ.runDownload(11, freshSignal(), async () => {
      await occ.wrapTransport(twoPhaseTransport({}))('https://dual.test/x', { signal: freshSignal() });
      // 人工过期，允许第二个下载接管
      await pg.query(`UPDATE download_host_occupancy SET expires_at = now() - interval '1 second' WHERE host = 'dual.test'`);
      second = occ.runDownload(12, freshSignal(), async () => {
        await occ.wrapTransport(twoPhaseTransport({ onEmit: () => { occupiedBySecond(); } }))('https://dual.test/y', { signal: freshSignal() });
        await hold;
        return 'second';
      });
      await occupied;
      return 'first';
    })).resolves.toBe('first');
    expect(await rows(pg, `SELECT task_id FROM download_host_occupancy WHERE host = 'dual.test'`))
      .toEqual([{ task_id: 12 }]);
    releaseSecond();
    await expect(second).resolves.toBe('second');
    expect(await rows(pg, `SELECT * FROM download_host_occupancy`)).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  initializeBusinessSchema,
  BUSINESS_SCHEMA_RELATIONS,
  BUSINESS_SCHEMA_COLUMNS,
  BUSINESS_SCHEMA_RETIRED_RELATIONS,
} from './business-schema';

// 用记录器跑真实的 DDL 序列：断言的是「真的发出去了什么语句」，而不是源码里有没有那段字。
// 记录器同时区分「在事务批里构造的语句」与「事务外直接发出的语句」：后者每条都是一次
// 独立的 Neon HTTP 往返，冷启动首请求的成本就在那里（task-55 T55-1）。
function recorder() {
  const statements: string[] = [];
  const direct: string[] = [];
  let collecting = false;
  const tag = (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    statements.push(text);
    if (!collecting) direct.push(text);
    return Promise.resolve([]);
  };
  const transaction = vi.fn((batch: unknown) => {
    collecting = true;
    try {
      const queries = (typeof batch === 'function' ? (batch as (t: unknown) => unknown[])(tag) : batch) as unknown[];
      return Promise.resolve(queries.map(() => []));
    } finally {
      collecting = false;
    }
  });
  const sql = Object.assign(tag, { transaction });
  return { statements, direct, sql, transaction };
}

describe('业务 schema 的运行时 DDL', () => {
  // T55-1：全部幂等 DDL 合成一次往返。判别力：把任意一条改回事务外的 `await s\`...\``，
  // direct 就不再为空；整段改回逐条 await，transaction 调用次数为 0 → 本用例失败。
  it('幂等 DDL 合成单次事务往返，没有散在事务外的语句', async () => {
    const { statements, direct, sql, transaction } = recorder();
    await initializeBusinessSchema(sql as never);
    expect(transaction).toHaveBeenCalledOnce();
    expect(direct).toEqual([]);
    expect(statements.length).toBeGreaterThanOrEqual(20);
  });

  // 回归护栏（warning 落库）：删掉这条 ALTER → 本用例必须失败；老库永远不会有这一列，
  // GET 就再也读不回「上次保存时判定它是推理模型」。
  it('幂等地补出 app_settings.llm_reasoning，且排在建表之后', async () => {
    const { statements, sql } = recorder();
    await initializeBusinessSchema(sql as never);
    const alterIndex = statements.findIndex((text) => /ALTER TABLE app_settings/.test(text));
    expect(alterIndex).toBeGreaterThan(-1);
    expect(statements[alterIndex]).toMatch(/ADD COLUMN IF NOT EXISTS\s+llm_reasoning/);
    const createIndex = statements.findIndex((text) => /CREATE TABLE IF NOT EXISTS app_settings/.test(text));
    expect(createIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeLessThan(alterIndex);
  });

  // task-69：默认值那一层。删掉这三条 ALTER → 本用例必须失败；老库没有这些列，
  // 读库就会抛错（列不存在），管理台整页 503。
  it('幂等地补出 app_settings 默认值那三列，且排在建表之后', async () => {
    const { statements, sql } = recorder();
    await initializeBusinessSchema(sql as never);
    const createIndex = statements.findIndex((text) => /CREATE TABLE IF NOT EXISTS app_settings/.test(text));
    expect(createIndex).toBeGreaterThan(-1);
    for (const column of ['default_model', 'default_model_reasoning', 'default_model_updated_at']) {
      const index = statements.findIndex((text) =>
        /ALTER TABLE app_settings/.test(text) && new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${column}\\b`).test(text));
      expect(index, `缺少幂等补列 ${column}`).toBeGreaterThan(-1);
      expect(index).toBeGreaterThan(createIndex);
    }
  });

  it('不动 app_settings 已有行（单行记录不能被这条补列破坏）', async () => {
    const { statements, sql } = recorder();
    await initializeBusinessSchema(sql as never);
    const touchAppSettings = statements.filter((text) => /app_settings/.test(text));
    for (const text of touchAppSettings) {
      // 只允许建表、幂等补列、以及 ON CONFLICT DO NOTHING 的兜底插入；
      // 任何 DELETE / TRUNCATE / 无条件的 UPDATE 都会毁掉 owner 已保存的模型设置。
      expect(text).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/);
      expect(text).not.toMatch(/UPDATE\s+app_settings/i);
      expect(text).toMatch(/CREATE TABLE IF NOT EXISTS|ADD COLUMN IF NOT EXISTS|ON CONFLICT \(id\) DO NOTHING/);
    }
  });

  // 加列走业务 schema 的运行时 DDL，绝不碰认证 schema 的版本闸门
  // （闸门不匹配会全站 503；认证库那边还有独立的迁移脚本）。
  it('补列不触碰认证 schema 与版本闸门', async () => {
    const { statements, sql } = recorder();
    await initializeBusinessSchema(sql as never);
    const all = statements.join('\n');
    expect(all).not.toMatch(/auth_settings|AUTH_SCHEMA_VERSION|auth_schema_migrations/);
  });

  it('幂等补出 source_admission 的语义版本与结构化诊断列', async () => {
    const { statements, sql } = recorder();
    await initializeBusinessSchema(sql as never);
    const createIndex = statements.findIndex((text) => /CREATE TABLE IF NOT EXISTS source_admission/.test(text));
    expect(createIndex).toBeGreaterThan(-1);
    for (const column of ['engine_semantics_version', 'compile_diagnostics']) {
      const index = statements.findIndex((text) =>
        /ALTER TABLE source_admission/.test(text) && new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${column}\\b`).test(text));
      expect(index, `缺少幂等补列 ${column}`).toBeGreaterThan(createIndex);
    }
  });
});

// 冷启动版本探测（41-pollddl）：businessSchemaCurrent 的 SQL 由 BUSINESS_SCHEMA_* 三常量生成，
// 探测据此判断整批 DDL 是否已空转、可跳过。这里逐条比对「DDL 真正建/删的对象集合」与三常量：
// 改 initializeBusinessSchema 加表/加索引/ADD COLUMN 而没同步常量，本用例必红——版本判定不会与
// DDL 脱节（否则探测会漏检新对象，在缺该对象的库上误判「已最新」而跳过 DDL，全站 503）。
describe('冷启动探测的对象清单与 DDL 同步', () => {
  function ddlObjects() {
    const { statements, sql } = recorder();
    // recorder 的 tag 是同步收集，initializeBusinessSchema 一次事务内构造全部语句即返回。
    void initializeBusinessSchema(sql as never);
    const tables = new Set<string>();
    const indexes = new Set<string>();
    const dropped = new Set<string>();
    const columns: [string, string][] = [];
    for (const text of statements) {
      const create = /CREATE TABLE IF NOT EXISTS\s+(\w+)/.exec(text);
      if (create) tables.add(create[1]);
      const index = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)/.exec(text);
      if (index) indexes.add(index[1]);
      const drop = /DROP INDEX IF EXISTS\s+(\w+)/.exec(text);
      if (drop) dropped.add(drop[1]);
      const alter = /ALTER TABLE\s+(\w+)/.exec(text);
      if (alter) {
        for (const match of text.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g)) {
          columns.push([alter[1], match[1]]);
        }
      }
    }
    return { tables, indexes, dropped, columns };
  }

  it('建出的表 + 索引集合 == BUSINESS_SCHEMA_RELATIONS', () => {
    const { tables, indexes } = ddlObjects();
    const built = [...tables, ...indexes].sort();
    expect(built).toEqual([...BUSINESS_SCHEMA_RELATIONS].sort());
  });

  it('ADD COLUMN 的 (表, 列) 集合 == BUSINESS_SCHEMA_COLUMNS', () => {
    const { columns } = ddlObjects();
    const key = (pair: readonly [string, string]) => `${pair[0]}.${pair[1]}`;
    expect(columns.map(key).sort()).toEqual([...BUSINESS_SCHEMA_COLUMNS].map(key).sort());
  });

  it('DROP INDEX IF EXISTS 的集合 == BUSINESS_SCHEMA_RETIRED_RELATIONS', () => {
    const { dropped } = ddlObjects();
    expect([...dropped].sort()).toEqual([...BUSINESS_SCHEMA_RETIRED_RELATIONS].sort());
  });

  it('退役关系与在册关系互斥（探测要求前者不存在、后者存在）', () => {
    const retired = new Set<string>(BUSINESS_SCHEMA_RETIRED_RELATIONS);
    for (const name of BUSINESS_SCHEMA_RELATIONS) {
      expect(retired.has(name), `${name} 不能同时在册又退役`).toBe(false);
    }
  });
});
// 共享书源可多用户同时在途，单用户内仍互斥。删掉 DROP → 老库留着旧全局键，
// 新语义永远不生效（CREATE IF NOT EXISTS 不报错）；删掉新 CREATE → 单用户去重裸奔。
describe('下载活动锁的 B2 迁移', () => {
  it('换为 (user_id, book_id) 唯一键并退役旧全局键', async () => {
    const { statements, sql } = recorder();
    await initializeBusinessSchema(sql as never);
    const all = statements.join('\n');
    expect(all).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS download_tasks_user_active_book_idx\s+ON download_tasks \(user_id, book_id\)\s+WHERE status IN \('pending', 'running'\)/);
    expect(all).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS download_tasks_system_active_book_idx\s+ON download_tasks \(book_id\)\s+WHERE requested_by = 'system' AND status IN \('pending', 'running'\)/);
    expect(all).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS download_tasks_system_event_idx\s+ON download_tasks \(enqueue_key\)/);
    expect(all).toMatch(/DROP INDEX IF EXISTS download_tasks_active_book_idx/);
    const create = statements.findIndex((text) => /download_tasks_user_active_book_idx/.test(text));
    const drop = statements.findIndex((text) => /DROP INDEX IF EXISTS download_tasks_active_book_idx/.test(text));
    expect(create).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(create); // 先建新键再删旧键：中间不会出现无锁窗口
  });
});

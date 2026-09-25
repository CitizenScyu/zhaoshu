import { describe, expect, it, vi } from 'vitest';
import {
  initializeBusinessSchema,
  BUSINESS_SCHEMA_RELATIONS,
  BUSINESS_SCHEMA_COLUMNS,
  BUSINESS_SCHEMA_RETIRED_RELATIONS,
  BUSINESS_SCHEMA_SINGLETON_ROWS,
} from './business-schema';

// 白名单判定（pollddlrev-41 §4 必修）：一条初始化语句是否属于「对象不存在才有副作用」的幂等四类
// —— CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS（且不夹带改既有对象的动作）/ DROP INDEX IF EXISTS /
// INSERT ... ON CONFLICT DO NOTHING 种子。任何会改「已存在对象内容」的语句（ALTER COLUMN SET DEFAULT/TYPE、
// ADD CONSTRAINT、CREATE OR REPLACE、UPDATE 回填等）都不在白名单内——它们会被探测在对象已存在的库上
// 跳过，却不改结构/列的存在性，故存在性守卫抓不到，必须靠这条白名单堵住。
function isIdempotentDdl(raw: string): boolean {
  const t = raw.replace(/\s+/g, ' ').trim();
  // 只对「ALTER TABLE ... ADD COLUMN」这类会碰既有表的语句扫禁用动作；CREATE TABLE 的内联
  // ON DELETE / CHECK / REFERENCES 是随表原子创建、幂等安全，不在扫描范围。
  const MUTATES_EXISTING = /ALTER COLUMN|ADD CONSTRAINT|DROP CONSTRAINT|DROP COLUMN|DROP DEFAULT|SET DEFAULT|SET NOT NULL|DROP NOT NULL|\bRENAME\b|\bUSING\b|CREATE OR REPLACE/i;
  if (/^CREATE TABLE IF NOT EXISTS \w+/i.test(t)) return true;
  if (/^CREATE (UNIQUE )?INDEX IF NOT EXISTS \w+ ON /i.test(t)) return true;
  if (/^DROP INDEX IF EXISTS \w+/i.test(t)) return true;
  if (/^INSERT INTO \w+ .*ON CONFLICT .*DO NOTHING$/i.test(t)) return true;
  if (/^ALTER TABLE \w+ /i.test(t) && /ADD COLUMN IF NOT EXISTS \w+/i.test(t) && !MUTATES_EXISTING.test(t)) return true;
  return false;
}

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

  // 必修（pollddlrev-41 §4）：白名单守卫。存在性守卫（上面三条）只保证「新增对象」被探测覆盖，
  // 管不住「改已存在对象内容」的语句——那类语句会被探测在对象已存在的库上跳过、却不改存在性，
  // 存在性守卫仍绿。这里逐条要求落入幂等白名单：加了 ALTER COLUMN / ADD CONSTRAINT / CREATE OR
  // REPLACE / UPDATE 回填等，本用例立刻红，逼迫要么扩展探测判据、要么把语句挪到迁移脚本。
  it('每条初始化语句都落在幂等白名单内（否则改探测判据或走迁移脚本）', () => {
    const { statements, sql } = recorder();
    void initializeBusinessSchema(sql as never);
    expect(statements.length).toBeGreaterThanOrEqual(20);
    for (const raw of statements) {
      expect(
        isIdempotentDdl(raw),
        `该初始化语句会改动已存在对象、不能被冷启动探测安全跳过——请扩展探测判据或改走迁移脚本:\n${raw.replace(/\s+/g, ' ').trim()}`,
      ).toBe(true);
    }
  });

  // 判别力：白名单必须真的拒绝「改已存在对象」的语句，否则守卫是摆设（pollddlrev-41 §3 反例同型）。
  it('白名单拒绝改已存在对象的语句、放行幂等四类', () => {
    for (const bad of [
      "ALTER TABLE app_settings ALTER COLUMN llm_model SET DEFAULT 'x'",
      'ALTER TABLE app_settings ALTER COLUMN quality TYPE numeric',
      'ALTER TABLE books ADD CONSTRAINT books_uk UNIQUE (title)',
      'ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS x int, ALTER COLUMN author SET NOT NULL',
      'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql',
      "UPDATE app_settings SET llm_model = 'x' WHERE id = 1",
      'DROP INDEX download_tasks_claim_idx',
      'CREATE INDEX download_tasks_claim_idx ON download_tasks (status)',
    ]) {
      expect(isIdempotentDdl(bad), `本应被拒: ${bad}`).toBe(false);
    }
    for (const ok of [
      'CREATE TABLE IF NOT EXISTS t (id int PRIMARY KEY REFERENCES u(id) ON DELETE SET NULL)',
      'CREATE UNIQUE INDEX IF NOT EXISTS i ON t (a) WHERE b IS NULL',
      'DROP INDEX IF EXISTS old_idx',
      'INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING',
      "ALTER TABLE t ADD COLUMN IF NOT EXISTS c text NOT NULL DEFAULT ''",
    ]) {
      expect(isIdempotentDdl(ok), `本应放行: ${ok}`).toBe(true);
    }
  });

  // 单例种子行也纳入探测：DDL 里 INSERT ... ON CONFLICT DO NOTHING 的目标表集合，必须与
  // BUSINESS_SCHEMA_SINGLETON_ROWS 一致——新加一条种子 INSERT 而不同步常量即红，否则探测漏检该行。
  it('幂等种子 INSERT 的目标表集合 == BUSINESS_SCHEMA_SINGLETON_ROWS', () => {
    const { statements, sql } = recorder();
    void initializeBusinessSchema(sql as never);
    const seeded = new Set<string>();
    for (const raw of statements) {
      const t = raw.replace(/\s+/g, ' ').trim();
      const match = /^INSERT INTO (\w+) .*ON CONFLICT .*DO NOTHING$/i.exec(t);
      if (match) seeded.add(match[1]);
    }
    expect([...seeded].sort()).toEqual(BUSINESS_SCHEMA_SINGLETON_ROWS.map(([table]) => table).sort());
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

import type { neon } from '@neondatabase/serverless';
// Dedicated additive migration; deliberately not invoked by runtime initialization.
export { initializeArtifactSchema } from './artifact-schema.ts';
type Sql = ReturnType<typeof neon>;

// —— 冷启动版本探测的真值来源 ——
// initializeBusinessSchema 里那批幂等 DDL「建成后」的对象清单。探测（businessSchemaCurrent）
// 据此判断整批 DDL 是否已是空转，是则跳过、省掉一次事务往返（Neon 按传输量计费）。
//
// 为什么这三个常量能当「版本」：DDL 全是 CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS，
// 一张表要么和它 CREATE 时的全部列一起存在、要么不存在；唯一能「表在但列缺」的是对既有表的
// ALTER ADD COLUMN。故只要核验 (1) 所有表/索引存在 (2) 所有增量列存在 (3) 已退役的旧索引不存在，
// 即等价于「再跑一遍 DDL 什么都不会变」。business-schema.test.ts 的守卫用例把 DDL 真正建/删的
// 对象集合与这三个常量逐条比对——**改 DDL 不同步这里，测试即红**（这就是「版本判定与 DDL 同步」）。

/** CREATE TABLE / CREATE [UNIQUE] INDEX IF NOT EXISTS 建出的全部关系名（表 + 索引）。 */
export const BUSINESS_SCHEMA_RELATIONS = [
  'profile', 'books', 'recommendations', 'recommendations_user_book_query_idx',
  'feedback', 'feedback_user_book_idx', 'shuyuan_sources', 'shuyuan_meta',
  'labeled_books', 'download_tasks', 'download_tasks_user_created_idx',
  'download_tasks_user_active_book_idx', 'download_tasks_system_active_book_idx',
  'download_tasks_system_event_idx', 'download_tasks_claim_idx',
  'source_read_catalogs', 'source_read_catalogs_expiry_idx',
  'profile_seed_audit', 'profile_seed_audit_user_time_idx',
  'app_settings', 'source_admission', 'source_admission_host_idx',
  'profile_feedback_queue', 'cron_health',
] as const;

/** ALTER TABLE ... ADD COLUMN IF NOT EXISTS 给既有表补的全部列（[表, 列]）。 */
export const BUSINESS_SCHEMA_COLUMNS: readonly (readonly [string, string])[] = [
  ['labeled_books', 'source_url'], ['labeled_books', 'primary_genre'],
  ['labeled_books', 'sub_tags'], ['labeled_books', 'quality'],
  ['app_settings', 'llm_reasoning'], ['app_settings', 'label_model'],
  ['app_settings', 'label_model_updated_at'], ['app_settings', 'default_model'],
  ['app_settings', 'default_model_reasoning'], ['app_settings', 'default_model_updated_at'],
  ['source_admission', 'engine_semantics_version'], ['source_admission', 'compile_diagnostics'],
  ['profile_feedback_queue', 'lease_token'], ['profile_feedback_queue', 'lease_expires_at'],
  ['profile_feedback_queue', 'fail_count'], ['profile_feedback_queue', 'next_eligible_at'],
] as const;

/** DROP INDEX IF EXISTS 退役的旧关系：探测要求它们**不存在**，否则说明 DDL 尚未跑到该批。 */
export const BUSINESS_SCHEMA_RETIRED_RELATIONS = ['download_tasks_active_book_idx'] as const;

/**
 * INSERT ... ON CONFLICT (id) DO NOTHING 种下的单例行（表, 固定 id）。这两行是数据、不是结构，
 * to_regclass/information_schema 看不见（pollddlrev-41 §1.7）：一旦被删/回迁漏插，读侧降级、写侧
 * 静默丢失（shuyuan_meta 刷新 UPDATE 0 行、源池被清空且不自愈）。故纳入探测——缺任一行即
 * current=false，回落到整批 DDL 的幂等种子 INSERT 把行补回。
 */
export const BUSINESS_SCHEMA_SINGLETON_ROWS: readonly (readonly [string, number])[] = [
  ['shuyuan_meta', 1], ['app_settings', 1],
] as const;

// 名字全是源码内硬编码常量，绝无外部输入；探测 SQL 直接内联它们（非绑定参数），此处做一次
// 标识符/字面量形状校验，既是防线也是文档：任何非标识符名字或非整数 id 在模块加载期即抛，绝不进 SQL。
const IDENT = /^[a-z_][a-z0-9_]*$/;
for (const name of [
  ...BUSINESS_SCHEMA_RELATIONS, ...BUSINESS_SCHEMA_RETIRED_RELATIONS,
  ...BUSINESS_SCHEMA_COLUMNS.flat(), ...BUSINESS_SCHEMA_SINGLETON_ROWS.map(([table]) => table),
]) {
  if (!IDENT.test(name)) throw new Error(`business schema probe: 非法标识符 ${JSON.stringify(name)}`);
}
for (const [, id] of BUSINESS_SCHEMA_SINGLETON_ROWS) {
  if (!Number.isInteger(id)) throw new Error(`business schema probe: 单例行 id 非整数 ${JSON.stringify(id)}`);
}

function sqlValues(rows: readonly (readonly string[])[]): string {
  return rows.map((cells) => `(${cells.map((cell) => `'${cell}'`).join(', ')})`).join(', ');
}

/**
 * 冷启动版本探测：判断「再跑一遍 initializeBusinessSchema 是否纯空转」。
 * 返回 true ⇒ 整批 DDL 可安全跳过；false ⇒ 走原 DDL 路径（含全新库/旧库/结构漂移/单例行缺失）。
 *
 * 分两段、共至多两次只读往返（都远比 ~40 条 DDL 的事务便宜）：
 *   1) 结构段：表/索引/增量列在册且退役索引不存在。对缺失对象永不抛错（to_regclass 返 NULL、
 *      information_schema 缺表则 0 匹配），只会让计数不达标而返回 false。
 *   2) 单例段：仅在结构齐全后才查 shuyuan_meta/app_settings 的 id=1 行。**必须后置**：全新库上这两张
 *      表尚不存在，若在一条 SELECT 里硬引用它们会在解析期 42P01 抛错，把「全新库冷启动跑 DDL」变成
 *      「探测抛错」，与改动前行为不一致（pollddlrev-41 §1.6/§1.7）。结构段为真即保证这两表已存在。
 * 唯一会抛的是连接层错误，与原 DDL 路径同样向上冒泡；ensureSchema 的 catch 会重置 schemaPromise 重试。
 */
export async function businessSchemaCurrent(s: Sql): Promise<boolean> {
  const relations = sqlValues(BUSINESS_SCHEMA_RELATIONS.map((name) => [name]));
  const columns = sqlValues(BUSINESS_SCHEMA_COLUMNS.map(([table, column]) => [table, column]));
  const retired = sqlValues(BUSINESS_SCHEMA_RETIRED_RELATIONS.map((name) => [name]));
  const structuralText = `
    SELECT (
      (SELECT count(*)::int FROM (VALUES ${relations}) AS r(name)
         WHERE to_regclass(quote_ident(current_schema()) || '.' || quote_ident(r.name)) IS NOT NULL)
        = ${BUSINESS_SCHEMA_RELATIONS.length}
      AND
      (SELECT count(*)::int FROM information_schema.columns c
         JOIN (VALUES ${columns}) AS want(tbl, col)
           ON c.table_name = want.tbl AND c.column_name = want.col
         WHERE c.table_schema = current_schema())
        = ${BUSINESS_SCHEMA_COLUMNS.length}
      AND
      NOT EXISTS (SELECT 1 FROM (VALUES ${retired}) AS x(name)
         WHERE to_regclass(quote_ident(current_schema()) || '.' || quote_ident(x.name)) IS NOT NULL)
    ) AS current`;
  const structural = await s.query(structuralText) as { current: boolean }[];
  if (structural[0]?.current !== true) return false;

  const seedClauses = BUSINESS_SCHEMA_SINGLETON_ROWS
    .map(([table, id]) => `EXISTS (SELECT 1 FROM ${table} WHERE id = ${id})`)
    .join(' AND ');
  const seeds = await s.query(`SELECT (${seedClauses}) AS current`) as { current: boolean }[];
  return seeds[0]?.current === true;
}

export async function initializeBusinessSchema(s: Sql) {
  // 仅在已完成当前专用迁移后由业务入口调用；声明不含旧全局唯一键或 owner 默认值。
  //
  // 这些 DDL 全部幂等（CREATE ... IF NOT EXISTS / ON CONFLICT DO NOTHING），把它们合成
  // 一次事务往返（task-55 T55-1）：Neon HTTP 下每条独立 await 都是一次串行 RTT，冷启动
  // 首请求要为之付二十多次。语句顺序与逐条执行时完全一致（事务内按数组顺序执行）。
  await s.transaction((tx) => [
    tx`
    CREATE TABLE IF NOT EXISTS profile (
      id int PRIMARY KEY CONSTRAINT profile_user_fk REFERENCES users(id),
      seeds jsonb NOT NULL DEFAULT '[]',
      content text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    tx`
    CREATE TABLE IF NOT EXISTS books (
      id serial PRIMARY KEY,
      title text NOT NULL,
      author text NOT NULL,
      douban_id text,
      douban_rating float8,
      douban_rating_count int,
      meta jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    // 身份键唯一索引不在这里声明（task-53）：改成生成列 title_key/author_key 后由
    // migrations/0002_identity_key.sql 建立。放在 ensureSchema 里一旦 23505 会让
    // schemaPromise 重抛，全站 503。
    tx`
    CREATE TABLE IF NOT EXISTS recommendations (
      id serial PRIMARY KEY,
      user_id int NOT NULL CONSTRAINT recommendations_user_fk REFERENCES users(id),
      book_id int NOT NULL REFERENCES books(id),
      query text NOT NULL,
      match_score float8,
      hit_likes jsonb,
      risks text,
      reason text,
      status text NOT NULL DEFAULT 'new',
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    tx`
    CREATE UNIQUE INDEX IF NOT EXISTS recommendations_user_book_query_idx
    ON recommendations (user_id, book_id, query)`,
    tx`
    CREATE TABLE IF NOT EXISTS feedback (
      id serial PRIMARY KEY,
      user_id int NOT NULL CONSTRAINT feedback_user_fk REFERENCES users(id),
      book_id int NOT NULL REFERENCES books(id),
      status text NOT NULL,
      note text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    // B7（audit-3 P1-4）：书架/召回路径大量 EXISTS (feedback WHERE book_id = b.id AND
    // user_id = ...)——auth v5 的 feedback_user_created_idx 只罩 user 前缀，book 定位
    // 全表扫。幂等补建，老库下一次 ensureSchema 生效。
    tx`CREATE INDEX IF NOT EXISTS feedback_user_book_idx ON feedback (user_id, book_id)`,
    tx`
    CREATE TABLE IF NOT EXISTS shuyuan_sources (
      id serial PRIMARY KEY,
      source_url text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT '',
      group_name text NOT NULL DEFAULT '',
      source jsonb NOT NULL,
      disabled_at timestamptz,
      last_error text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    tx`
    CREATE TABLE IF NOT EXISTS shuyuan_meta (
      id int PRIMARY KEY DEFAULT 1,
      collections jsonb NOT NULL DEFAULT '[]',
      refreshed_at timestamptz
    )`,
    tx`
    CREATE TABLE IF NOT EXISTS labeled_books (
      id serial PRIMARY KEY,
      title text NOT NULL,
      author text NOT NULL DEFAULT '',
      category text NOT NULL DEFAULT '',
      finish_status text NOT NULL DEFAULT '',
      source_site text NOT NULL DEFAULT '',
      source_url text NOT NULL DEFAULT '',
      chars_labeled int NOT NULL DEFAULT 0,
      labels jsonb NOT NULL DEFAULT '{}',
      labeled_at timestamptz NOT NULL DEFAULT now()
    )`,
    // 同上：labeled_books 的身份键唯一索引由 0002_identity_key.sql 建立。
    // 老表建立时可能没有 source_url 列(CREATE TABLE IF NOT EXISTS 不会补列)
    tx`
    ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS source_url text NOT NULL DEFAULT ''`,
    // 质量分与规范化分类（由 scripts/import_labels.mjs 写入；quality 为 LLM 综合分 0-10）
    tx`
    ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS primary_genre text NOT NULL DEFAULT ''`,
    tx`
    ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS sub_tags jsonb NOT NULL DEFAULT '[]'`,
    tx`
    ALTER TABLE labeled_books ADD COLUMN IF NOT EXISTS quality float8`,
    tx`
    CREATE TABLE IF NOT EXISTS download_tasks (
      id serial PRIMARY KEY,
      user_id int CONSTRAINT download_tasks_user_fk REFERENCES users(id),
      book_id int NOT NULL,
      title text NOT NULL,
      author text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending',
      source_url text NOT NULL DEFAULT '',
      chapters_total int NOT NULL DEFAULT 0,
      chapters_done int NOT NULL DEFAULT 0,
      chars_total int NOT NULL DEFAULT 0,
      error text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      requested_by text NOT NULL DEFAULT 'user'
        CONSTRAINT download_tasks_requested_by_check CHECK (requested_by IN ('user', 'system')),
      source_kind text NOT NULL DEFAULT 'builtin',
      source_id text,
      source_revision text NOT NULL DEFAULT '',
      policy_version text NOT NULL DEFAULT '',
      enqueue_key text,
      attempt_count int NOT NULL DEFAULT 1
        CONSTRAINT download_tasks_attempt_count_check CHECK (attempt_count >= 1),
      retry_of int CONSTRAINT download_tasks_retry_of_fk REFERENCES download_tasks(id) ON DELETE SET NULL,
      next_attempt_at timestamptz,
      lease_generation bigint NOT NULL DEFAULT 0
        CONSTRAINT download_tasks_lease_generation_check CHECK (lease_generation >= 0),
      lease_owner text NOT NULL DEFAULT '',
      artifact_id bigint,
      CONSTRAINT download_tasks_request_identity_check CHECK (
        (requested_by = 'user' AND user_id IS NOT NULL)
        OR (requested_by = 'system' AND user_id IS NULL)
      )
    )`,
    tx`CREATE INDEX IF NOT EXISTS download_tasks_user_created_idx ON download_tasks (user_id, created_at DESC)`,
    // 跨用户共享书源：活动任务锁的粒度是 (user_id, book_id)——书可以在多用户任务单里
    // 同时在途，单用户内仍互斥（audit-3 P0-2）。旧的全局 book_id 索引（B2 迁移前的
    // 唯一键）在这里退役；23505 冲突在应用层表现为 409 TASK_CONFLICT。
    tx`CREATE UNIQUE INDEX IF NOT EXISTS download_tasks_user_active_book_idx ON download_tasks (user_id, book_id)
    WHERE status IN ('pending', 'running')`,
    tx`CREATE UNIQUE INDEX IF NOT EXISTS download_tasks_system_active_book_idx ON download_tasks (book_id)
    WHERE requested_by = 'system' AND status IN ('pending', 'running')`,
    tx`CREATE UNIQUE INDEX IF NOT EXISTS download_tasks_system_event_idx ON download_tasks (enqueue_key)
    WHERE requested_by = 'system' AND enqueue_key IS NOT NULL`,
    tx`CREATE INDEX IF NOT EXISTS download_tasks_claim_idx
    ON download_tasks (status, next_attempt_at, created_at, id)`,
    tx`DROP INDEX IF EXISTS download_tasks_active_book_idx`,
    tx`INSERT INTO shuyuan_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    // Disposable online-reader directories only; chapter text is never stored here.
    tx`
    CREATE TABLE IF NOT EXISTS source_read_catalogs (
      id text PRIMARY KEY,
      payload jsonb NOT NULL,
      expires_at timestamptz NOT NULL
    )`,
    tx`CREATE INDEX IF NOT EXISTS source_read_catalogs_expiry_idx ON source_read_catalogs (expires_at)`,
    tx`
    CREATE TABLE IF NOT EXISTS profile_seed_audit (
      id bigserial PRIMARY KEY,
      user_id int NOT NULL,
      previous_version text NOT NULL,
      saved_version text NOT NULL,
      added_titles jsonb NOT NULL,
      removed_titles jsonb NOT NULL,
      previous_seeds jsonb NOT NULL,
      saved_seeds jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    tx`CREATE INDEX IF NOT EXISTS profile_seed_audit_user_time_idx ON profile_seed_audit (user_id, created_at DESC)`,
    // 应用级配置（当前只有 LLM 模型覆盖值）。刻意与 auth_settings 分开：认证 schema 有
    // 版本闸门，为一条应用配置去动它会牵动全站可用性。单行表，id 固定为 1。
    tx`
    CREATE TABLE IF NOT EXISTS app_settings (
      id integer PRIMARY KEY DEFAULT 1,
      llm_model text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    tx`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    // 保存前验证观测到的推理结论（'yes' | 'unknown'；null 表示这次没探测/没有覆盖值）。
    // 老表建立时没有这一列(CREATE TABLE IF NOT EXISTS 不会补列)，而这条结论刷新页面后仍要
    // 看得见（否则「当前模型是推理模型」的告警只在保存成功那一次闪现）。幂等补列，不动 id=1
    // 那行已有内容。
    tx`
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS llm_reasoning text`,
    // 打标模型（labeler.py 在 phoenix 上离线跑；Web 只存名字，不读打标机的 .env）。
    // 独立时间戳：改打标模型不会把 llm_model 那一栏的「更新时间」弄脏。
    tx`
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS label_model text`,
    tx`
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS label_model_updated_at timestamptz`,
    // 默认模型（llm_model 没有覆盖值时要用的那个）。此前「默认值」只有环境变量与硬编码缺省
    // 两个来源，改它必须重新部署；加这一列之后改默认值与管理台改当前模型同路，不需要发布。
    // 独立三列（含判定与时间戳）：改默认值不能弄脏 llm_model 那三列的「当前值/判定/更新时间」。
    // 幂等补列，与 label_model 同一模式，不动 id=1 那行已有内容。
    tx`
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_model text`,
    // 保存默认值时探测到的推理结论。与 llm_reasoning 同理：一旦默认值真的生效，
    // 「当前模型是推理模型」的告警必须刷新后仍然看得见。
    tx`
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_model_reasoning text`,
    tx`
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_model_updated_at timestamptz`,
    // M1 准入结果（设计 §4.3）：probe 是 host 级健康态、生命周期长；admission 是「源+规则版本」
    // 级资格，规则变（rules_hash 变）即作废重测，故独立成表，不复用 probeSnapshot。
    // host 冗余一列喂运行时门的 host 集合（§6.1）；tier 记引擎档位（M1/T7）。
    tx`
    CREATE TABLE IF NOT EXISTS source_admission (
      id serial PRIMARY KEY,
      source_url text NOT NULL UNIQUE,
      tier text NOT NULL,
      compile_ok boolean NOT NULL,
      core_field_mask jsonb NOT NULL,
      search_ok boolean,
      search_verdict text NOT NULL DEFAULT '',
      search_checked_at timestamptz,
      rules_hash text NOT NULL,
      engine_semantics_version integer NOT NULL DEFAULT 0,
      host text NOT NULL,
      error text NOT NULL DEFAULT '',
      compile_diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb
    )`,
    tx`ALTER TABLE source_admission ADD COLUMN IF NOT EXISTS engine_semantics_version integer NOT NULL DEFAULT 0`,
    tx`ALTER TABLE source_admission ADD COLUMN IF NOT EXISTS compile_diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb`,
    tx`CREATE INDEX IF NOT EXISTS source_admission_host_idx ON source_admission (host)`,
    // F15：每个用户一行「待吸收反馈」队列。反馈写事务只做快速持久化 + 把 pending_feedback_id
    // 抬到本次写入的反馈 id（GREATEST 合并并发写入）；画像吸收按用户合并成一次模型调用，成功后
    // 才把 absorbed_feedback_id 推进、必要时清空 pending。status 记录最后一次结果：
    // pending / applied / unchanged / failed / conflict。
    //
    // 为什么不需要迁移既有数据：这是**新表**，不改任何既有列；且队列语义是「从建表这一刻起
    // 新写入的反馈才需要吸收」。历史反馈在旧版本里要么已经写进 profile.content，要么已经被
    // 静默丢弃——本任务默认不动历史，不回填：absence of a row = 没有待处理事件。若把历史
    // feedback 全量回填成 pending，会在用户下次写反馈时触发一次覆盖全史的大重放，属于改变既有
    // 画像的破坏性动作，故刻意不做（如需回填见报告 §6，另行给出幂等方案）。
    tx`
    CREATE TABLE IF NOT EXISTS profile_feedback_queue (
      user_id int PRIMARY KEY CONSTRAINT profile_feedback_queue_user_fk REFERENCES users(id),
      pending_feedback_id int,
      absorbed_feedback_id int NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'unchanged',
      attempts int NOT NULL DEFAULT 0,
      last_error text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    // F15 残留（租约/退避）：排他领取与失败退避的行状态。幂等补列，老库下一次
    // ensureSchema 生效；默认值让既有行**立即可领取**（lease 空 = 无人持有）、**立即可试**
    // （next_eligible_at 空 = 无退避）——零数据迁移。列语义与使用见 user-data.ts 队列查询。
    // 该表族走运行时幂等 DDL（同 labeled_books.source_url / app_settings 各列）补老库；冷建库由
    // migrations/0003_runtime_tables.sql 逐字复刻本表及上面 app_settings / source_admission 的 DDL（MS-25），
    // 改这里的列必须同步 0003 之后的新迁移——runtime-tables-migration.pglite.test.ts 会逐列比对。
    tx`
    ALTER TABLE profile_feedback_queue
      ADD COLUMN IF NOT EXISTS lease_token text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS fail_count int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS next_eligible_at timestamptz`,
    // audit-41 S5-1：三条 Vercel cron 失败时零告警通道。shuyuan 用 shuyuan_meta.refreshed_at
    // 作「上次成功时间」（刷新成功才推进）；reclaim / drain 是无状态 UPDATE/扫描，库里不落任何
    // 成功时间戳，故单独记一行。没有这行表，健康端点的 crons.*.lastSuccessAt 永远是 null。
    // 同样走运行时幂等 DDL（同 profile_feedback_queue）；冷建库由 migrations/0003 建立。
    tx`
    CREATE TABLE IF NOT EXISTS cron_health (
      name text PRIMARY KEY,
      last_success_at timestamptz NOT NULL DEFAULT now()
    )`,
  ]);
}

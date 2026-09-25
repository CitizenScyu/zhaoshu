import type { neon, NeonQueryFunctionInTransaction } from '@neondatabase/serverless';
import { missingLedgerVersions } from './schema-ledger.ts';

export const AUTH_SCHEMA_VERSION = 7;

type Sql = ReturnType<typeof neon>;

export function authSchemaV7Statement(tx: NeonQueryFunctionInTransaction<boolean, boolean>) {
  return tx`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM auth_schema_migrations WHERE version = 7) THEN
        LOCK TABLE download_tasks IN SHARE ROW EXCLUSIVE MODE;
        ALTER TABLE download_tasks
          ADD COLUMN IF NOT EXISTS requested_by text NOT NULL DEFAULT 'user',
          ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'builtin',
          ADD COLUMN IF NOT EXISTS source_id text,
          ADD COLUMN IF NOT EXISTS source_revision text NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS policy_version text NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS enqueue_key text,
          ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS retry_of integer,
          ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
          ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS lease_owner text NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS artifact_id bigint;
        ALTER TABLE download_tasks ALTER COLUMN user_id DROP NOT NULL;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'download_tasks'::regclass
          AND conname = 'download_tasks_requested_by_check') THEN
          ALTER TABLE download_tasks ADD CONSTRAINT download_tasks_requested_by_check
            CHECK (requested_by IN ('user', 'system'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'download_tasks'::regclass
          AND conname = 'download_tasks_request_identity_check') THEN
          ALTER TABLE download_tasks ADD CONSTRAINT download_tasks_request_identity_check
            CHECK ((requested_by = 'user' AND user_id IS NOT NULL)
              OR (requested_by = 'system' AND user_id IS NULL));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'download_tasks'::regclass
          AND conname = 'download_tasks_attempt_count_check') THEN
          ALTER TABLE download_tasks ADD CONSTRAINT download_tasks_attempt_count_check
            CHECK (attempt_count >= 1);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'download_tasks'::regclass
          AND conname = 'download_tasks_lease_generation_check') THEN
          ALTER TABLE download_tasks ADD CONSTRAINT download_tasks_lease_generation_check
            CHECK (lease_generation >= 0);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'download_tasks'::regclass
          AND conname = 'download_tasks_retry_of_fk') THEN
          ALTER TABLE download_tasks ADD CONSTRAINT download_tasks_retry_of_fk
            FOREIGN KEY (retry_of) REFERENCES download_tasks(id) ON DELETE SET NULL;
        END IF;
        CREATE UNIQUE INDEX IF NOT EXISTS download_tasks_system_active_book_idx
          ON download_tasks (book_id)
          WHERE requested_by = 'system' AND status IN ('pending', 'running');
        CREATE UNIQUE INDEX IF NOT EXISTS download_tasks_system_event_idx
          ON download_tasks (enqueue_key)
          WHERE requested_by = 'system' AND enqueue_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS download_tasks_claim_idx
          ON download_tasks (status, next_attempt_at, created_at, id);
        INSERT INTO auth_schema_migrations (version) VALUES (7);
      END IF;
    END $$`;
}

export async function initializeAuthSchema(sql: Sql): Promise<void> {
  await sql.transaction((tx) => [
    tx`SELECT pg_advisory_xact_lock(18521401)`,
    tx`
      CREATE TABLE IF NOT EXISTS auth_schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    tx`
      DO $$
      DECLARE newest integer;
      BEGIN
        SELECT max(version) INTO newest FROM auth_schema_migrations;
        IF newest IS NOT NULL AND newest > 7 THEN
          RAISE EXCEPTION 'auth schema version % is newer than supported version 7', newest;
        END IF;
      END $$`,
    // 仅专用迁移支持空库初始化；普通业务请求不会调用本函数。
    tx`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM auth_schema_migrations WHERE version = 3)
        AND to_regclass('profile') IS NULL AND to_regclass('recommendations') IS NULL AND to_regclass('feedback') IS NULL THEN
        CREATE TABLE profile (id integer PRIMARY KEY DEFAULT 1, seeds jsonb NOT NULL DEFAULT '[]', content text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS books (id serial PRIMARY KEY, title text NOT NULL, author text NOT NULL,
          douban_id text, douban_rating float8, douban_rating_count int, meta jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE recommendations (id serial PRIMARY KEY, book_id int NOT NULL REFERENCES books(id), query text NOT NULL,
          match_score float8, hit_likes jsonb, risks text, reason text, status text NOT NULL DEFAULT 'new', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (book_id, query));
        CREATE UNIQUE INDEX recommendations_book_query_idx ON recommendations (book_id, query);
        CREATE TABLE feedback (id serial PRIMARY KEY, book_id int NOT NULL REFERENCES books(id), status text NOT NULL,
          note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
      END IF;
    END $$`,
    tx`
      CREATE TABLE IF NOT EXISTS users (
        id integer GENERATED BY DEFAULT AS IDENTITY (START WITH 2) PRIMARY KEY,
        username text NOT NULL UNIQUE,
        password_hash text,
        role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
        can_find boolean NOT NULL DEFAULT true,
        can_read boolean NOT NULL DEFAULT false,
        can_download boolean NOT NULL DEFAULT false,
        created_via_invite_id integer,
        disabled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (username ~ '^[a-z][a-z0-9_]{2,31}$'),
        CHECK (
          (id = 1 AND username = 'owner' AND role = 'owner'
            AND password_hash IS NULL AND disabled_at IS NULL
            AND can_find AND can_read AND can_download)
          OR
          (id > 1 AND username <> 'owner' AND role = 'member'
            AND password_hash IS NOT NULL)
        ),
        CHECK (NOT can_read OR can_find),
        CHECK (NOT can_download OR (can_find AND can_read))
      )`,
    tx`
      INSERT INTO users (id, username, role, can_find, can_read, can_download)
      VALUES (1, 'owner', 'owner', true, true, true)
      ON CONFLICT (id) DO NOTHING`,
    tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM users
          WHERE id = 1 AND username = 'owner' AND role = 'owner'
            AND password_hash IS NULL AND disabled_at IS NULL
            AND can_find AND can_read AND can_download
        ) THEN
          RAISE EXCEPTION 'users.id=1 conflicts with the fixed owner identity';
        END IF;
        IF EXISTS (SELECT 1 FROM users WHERE username = 'owner' AND id <> 1) THEN
          RAISE EXCEPTION 'username owner conflicts with the fixed owner identity';
        END IF;
      END $$`,
    tx`
      CREATE TABLE IF NOT EXISTS auth_settings (
        id integer PRIMARY KEY CHECK (id = 1),
        members_enabled boolean NOT NULL DEFAULT false,
        registration_mode text NOT NULL DEFAULT 'closed'
          CHECK (registration_mode IN ('closed', 'open', 'invite')),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    tx`INSERT INTO auth_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    tx`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM auth_schema_migrations WHERE version = 4) AND NOT EXISTS (
          SELECT 1 FROM auth_settings
          WHERE id = 1 AND members_enabled = false AND registration_mode = 'closed'
        ) THEN
          RAISE EXCEPTION 'auth settings must remain closed during A01 initialization';
        END IF;
      END $$`,
    tx`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        auth_method text NOT NULL CHECK (auth_method IN ('password', 'owner_token')),
        owner_credential_tag char(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        CHECK (expires_at > created_at),
        CHECK ((auth_method = 'owner_token') = (user_id = 1)),
        CHECK (
          (auth_method = 'owner_token' AND owner_credential_tag IS NOT NULL)
          OR (auth_method = 'password' AND owner_credential_tag IS NULL)
        )
      )`,
    tx`
      CREATE INDEX IF NOT EXISTS sessions_user_created_idx
      ON sessions (user_id, created_at DESC)`,
    tx`CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at)`,
    tx`
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        scope text NOT NULL,
        key_hash char(64) NOT NULL,
        window_start timestamptz NOT NULL,
        attempts integer NOT NULL CHECK (attempts >= 0),
        expires_at timestamptz NOT NULL,
        PRIMARY KEY (scope, key_hash, window_start)
      )`,
    tx`
      CREATE INDEX IF NOT EXISTS auth_rate_limits_expires_idx
      ON auth_rate_limits (expires_at)`,
    tx`
      INSERT INTO auth_schema_migrations (version)
      VALUES (1)
      ON CONFLICT (version) DO NOTHING`,
    tx`
      INSERT INTO auth_schema_migrations (version)
      VALUES (2)
      ON CONFLICT (version) DO NOTHING`,
    tx`DO $$
      DECLARE profile_default text;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM auth_schema_migrations WHERE version = 3) THEN
          IF to_regclass('profile') IS NULL OR to_regclass('recommendations') IS NULL OR to_regclass('feedback') IS NULL THEN
            RAISE EXCEPTION 'personal data migration requires profile, recommendations, and feedback tables';
          END IF;
          IF EXISTS (SELECT 1 FROM profile WHERE id <> 1) THEN
            RAISE EXCEPTION 'profile contains an unexpected non-owner id';
          END IF;
          SELECT pg_get_expr(d.adbin, d.adrelid) INTO profile_default FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = 'profile'::regclass AND a.attname = 'id' AND NOT a.attisdropped;
          IF profile_default IS NULL OR profile_default NOT IN ('1', '1::integer') THEN
            RAISE EXCEPTION 'profile.id default drifted from owner id 1';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'recommendations'::regclass AND contype = 'u'
            AND pg_get_constraintdef(oid) = 'UNIQUE (book_id, query)') THEN
            RAISE EXCEPTION 'recommendations legacy table unique constraint has drifted';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'recommendations'
            AND indexname = 'recommendations_book_query_idx' AND indexdef LIKE 'CREATE UNIQUE INDEX % ON %.recommendations USING btree (book_id, query)') THEN
            RAISE EXCEPTION 'recommendations legacy explicit unique index has drifted';
          END IF;
          ALTER TABLE profile ALTER COLUMN id DROP DEFAULT;
          ALTER TABLE profile ADD CONSTRAINT profile_user_fk FOREIGN KEY (id) REFERENCES users(id);
          ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS user_id integer DEFAULT 1;
          ALTER TABLE feedback ADD COLUMN IF NOT EXISTS user_id integer DEFAULT 1;
          IF EXISTS (SELECT 1 FROM recommendations WHERE user_id <> 1) OR EXISTS (SELECT 1 FROM feedback WHERE user_id <> 1) THEN
            RAISE EXCEPTION 'unversioned personal ownership is ambiguous';
          END IF;
          UPDATE recommendations SET user_id = 1 WHERE user_id IS NULL;
          UPDATE feedback SET user_id = 1 WHERE user_id IS NULL;
          ALTER TABLE recommendations ALTER COLUMN user_id SET NOT NULL;
          ALTER TABLE feedback ALTER COLUMN user_id SET NOT NULL;
          ALTER TABLE recommendations ADD CONSTRAINT recommendations_user_fk FOREIGN KEY (user_id) REFERENCES users(id);
          ALTER TABLE feedback ADD CONSTRAINT feedback_user_fk FOREIGN KEY (user_id) REFERENCES users(id);
          CREATE INDEX recommendations_user_created_idx ON recommendations (user_id, created_at DESC);
          CREATE UNIQUE INDEX recommendations_user_book_query_idx ON recommendations (user_id, book_id, query);
          CREATE INDEX feedback_user_created_idx ON feedback (user_id, created_at DESC);
          INSERT INTO auth_schema_migrations (version) VALUES (3);
        END IF;
      END $$`,
    tx`DO $$
      DECLARE
        book_column smallint; query_column smallint; user_column smallint;
        old_constraint text; old_index text; total_global integer; target record; default_expr text;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM auth_schema_migrations WHERE version = 4) THEN
          LOCK TABLE profile, recommendations, feedback IN SHARE ROW EXCLUSIVE MODE;
          SELECT attnum INTO book_column FROM pg_attribute WHERE attrelid = 'recommendations'::regclass AND attname = 'book_id' AND NOT attisdropped;
          SELECT attnum INTO query_column FROM pg_attribute WHERE attrelid = 'recommendations'::regclass AND attname = 'query' AND NOT attisdropped;
          SELECT attnum INTO user_column FROM pg_attribute WHERE attrelid = 'recommendations'::regclass AND attname = 'user_id' AND NOT attisdropped;
          IF book_column IS NULL OR query_column IS NULL OR user_column IS NULL THEN
            RAISE EXCEPTION 'personal columns are missing';
          END IF;
          FOR target IN SELECT * FROM (VALUES ('profile', 'id'), ('recommendations', 'user_id'), ('feedback', 'user_id')) AS keys(table_name, column_name) LOOP
            IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid
              WHERE c.conrelid = to_regclass(target.table_name) AND c.contype = 'f' AND c.convalidated
                AND a.attname = target.column_name AND a.attnotnull AND a.atttypid = 'int4'::regtype
                AND c.conkey = ARRAY[a.attnum]::smallint[] AND c.confrelid = 'users'::regclass
                AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'users'::regclass AND attname = 'id')]::smallint[]) THEN
              RAISE EXCEPTION 'personal user foreign key is missing or invalid: %', target.table_name;
            END IF;
            SELECT pg_get_expr(d.adbin, d.adrelid) INTO default_expr FROM pg_attribute a
              LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
              WHERE a.attrelid = to_regclass(target.table_name) AND a.attname = target.column_name AND NOT a.attisdropped;
            IF default_expr IS NOT NULL AND (target.table_name = 'profile' OR default_expr NOT IN ('1', '1::integer')) THEN
              RAISE EXCEPTION 'personal owner default has drifted: %', target.table_name;
            END IF;
          END LOOP;
          IF EXISTS (SELECT 1 FROM recommendations r LEFT JOIN users u ON u.id = r.user_id WHERE u.id IS NULL)
            OR EXISTS (SELECT 1 FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE u.id IS NULL)
            OR EXISTS (SELECT 1 FROM profile p LEFT JOIN users u ON u.id = p.id WHERE u.id IS NULL) THEN
            RAISE EXCEPTION 'personal ownership is ambiguous; manual review required';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'recommendations'::regclass
            AND i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts = 3 AND i.indnatts = 3
            AND i.indkey[0] = user_column AND i.indkey[1] = book_column AND i.indkey[2] = query_column
            AND i.indexprs IS NULL AND i.indpred IS NULL) THEN
            RAISE EXCEPTION 'user-scoped recommendation unique index is missing';
          END IF;
          SELECT count(*) INTO total_global FROM pg_index i WHERE i.indrelid = 'recommendations'::regclass
            AND i.indisunique AND NOT i.indisprimary AND NOT (user_column = ANY(i.indkey));
          IF total_global <> 2 THEN
            RAISE EXCEPTION 'unexpected legacy global uniqueness; manual review required';
          END IF;
          SELECT conname INTO STRICT old_constraint FROM pg_constraint WHERE conrelid = 'recommendations'::regclass
            AND contype = 'u' AND conkey = ARRAY[book_column, query_column]::smallint[] AND NOT condeferrable;
          SELECT c.relname INTO STRICT old_index FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE i.indrelid = 'recommendations'::regclass AND i.indisunique AND i.indisvalid AND i.indisready
              AND i.indnkeyatts = 2 AND i.indnatts = 2 AND i.indkey[0] = book_column AND i.indkey[1] = query_column
              AND i.indexprs IS NULL AND i.indpred IS NULL
              AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid);
          IF EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND confrelid = 'recommendations'::regclass
            AND confkey = ARRAY[book_column, query_column]::smallint[]) THEN
            RAISE EXCEPTION 'legacy global uniqueness has dependent foreign keys';
          END IF;
          EXECUTE format('ALTER TABLE %I.recommendations DROP CONSTRAINT %I', current_schema(), old_constraint);
          EXECUTE format('DROP INDEX %I.%I', current_schema(), old_index);
          ALTER TABLE recommendations ALTER COLUMN user_id DROP DEFAULT;
          ALTER TABLE feedback ALTER COLUMN user_id DROP DEFAULT;
          INSERT INTO profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
          INSERT INTO auth_schema_migrations (version) VALUES (4);
        END IF;
      END $$`,
    tx`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM auth_schema_migrations WHERE version = 5) THEN
          CREATE TABLE IF NOT EXISTS download_tasks (
            id serial PRIMARY KEY, book_id int NOT NULL, title text NOT NULL,
            author text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending',
            source_url text NOT NULL DEFAULT '', chapters_total int NOT NULL DEFAULT 0,
            chapters_done int NOT NULL DEFAULT 0, chars_total int NOT NULL DEFAULT 0,
            error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          );
          LOCK TABLE download_tasks IN SHARE ROW EXCLUSIVE MODE;
          ALTER TABLE download_tasks ADD COLUMN IF NOT EXISTS user_id integer;
          UPDATE download_tasks SET user_id = 1 WHERE user_id IS NULL;
          ALTER TABLE download_tasks ALTER COLUMN user_id SET NOT NULL;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'download_tasks'::regclass
            AND conname = 'download_tasks_user_fk') THEN
            ALTER TABLE download_tasks ADD CONSTRAINT download_tasks_user_fk
              FOREIGN KEY (user_id) REFERENCES users(id);
          END IF;
          CREATE INDEX IF NOT EXISTS download_tasks_user_created_idx
            ON download_tasks (user_id, created_at DESC);
          -- Existing duplicate active jobs are deliberately not deleted: index creation
          -- aborts the migration so an operator can review them.
          CREATE UNIQUE INDEX download_tasks_active_book_idx ON download_tasks (book_id)
            WHERE status IN ('pending', 'running');
          INSERT INTO auth_schema_migrations (version) VALUES (5);
        END IF;
      END $$`,
    // v6：邀请码（A07 注册流程的登记表）。只存 SHA-256 摘要与短提示，原文永不落库
    // （设计 §4.3）；一次性使用，作废只写 revoked_at，不硬删已使用记录。
    // users.created_via_invite_id 是 v1 就存在的空列，这里才给它补上外键。
    tx`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM auth_schema_migrations WHERE version = 6) THEN
          -- 历史行必须全为 NULL 才能加外键；有非空值时说明有人手写过归属，人工核验。
          IF EXISTS (SELECT 1 FROM users WHERE created_via_invite_id IS NOT NULL) THEN
            RAISE EXCEPTION 'existing users reference unknown invite codes';
          END IF;
          CREATE TABLE IF NOT EXISTS registration_invites (
            id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            code_hash char(64) NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
            code_hint text NOT NULL CHECK (length(code_hint) BETWEEN 4 AND 16),
            created_by integer NOT NULL REFERENCES users(id),
            used_by integer UNIQUE REFERENCES users(id),
            created_at timestamptz NOT NULL DEFAULT now(),
            used_at timestamptz,
            expires_at timestamptz,
            revoked_at timestamptz,
            CHECK ((used_by IS NULL) = (used_at IS NULL)),
            CHECK (expires_at IS NULL OR expires_at > created_at)
          );
          CREATE INDEX IF NOT EXISTS registration_invites_created_idx
            ON registration_invites (created_at DESC);
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'users'::regclass AND conname = 'users_created_via_invite_fk'
          ) THEN
            ALTER TABLE users ADD CONSTRAINT users_created_via_invite_fk
              FOREIGN KEY (created_via_invite_id) REFERENCES registration_invites(id);
          END IF;
          INSERT INTO auth_schema_migrations (version) VALUES (6);
        END IF;
      END $$`,
    // v7：同一队列表同时承载用户任务与系统任务。系统身份不冒用 owner；事件键负责
    // importer 重放去重，活动键负责同一本书在途互斥。领取时递增 lease_generation，
    // 心跳/进度/终态写必须同时匹配 generation + owner，旧执行者不能提交新租约。
    authSchemaV7Statement(tx),
  ]);
}

export class AuthSchemaRequiredError extends Error {
  readonly code = 'AUTH_SCHEMA_MIGRATION_REQUIRED';
  readonly missingVersions: readonly number[];
  constructor(missingVersions: readonly number[] = []) {
    super(missingVersions.length
      ? `personal schema migration is required (missing versions: ${missingVersions.join(', ')})`
      : 'personal schema migration is required');
    this.missingVersions = missingVersions;
  }
}

// 普通请求只读取版本；任何迁移、删约束或默认值变更都由专用脚本执行。
export async function assertAuthSchema(sql: Sql): Promise<void> {
  let rows: { version: number | null }[];
  try { rows = await sql`SELECT version::int AS version FROM auth_schema_migrations` as { version: number | null }[]; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '42P01') throw new AuthSchemaRequiredError();
    throw error;
  }
  // 记账连续性判据：所需版本 1..AUTH_SCHEMA_VERSION 必须**全部在册**，不再只看 max(version)。
  // 账本中间缺号（迁移器漏插某版、或人为删了某版）此前因 max 达标而被放行，冷建库可能缺
  // v5/v6 的 DDL 却全站 200；现在缺号即 503，并在错误信息里报出缺哪些版本。判据与 db:check
  // 的 evaluateSchema 共用 missingLedgerVersions（唯一口径），运行时闸门只读不迁移。
  // 只拦「库落后于代码」——额外的更高版本（灰度/回滚窗口里 DDL 已跑、旧实例还在）不在必需
  // 集里，仍放行不 503；前向保护由 initializeAuthSchema 在库版本 > 7 时 RAISE EXCEPTION 负责。
  const missing = missingLedgerVersions(rows.map((row) => row.version), AUTH_SCHEMA_VERSION);
  if (missing.length) throw new AuthSchemaRequiredError(missing);
}

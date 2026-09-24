// baseline 结构契约（41-BASELINE）：0001→0002→0003 在空库上真跑完之后，这 20 张表的结构全貌。
// 由 PGlite 真库导出（pg_catalog：format_type / pg_get_expr / pg_get_constraintdef / pg_indexes.indexdef），
// 不是手抄：scripts/db-baseline.test.ts 每次都重新跑一遍 0001–0003 并断言导出结果与本文件逐项相等，
// 迁移文件或导出投影一变就红。它只对 BASELINE_CHECKSUMS 那三份迁移字节成立，是冻结产物，与
// PUBLISHED_CHECKSUMS 同理——以后的迁移不改这里（baseline 只替 v1–v3 作证）。
//
// 每张表出自哪段 SQL 见 db-baseline.mjs 的 BASELINE_TABLE_SOURCES。
// columns:     [列名, format_type, NOT NULL, 默认值表达式, identity('d'=BY DEFAULT), 生成列表达式, 所属序列的 pg_sequence 参数]
//              （按列名排序，不比列序；序列参数含 identity 的 START WITH 与 serial 的步长 / 上下限 / cache / cycle）
// constraints: [约束名, contype(p/u/f/c), pg_get_constraintdef]
// indexes:     [索引名, indexdef]
export const BASELINE_SHAPE = {
  app_settings: {
    columns: [
      ["default_model", "text", false, null, null, null, null],
      ["default_model_reasoning", "text", false, null, null, null, null],
      ["default_model_updated_at", "timestamp with time zone", false, null, null, null, null],
      ["id", "integer", true, "1", null, null, null],
      ["label_model", "text", false, null, null, null, null],
      ["label_model_updated_at", "timestamp with time zone", false, null, null, null, null],
      ["llm_model", "text", false, null, null, null, null],
      ["llm_reasoning", "text", false, null, null, null, null],
      ["updated_at", "timestamp with time zone", true, "now()", null, null, null],
    ],
    constraints: [
      ["app_settings_pkey", "p", "PRIMARY KEY (id)"],
    ],
    indexes: [
      ["app_settings_pkey", "CREATE UNIQUE INDEX app_settings_pkey ON public.app_settings USING btree (id)"],
    ],
  },
  auth_rate_limits: {
    columns: [
      ["attempts", "integer", true, null, null, null, null],
      ["expires_at", "timestamp with time zone", true, null, null, null, null],
      ["key_hash", "character(64)", true, null, null, null, null],
      ["scope", "text", true, null, null, null, null],
      ["window_start", "timestamp with time zone", true, null, null, null, null],
    ],
    constraints: [
      ["auth_rate_limits_attempts_check", "c", "CHECK ((attempts >= 0))"],
      ["auth_rate_limits_pkey", "p", "PRIMARY KEY (scope, key_hash, window_start)"],
    ],
    indexes: [
      ["auth_rate_limits_expires_idx", "CREATE INDEX auth_rate_limits_expires_idx ON public.auth_rate_limits USING btree (expires_at)"],
      ["auth_rate_limits_pkey", "CREATE UNIQUE INDEX auth_rate_limits_pkey ON public.auth_rate_limits USING btree (scope, key_hash, window_start)"],
    ],
  },
  auth_schema_migrations: {
    columns: [
      ["applied_at", "timestamp with time zone", true, "now()", null, null, null],
      ["version", "integer", true, null, null, null, null],
    ],
    constraints: [
      ["auth_schema_migrations_pkey", "p", "PRIMARY KEY (version)"],
    ],
    indexes: [
      ["auth_schema_migrations_pkey", "CREATE UNIQUE INDEX auth_schema_migrations_pkey ON public.auth_schema_migrations USING btree (version)"],
    ],
  },
  auth_settings: {
    columns: [
      ["id", "integer", true, null, null, null, null],
      ["members_enabled", "boolean", true, "false", null, null, null],
      ["registration_mode", "text", true, "'closed'::text", null, null, null],
      ["updated_at", "timestamp with time zone", true, "now()", null, null, null],
    ],
    constraints: [
      ["auth_settings_id_check", "c", "CHECK ((id = 1))"],
      ["auth_settings_pkey", "p", "PRIMARY KEY (id)"],
      ["auth_settings_registration_mode_check", "c", "CHECK ((registration_mode = ANY (ARRAY['closed'::text, 'open'::text, 'invite'::text])))"],
    ],
    indexes: [
      ["auth_settings_pkey", "CREATE UNIQUE INDEX auth_settings_pkey ON public.auth_settings USING btree (id)"],
    ],
  },
  books: {
    columns: [
      ["author", "text", true, null, null, null, null],
      ["author_key", "text", false, null, null, "lower(btrim(NORMALIZE(author, NFKC)))", null],
      ["created_at", "timestamp with time zone", true, "now()", null, null, null],
      ["douban_id", "text", false, null, null, null, null],
      ["douban_rating", "double precision", false, null, null, null, null],
      ["douban_rating_count", "integer", false, null, null, null, null],
      ["id", "integer", true, "nextval('books_id_seq'::regclass)", null, null, "type=integer start=1 increment=1 min=1 max=2147483647 cache=1 cycle=f"],
      ["meta", "jsonb", true, "'{}'::jsonb", null, null, null],
      ["title", "text", true, null, null, null, null],
      ["title_key", "text", false, null, null, "lower(btrim(regexp_replace(btrim(NORMALIZE(title, NFKC)), '^《(.+)》$'::text, '\\1'::text)))", null],
    ],
    constraints: [
      ["books_pkey", "p", "PRIMARY KEY (id)"],
    ],
    indexes: [
      ["books_identity_idx", "CREATE UNIQUE INDEX books_identity_idx ON public.books USING btree (title_key, author_key)"],
      ["books_pkey", "CREATE UNIQUE INDEX books_pkey ON public.books USING btree (id)"],
    ],
  },
  cron_health: {
    columns: [
      ["last_success_at", "timestamp with time zone", true, "now()", null, null, null],
      ["name", "text", true, null, null, null, null],
    ],
    constraints: [
      ["cron_health_pkey", "p", "PRIMARY KEY (name)"],
    ],
    indexes: [
      ["cron_health_pkey", "CREATE UNIQUE INDEX cron_health_pkey ON public.cron_health USING btree (name)"],
    ],
  },
  download_tasks: {
    columns: [
      ["author", "text", true, "''::text", null, null, null],
      ["book_id", "integer", true, null, null, null, null],
      ["chapters_done", "integer", true, "0", null, null, null],
      ["chapters_total", "integer", true, "0", null, null, null],
      ["chars_total", "integer", true, "0", null, null, null],
      ["created_at", "timestamp with time zone", true, "now()", null, null, null],
      ["error", "text", true, "''::text", null, null, null],
      ["id", "integer", true, "nextval('download_tasks_id_seq'::regclass)", null, null, "type=integer start=1 increment=1 min=1 max=2147483647 cache=1 cycle=f"],
      ["source_url", "text", true, "''::text", null, null, null],
      ["status", "text", true, "'pending'::text", null, null, null],
      ["title", "text", true, null, null, null, null],
      ["updated_at", "timestamp with time zone", true, "now()", null, null, null],
    ],
    constraints: [
      ["download_tasks_pkey", "p", "PRIMARY KEY (id)"],
    ],
    indexes: [
      ["download_tasks_pkey", "CREATE UNIQUE INDEX download_tasks_pkey ON public.download_tasks USING btree (id)"],
    ],
  },
  feedback: {
    columns: [
      ["book_id", "integer", true, null, null, null, null],
      ["created_at", "timestamp with time zone", true, "now()", null, null, null],
      ["id", "integer", true, "nextval('feedback_id_seq'::regclass)", null, null, "type=integer start=1 increment=1 min=1 max=2147483647 cache=1 cycle=f"],
      ["note", "text", true, "''::text", null, null, null],
      ["status", "text", true, null, null, null, null],
      ["user_id", "integer", true, null, null, null, null],
    ],
    constraints: [
      ["feedback_book_id_fkey", "f", "FOREIGN KEY (book_id) REFERENCES books(id)"],
      ["feedback_pkey", "p", "PRIMARY KEY (id)"],
      ["feedback_user_fk", "f", "FOREIGN KEY (user_id) REFERENCES users(id)"],
    ],
    indexes: [
      ["feedback_pkey", "CREATE UNIQUE INDEX feedback_pkey ON public.feedback USING btree (id)"],
      ["feedback_user_created_idx", "CREATE INDEX feedback_user_created_idx ON public.feedback USING btree (user_id, created_at DESC)"],
    ],
  },
  labeled_books: {
    columns: [
      ["author", "text", true, "''::text", null, null, null],
      ["author_key", "text", false, null, null, "lower(btrim(NORMALIZE(author, NFKC)))", null],
      ["category", "text", true, "''::text", null, null, null],
      ["chars_labeled", "integer", true, "0", null, null, null],
      ["finish_status", "text", true, "''::text", null, null, null],
      ["id", "integer", true, "nextval('labeled_books_id_seq'::regclass)", null, null, "type=integer start=1 increment=1 min=1 max=2147483647 cache=1 cycle=f"],
      ["labeled_at", "timestamp with time zone", true, "now()", null, null, null],
      ["labels", "jsonb", true, "'{}'::jsonb", null, null, null],
      ["primary_genre", "text", true, "''::text", null, null, null],
      ["quality", "double precision", false, null, null, null, null],
      ["source_site", "text", true, "''::text", null, null, null],
      ["source_url", "text", true, "''::text", null, null, null],
      ["sub_tags", "jsonb", true, "'[]'::jsonb", null, null, null],
      ["title", "text", true, null, null, null, null],
      ["title_key", "text", false, null, null, "lower(btrim(regexp_replace(btrim(NORMALIZE(title, NFKC)), '^《(.+)》$'::text, '\\1'::text)))", null],
    ],
    constraints: [
      ["labeled_books_pkey", "p", "PRIMARY KEY (id)"],
    ],
    indexes: [
      ["labeled_books_identity_idx", "CREATE UNIQUE INDEX labeled_books_identity_idx ON public.labeled_books USING btree (title_key, author_key)"],
      ["labeled_books_pkey", "CREATE UNIQUE INDEX labeled_books_pkey ON public.labeled_books USING btree (id)"],
    ],
  },
  llm_usage: {
    columns: [
      ["cache_tokens", "bigint", true, "0", null, null, null],
      ["completion_tokens", "bigint", true, "0", null, null, null],
      ["created_at", "timestamp with time zone", true, "now()", null, null, null],
      ["id", "bigint", true, "nextval('llm_usage_id_seq'::regclass)", null, null, "type=bigint start=1 increment=1 min=1 max=9223372036854775807 cache=1 cycle=f"],
      ["model", "text", true, null, null, null, null],
      ["phase", "text", true, null, null, null, null],
      ["prompt_tokens", "bigint", true, "0", null, null, null],
      ["request_id", "text", false, null, null, null, null],
      ["total_tokens", "bigint", false, null, null, null, null],
      ["usage_details", "jsonb", true, "'{}'::jsonb", null, null, null],
      ["usage_missing", "boolean", true, "true", null, null, null],
    ],
    constraints: [
      ["llm_usage_cache_tokens_check", "c", "CHECK ((cache_tokens >= 0))"],
      ["llm_usage_completion_tokens_check", "c", "CHECK ((completion_tokens >= 0))"],
      ["llm_usage_phase_check", "c", "CHECK ((phase = ANY (ARRAY['find_recall'::text, 'find_rerank'::text, 'profile'::text, 'feedback'::text])))"],
      ["llm_usage_pkey", "p", "PRIMARY KEY (id)"],
      ["llm_usage_prompt_tokens_check", "c", "CHECK ((prompt_tokens >= 0))"],
      ["llm_usage_total_tokens_check", "c", "CHECK ((total_tokens >= 0))"],
    ],
    indexes: [
      ["llm_usage_phase_created_at_idx", "CREATE INDEX llm_usage_phase_created_at_idx ON public.llm_usage USING btree (phase, created_at DESC)"],
      ["llm_usage_pkey", "CREATE UNIQUE INDEX llm_usage_pkey ON public.llm_usage USING btree (id)"],
    ],
  },
  profile: {
    columns: [
      ["content", "text", true, "''::text", null, null, null],
      ["id", "integer", true, null, null, null, null],
      ["seeds", "jsonb", true, "'[]'::jsonb", null, null, null],
      ["updated_at", "timestamp with time zone", true, "now()", null, null, null],
    ],
    constraints: [
      ["profile_pkey", "p", "PRIMARY KEY (id)"],
      ["profile_user_fk", "f", "FOREIGN KEY (id) REFERENCES users(id)"],
    ],
    indexes: [
      ["profile_pkey", "CREATE UNIQUE INDEX profile_pkey ON public.profile USING btree (id)"],
    ],
  },
  profile_feedback_queue: {
    columns: [
      ["absorbed_feedback_id", "integer", true, "0", null, null, null],
      ["attempts", "integer", true, "0", null, null, null],
      ["fail_count", "integer", true, "0", null, null, null],
      ["last_error", "text", true, "''::text", null, null, null],
      ["lease_expires_at", "timestamp with time zone", false, null, null, null, null],
      ["lease_token", "text", true, "''::text", null, null, null],
      ["next_eligible_at", "timestamp with time zone", false, null, null, null, null],
      ["pending_feedback_id", "integer", false, null, null, null, null],
      ["status", "text", true, "'unchanged'::text", null, null, null],
      ["updated_at", "timestamp with time zone", true, "now()", null, null, null],
      ["user_id", "integer", true, null, null, null, null],
    ],
    constraints: [
      ["profile_feedback_queue_pkey", "p", "PRIMARY KEY (user_id)"],
      ["profile_feedback_queue_user_fk", "f", "FOREIGN KEY (user_id) REFERENCES users(id)"],
    ],
    indexes: [
      ["profile_feedback_queue_pkey", "CREATE UNIQUE INDEX profile_feedback_queue_pkey ON public.profile_feedback_queue USING btree (user_id)"],
    ],
  },
  profile_seed_audit: {
    columns: [
      ["added_titles", "jsonb", true, null, null, null, null],
      ["created_at", "timestamp with time zone", true, "now()", null, null, null],
      ["id", "bigint", true, "nextval('profile_seed_audit_id_seq'::regclass)", null, null, "type=bigint start=1 increment=1 min=1 max=9223372036854775807 cache=1 cycle=f"],
      ["previous_seeds", "jsonb", true, null, null, null, null],
      ["previous_version", "text", true, null, null, null, null],
      ["removed_titles", "jsonb", true, null, null, null, null],
      ["saved_seeds", "jsonb", true, null, null, null, null],
      ["saved_version", "text", true, null, null, null, null],
      ["user_id", "integer", true, null, null, null, null],
    ],
    constraints: [
      ["profile_seed_audit_pkey", "p", "PRIMARY KEY (id)"],
    ],
    indexes: [
      ["profile_seed_audit_pkey", "CREATE UNIQUE INDEX profile_seed_audit_pkey ON public.profile_seed_audit USING btree (id)"],
      ["profile_seed_audit_user_time_idx", "CREATE INDEX profile_seed_audit_user_time_idx ON public.profile_seed_audit USING btree (user_id, created_at DESC)"],
    ],
  },
  recommendations: {
    columns: [
      ["book_id", "integer", true, null, null, null, null],
      ["created_at", "timestamp with time zone", true, "now()", null, null, null],
      ["hit_likes", "jsonb", false, null, null, null, null],
      ["id", "integer", true, "nextval('recommendations_id_seq'::regclass)", null, null, "type=integer start=1 increment=1 min=1 max=2147483647 cache=1 cycle=f"],
      ["match_score", "double precision", false, null, null, null, null],
      ["query", "text", true, null, null, null, null],
      ["reason", "text", false, null, null, null, null],
      ["risks", "text", false, null, null, null, null],
      ["status", "text", true, "'new'::text", null, null, null],
      ["user_id", "integer", true, null, null, null, null],
    ],
    constraints: [
      ["recommendations_book_id_fkey", "f", "FOREIGN KEY (book_id) REFERENCES books(id)"],
      ["recommendations_pkey", "p", "PRIMARY KEY (id)"],
      ["recommendations_user_fk", "f", "FOREIGN KEY (user_id) REFERENCES users(id)"],
    ],
    indexes: [
      ["recommendations_pkey", "CREATE UNIQUE INDEX recommendations_pkey ON public.recommendations USING btree (id)"],
      ["recommendations_user_book_query_idx", "CREATE UNIQUE INDEX recommendations_user_book_query_idx ON public.recommendations USING btree (user_id, book_id, query)"],
      ["recommendations_user_created_idx", "CREATE INDEX recommendations_user_created_idx ON public.recommendations USING btree (user_id, created_at DESC)"],
    ],
  },
  sessions: {
    columns: [
      ["auth_method", "text", true, null, null, null, null],
      ["created_at", "timestamp with time zone", true, "now()", null, null, null],
      ["expires_at", "timestamp with time zone", true, null, null, null, null],
      ["owner_credential_tag", "character(64)", false, null, null, null, null],
      ["token_hash", "character(64)", true, null, null, null, null],
      ["user_id", "integer", true, null, null, null, null],
    ],
    constraints: [
      ["sessions_auth_method_check", "c", "CHECK ((auth_method = ANY (ARRAY['password'::text, 'owner_token'::text])))"],
      ["sessions_check", "c", "CHECK ((expires_at > created_at))"],
      ["sessions_check1", "c", "CHECK (((auth_method = 'owner_token'::text) = (user_id = 1)))"],
      ["sessions_check2", "c", "CHECK ((((auth_method = 'owner_token'::text) AND (owner_credential_tag IS NOT NULL)) OR ((auth_method = 'password'::text) AND (owner_credential_tag IS NULL))))"],
      ["sessions_pkey", "p", "PRIMARY KEY (token_hash)"],
      ["sessions_token_hash_check", "c", "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))"],
      ["sessions_user_id_fkey", "f", "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE"],
    ],
    indexes: [
      ["sessions_expires_idx", "CREATE INDEX sessions_expires_idx ON public.sessions USING btree (expires_at)"],
      ["sessions_pkey", "CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (token_hash)"],
      ["sessions_user_created_idx", "CREATE INDEX sessions_user_created_idx ON public.sessions USING btree (user_id, created_at DESC)"],
    ],
  },
  shuyuan_meta: {
    columns: [
      ["collections", "jsonb", true, "'[]'::jsonb", null, null, null],
      ["id", "integer", true, "1", null, null, null],
      ["refreshed_at", "timestamp with time zone", false, null, null, null, null],
    ],
    constraints: [
      ["shuyuan_meta_pkey", "p", "PRIMARY KEY (id)"],
    ],
    indexes: [
      ["shuyuan_meta_pkey", "CREATE UNIQUE INDEX shuyuan_meta_pkey ON public.shuyuan_meta USING btree (id)"],
    ],
  },
  shuyuan_sources: {
    columns: [
      ["disabled_at", "timestamp with time zone", false, null, null, null, null],
      ["group_name", "text", true, "''::text", null, null, null],
      ["id", "integer", true, "nextval('shuyuan_sources_id_seq'::regclass)", null, null, "type=integer start=1 increment=1 min=1 max=2147483647 cache=1 cycle=f"],
      ["last_error", "text", true, "''::text", null, null, null],
      ["name", "text", true, "''::text", null, null, null],
      ["source", "jsonb", true, null, null, null, null],
      ["source_url", "text", true, null, null, null, null],
      ["updated_at", "timestamp with time zone", true, "now()", null, null, null],
    ],
    constraints: [
      ["shuyuan_sources_pkey", "p", "PRIMARY KEY (id)"],
      ["shuyuan_sources_source_url_key", "u", "UNIQUE (source_url)"],
    ],
    indexes: [
      ["shuyuan_sources_pkey", "CREATE UNIQUE INDEX shuyuan_sources_pkey ON public.shuyuan_sources USING btree (id)"],
      ["shuyuan_sources_source_url_key", "CREATE UNIQUE INDEX shuyuan_sources_source_url_key ON public.shuyuan_sources USING btree (source_url)"],
    ],
  },
  source_admission: {
    columns: [
      ["compile_diagnostics", "jsonb", true, "'[]'::jsonb", null, null, null],
      ["compile_ok", "boolean", true, null, null, null, null],
      ["core_field_mask", "jsonb", true, null, null, null, null],
      ["engine_semantics_version", "integer", true, "0", null, null, null],
      ["error", "text", true, "''::text", null, null, null],
      ["host", "text", true, null, null, null, null],
      ["id", "integer", true, "nextval('source_admission_id_seq'::regclass)", null, null, "type=integer start=1 increment=1 min=1 max=2147483647 cache=1 cycle=f"],
      ["rules_hash", "text", true, null, null, null, null],
      ["search_checked_at", "timestamp with time zone", false, null, null, null, null],
      ["search_ok", "boolean", false, null, null, null, null],
      ["search_verdict", "text", true, "''::text", null, null, null],
      ["source_url", "text", true, null, null, null, null],
      ["tier", "text", true, null, null, null, null],
    ],
    constraints: [
      ["source_admission_pkey", "p", "PRIMARY KEY (id)"],
      ["source_admission_source_url_key", "u", "UNIQUE (source_url)"],
    ],
    indexes: [
      ["source_admission_host_idx", "CREATE INDEX source_admission_host_idx ON public.source_admission USING btree (host)"],
      ["source_admission_pkey", "CREATE UNIQUE INDEX source_admission_pkey ON public.source_admission USING btree (id)"],
      ["source_admission_source_url_key", "CREATE UNIQUE INDEX source_admission_source_url_key ON public.source_admission USING btree (source_url)"],
    ],
  },
  source_read_catalogs: {
    columns: [
      ["expires_at", "timestamp with time zone", true, null, null, null, null],
      ["id", "text", true, null, null, null, null],
      ["payload", "jsonb", true, null, null, null, null],
    ],
    constraints: [
      ["source_read_catalogs_pkey", "p", "PRIMARY KEY (id)"],
    ],
    indexes: [
      ["source_read_catalogs_expiry_idx", "CREATE INDEX source_read_catalogs_expiry_idx ON public.source_read_catalogs USING btree (expires_at)"],
      ["source_read_catalogs_pkey", "CREATE UNIQUE INDEX source_read_catalogs_pkey ON public.source_read_catalogs USING btree (id)"],
    ],
  },
  users: {
    columns: [
      ["can_download", "boolean", true, "false", null, null, null],
      ["can_find", "boolean", true, "true", null, null, null],
      ["can_read", "boolean", true, "false", null, null, null],
      ["created_at", "timestamp with time zone", true, "now()", null, null, null],
      ["created_via_invite_id", "integer", false, null, null, null, null],
      ["disabled_at", "timestamp with time zone", false, null, null, null, null],
      ["id", "integer", true, null, "d", null, "type=integer start=2 increment=1 min=1 max=2147483647 cache=1 cycle=f"],
      ["password_hash", "text", false, null, null, null, null],
      ["role", "text", true, "'member'::text", null, null, null],
      ["updated_at", "timestamp with time zone", true, "now()", null, null, null],
      ["username", "text", true, null, null, null, null],
    ],
    constraints: [
      ["users_check", "c", "CHECK ((((id = 1) AND (username = 'owner'::text) AND (role = 'owner'::text) AND (password_hash IS NULL) AND (disabled_at IS NULL) AND can_find AND can_read AND can_download) OR ((id > 1) AND (username <> 'owner'::text) AND (role = 'member'::text) AND (password_hash IS NOT NULL))))"],
      ["users_check1", "c", "CHECK (((NOT can_read) OR can_find))"],
      ["users_check2", "c", "CHECK (((NOT can_download) OR (can_find AND can_read)))"],
      ["users_pkey", "p", "PRIMARY KEY (id)"],
      ["users_role_check", "c", "CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text])))"],
      ["users_username_check", "c", "CHECK ((username ~ '^[a-z][a-z0-9_]{2,31}$'::text))"],
      ["users_username_key", "u", "UNIQUE (username)"],
    ],
    indexes: [
      ["users_pkey", "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)"],
      ["users_username_key", "CREATE UNIQUE INDEX users_username_key ON public.users USING btree (username)"],
    ],
  },
};

// runner（db-migration-lib.mjs 的 SCHEMA_MIGRATIONS_DDL）建出的记账表形状。baseline 遇到「记账表在但 0 行」时
// 要求形状与它一致才视同未登记（复审 baserev41 #1），测试同样重跑迁移钉住。
export const BASELINE_LEDGER_SHAPE = {
  schema_migrations: {
    columns: [
      ["applied_at", "timestamp with time zone", true, "now()", null, null, null],
      ["checksum", "character(64)", true, null, null, null, null],
      ["name", "text", true, null, null, null, null],
      ["version", "integer", true, null, null, null, null],
    ],
    constraints: [
      ["schema_migrations_pkey", "p", "PRIMARY KEY (version)"],
    ],
    indexes: [
      ["schema_migrations_pkey", "CREATE UNIQUE INDEX schema_migrations_pkey ON public.schema_migrations USING btree (version)"],
    ],
  },
};

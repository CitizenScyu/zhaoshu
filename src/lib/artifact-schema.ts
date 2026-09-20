import type { neon } from '@neondatabase/serverless';

/** Explicit migration only: never run DDL on a reader request. Independent of auth/T1 versions. */
export async function initializeArtifactSchema(sql: ReturnType<typeof neon>) {
  await sql.transaction(tx => [
    tx`SELECT pg_advisory_xact_lock(72402102)`,
    tx`CREATE TABLE IF NOT EXISTS artifact_schema_migrations (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`,
    tx`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM artifact_schema_migrations WHERE version > 1) THEN
        RAISE EXCEPTION 'unsupported artifact schema version';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM artifact_schema_migrations WHERE version = 1) THEN
        CREATE TABLE IF NOT EXISTS storage_repositories (
          id serial PRIMARY KEY,
          owner text NOT NULL CHECK (owner ~ '^[A-Za-z0-9_.-]+$' AND owner NOT IN ('.', '..')),
          repo text NOT NULL CHECK (repo ~ '^[A-Za-z0-9_.-]+$' AND repo NOT IN ('.', '..')),
          branch text NOT NULL CHECK (length(branch) > 0),
          enabled boolean NOT NULL DEFAULT false,
          is_private boolean NOT NULL DEFAULT true,
          read_only boolean NOT NULL DEFAULT false,
          sealed_at timestamptz,
          registered_bytes bigint NOT NULL DEFAULT 0 CHECK (registered_bytes >= 0),
          reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
          current_tree_bytes bigint CHECK (current_tree_bytes >= 0),
          github_size_kib bigint CHECK (github_size_kib >= 0),
          capacity_observed_at timestamptz,
          target_bytes bigint NOT NULL DEFAULT 1000000000 CHECK (target_bytes > 0)
        );
        -- GitHub repository names are case-insensitive: aliases must not evade path claims.
        CREATE UNIQUE INDEX IF NOT EXISTS storage_repositories_identity_idx ON storage_repositories(lower(owner), lower(repo));
        COMMENT ON COLUMN storage_repositories.registered_bytes IS
          'Observed registered canonical TXT logical bytes; excludes snapshots/history; not an exact capacity lock';
        COMMENT ON COLUMN storage_repositories.reserved_bytes IS
          'Observed in-flight publication budget; worker must reconcile; not an exact capacity lock';
        COMMENT ON COLUMN storage_repositories.current_tree_bytes IS
          'Observed logical bytes across current tree, including snapshots; not physical Git size';
        COMMENT ON COLUMN storage_repositories.github_size_kib IS
          'GitHub repository size observation in KiB; delayed, not interchangeable with TXT bytes or an exact lock';
        CREATE TABLE IF NOT EXISTS book_artifacts (
          id bigserial PRIMARY KEY,
          labeled_book_id integer NOT NULL REFERENCES labeled_books(id),
          identity_key text NOT NULL UNIQUE CHECK (length(identity_key) > 0),
          repository_id integer NOT NULL REFERENCES storage_repositories(id),
          branch text NOT NULL CHECK (length(branch) > 0),
          canonical_path text NOT NULL CHECK (length(canonical_path) > 0),
          snapshot_path text,
          version text NOT NULL DEFAULT '',
          blob_sha text CHECK (blob_sha ~ '^[a-f0-9]{40}$'),
          bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
          chapters_total integer NOT NULL DEFAULT 0 CHECK (chapters_total >= 0),
          chapters_done integer NOT NULL DEFAULT 0 CHECK (chapters_done >= 0 AND chapters_done <= chapters_total),
          chars bigint NOT NULL DEFAULT 0 CHECK (chars >= 0),
          source_revision text NOT NULL DEFAULT '',
          quality_status text NOT NULL DEFAULT 'reserved'
            CHECK (quality_status IN ('reserved', 'candidate', 'published', 'rejected')),
          published_at timestamptz,
          CONSTRAINT book_artifacts_path_key UNIQUE (repository_id, branch, canonical_path),
          CHECK (quality_status <> 'published' OR
            (published_at IS NOT NULL AND blob_sha IS NOT NULL AND bytes > 0 AND version <> ''))
        );
        CREATE INDEX IF NOT EXISTS book_artifacts_labeled_book_idx ON book_artifacts(labeled_book_id);
        -- T1 can independently add the nullable bigint seam before T2 arrives.
        ALTER TABLE download_tasks ADD COLUMN IF NOT EXISTS artifact_id bigint;
        CREATE INDEX IF NOT EXISTS download_tasks_artifact_idx ON download_tasks(artifact_id) WHERE artifact_id IS NOT NULL;
        INSERT INTO artifact_schema_migrations(version) VALUES (1);
      END IF;
      -- Rollback may drop only the FK while retaining v1; replay must repair it.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'download_tasks'::regclass
        AND conname = 'download_tasks_artifact_fk') THEN
        ALTER TABLE download_tasks ADD CONSTRAINT download_tasks_artifact_fk
          FOREIGN KEY (artifact_id) REFERENCES book_artifacts(id);
      END IF;
    END $$`,
  ]);
}

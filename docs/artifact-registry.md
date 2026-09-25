# Artifact registry (T2)

`initializeArtifactSchema(sql)` is an explicit, additive migration exported by
`business-schema.ts`. Run it only after the existing business tables exist. It uses
its own `artifact_schema_migrations` ledger (versions 1 and 2), a transaction and a
transaction advisory lock. Version 2 (41-bookidfk) adds `download_tasks_book_fk`:
`download_tasks.book_id` → `labeled_books(id)`, see below. It does not modify auth migrations or require T1. It also accepts
T1's pre-existing nullable bigint `artifact_id` column and adds the foreign key;
either migration order is supported. Existing dangling IDs fail the migration
transaction instead of being silently reassigned. The local/test
entry point is `node --experimental-strip-types scripts/migrate-artifacts.mjs`,
which accepts only the guarded `TEST_DATABASE_URL`; it is not run by requests.
`ARTIFACT_SCHEMA_VERSION` (`src/lib/artifact-schema.ts`) is the version constant
`db:check:prod` and the production entry point compare against.

## Production entry point and cold-build

`npm run migrate:artifacts:prod -- --database-url-env=<VAR> (--dry-run | --yes-i-mean-production)`
(`scripts/migrate-artifacts-prod.mjs`) is the production/DR counterpart of
`migrate-artifacts.mjs`: same constraint set as `migrate:auth:prod` — the target
must be named explicitly via `--database-url-env`, and neither `DATABASE_URL` nor
`TEST_DATABASE_URL` is accepted as that name. The migration body is exactly
`initializeArtifactSchema` (no DDL is copied), so it is idempotent and repeatable;
`--dry-run` is read-only and reports the current ledger version and the steps that
would run. `db:check:prod` requires the three artifact tables
(`artifact_schema_migrations`, `storage_repositories`, `book_artifacts`) and an
artifact ledger version ≥ `ARTIFACT_SCHEMA_VERSION` (2); a cold-built database that never ran this entry point
fails the check with `artifactVersionOk: false` instead of silently passing
(tempdb41 §缺陷 D1: the T8 worker used to start with
`relation "storage_repositories" does not exist`).

## `download_tasks.book_id` foreign key (v2, 41-bookidfk)

`download_tasks.book_id` shares the `labeled_books` id space with
`book_artifacts.labeled_book_id` (the ID-space red line in `importer-enqueue.ts` and
`backfill-plan.ts`). Before v2 nothing enforced it: t8fk-41 found 296 system tasks whose
`book_id` was a row ordinal (1..296) instead of a `labeled_books.id`. They were enqueued
silently and only failed after downloading every chapter, when `reserveArtifactPath`
hit `book_artifacts_labeled_book_id_fkey`. v2 moves that rejection to enqueue time for
every writer, including unversioned one-off scripts.

- **ON DELETE NO ACTION** (the default), the same as `book_artifacts_labeled_book_id_fkey`.
  No code path deletes `labeled_books` rows (importers only upsert), and CASCADE would
  silently erase user download history; SET NULL is impossible (`book_id` is NOT NULL).
- **Existing orphans abort the migration; nothing is deleted.** `migrate:artifacts:prod`
  counts rows whose `book_id` is not in `labeled_books` first (read-only, both in
  `--dry-run` and before apply). If the count is > 0 it reports `plan.status: refused`
  with the count and the `book_id` range, does not call the migration, and exits with
  code 2. `initializeArtifactSchema` re-counts under `LOCK TABLE labeled_books,
  download_tasks IN SHARE ROW EXCLUSIVE MODE` and raises
  `download_tasks has N rows whose book_id is not in labeled_books` if an orphan slipped
  in after the dry-run; the whole batch rolls back (no FK, no v2 ledger row).
- If v2 is recorded but the FK was dropped later, a rerun re-adds it with the same check.
- In the worker, a `book_artifacts` insert that still hits the `labeled_books` FK (a
  database that has not run v2) is reported as
  `LABELED_BOOK_MISSING: labeled_books id=<n> 不存在…` instead of the raw PostgreSQL text.

### Pre-rollout check (operator, per database)

Run read-only first; clean up only after reviewing the rows (take a backup or Neon
branch before the DELETE). The migration itself never deletes data.

```sql
-- 1) count and range of orphan tasks (expected 0 before migrate:artifacts:prod)
SELECT count(*) AS orphan_tasks, min(book_id), max(book_id)
FROM download_tasks t
WHERE NOT EXISTS (SELECT 1 FROM labeled_books lb WHERE lb.id = t.book_id);

-- 2) what they are: status / requester / artifact linkage / retry references
SELECT status, requested_by, count(*) AS n,
       count(*) FILTER (WHERE artifact_id IS NOT NULL) AS with_artifact,
       count(*) FILTER (WHERE user_id IS NOT NULL) AS user_tasks
FROM download_tasks t
WHERE NOT EXISTS (SELECT 1 FROM labeled_books lb WHERE lb.id = t.book_id)
GROUP BY 1, 2 ORDER BY 1, 2;

-- 3) rows elsewhere pointing at them (retry_of is ON DELETE SET NULL; artifact_id is the task's own column)
SELECT count(*) FROM download_tasks r
WHERE r.retry_of IN (SELECT t.id FROM download_tasks t
  WHERE NOT EXISTS (SELECT 1 FROM labeled_books lb WHERE lb.id = t.book_id));

-- 4) only after review, in a transaction; check the row count equals query 1 before COMMIT
BEGIN;
DELETE FROM download_tasks t
WHERE NOT EXISTS (SELECT 1 FROM labeled_books lb WHERE lb.id = t.book_id);
-- COMMIT;  or ROLLBACK;
```

Then `migrate:artifacts:prod --dry-run` (expect `bookIdIntegrity.orphanTasks: 0`,
`plan.pending` = `[2]` on a v1 database) → `--yes-i-mean-production` → `db:check:prod`
(exit 0, `artifactVersion: 2`). Until v2 is applied, `db:check:prod` on an existing v1
database reports `artifactVersionOk: false` (exit 2) — that is the intended signal.

## Registering the publishing repository

A database built this way has **empty** registry tables. Register the publishing
repository before starting the T8 worker, otherwise
`runtime-download/repository.ts` cannot resolve a writable row:

```powershell
$env:DR_DATABASE_URL = '<目标库连接串>'
# dry-run 先看会做什么；仓库键从 --repo/--branch 或 ZHAOSHU_BOOKS_REPO / DOWNLOAD_TARGET_BRANCH 读出
npm run register:storage:prod -- --database-url-env=DR_DATABASE_URL
npm run register:storage:prod -- --database-url-env=DR_DATABASE_URL --apply
```

`scripts/register-storage-repository.mjs` inserts one row matching the registry's
own writability predicate (`enabled ∧ is_private ∧ ¬read_only ∧ sealed_at IS NULL`,
the same one `resolveRepositoryId` uses). It is idempotent on the identity index
`storage_repositories_identity_idx` (case-insensitive `owner`/`repo`, branch-agnostic):
an existing writable row is a no-op, and an existing row that fails the predicate
(disabled / public / read-only / sealed) or points at a different branch is reported
as `refused` (exit code 2) rather than silently edited — do not unseal a repository
by hand to get past it. No credentials are involved; only `owner`/`repo`/`branch`
are read from existing configuration.

Readers select the optional `download_tasks.artifact_id` through `to_jsonb`, so a
pre-migration database and migrated legacy tasks both retain the old protocol.
Published artifacts resolve their repository, recorded branch and canonical path
without directory guessing. A reserved/rejected/missing pointer fails closed;
it does not fall back to a different legacy file. Repository enabled/private/sealed
settings gate allocation, not historical reads. Download ownership and shared
completed-task reading remain unchanged.

## Worker integration

1. Derive `artifactIdentityKey(title, author)` from the unsanitized identity. It
   hashes the existing canonical identity, including its NUL separator, into a
   database-safe full SHA-256 string. Never use the truncated filename as identity.
2. Call `reserveArtifactPath(sql, input)` **before** a GitHub write. The helper
   returns an artifact ID and persists a `reserved` claim. Repeat identical claims
   are idempotent. A different identity at the same repository/branch/path returns
   `ARTIFACT_PATH_COLLISION`; a relocation of an existing identity returns
   `ARTIFACT_IDENTITY_CONFLICT`. An ineligible repository returns
   `REPOSITORY_NOT_WRITABLE`. No claim is automatically deleted or reassigned.
3. T3 must provide its single-writer/lease checks, capacity reservation accounting,
   snapshot validation and publication protocol. After successful publication,
   update the artifact's complete metadata and published status, and attach its ID
   to the completed task in the same DB transaction. Do not expose a reserved
   claim as a completed artifact. Do not change a previously published pointer to
   candidate while evaluating an update: old readable content must remain available.

One unique identity represents one canonical location; this is not a version
history table. `snapshot_path` and `version` describe its current publication.
Keep historical snapshots/manifests in the publisher's protocol. Cross-repository
relocation requires a separate controlled migration; this helper refuses it.
Old unregistered files are not protected by a DB claim: backfill and verify their
identity/path/hash before a worker adopts an existing repository. T2 does not
write to GitHub, backfill records, or implement publication/fencing.

`registered_bytes` measures observed canonical TXT logical bytes;
`current_tree_bytes` measures observed tree logical bytes including snapshots;
`github_size_kib` is GitHub's delayed repository-size observation; `reserved_bytes`
is an observed in-flight budget. They are not interchangeable and **none is an
exact capacity lock**. T3/T8 must reconcile and enforce allocation separately.

## Raw responses and rollback

[GitHub Contents API](https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28)
supports raw/object media types for 1–100 MB files. Object metadata has empty
`content` and `encoding: "none"`; neither existing fallback reads that field.
Both readers fetch actual bytes with raw media types. The online reader's
**single-file** limit is 16 MiB (a tampered manifest must not make the server
fetch a huge "volume"); the **whole-book** limit is gone — a volume-split
artifact (`canonical_path` ends in `/index.json`) declares the book's logical
bytes as `Σ volumes[].bytes` in its manifest, and chapters are fetched one
volume at a time. Publishing still caps a book at 64 MiB (an in-memory
constraint). Files over 100 MB require a separate API/protocol.

Rollback preserves the added tables, column and all registered locations. Pause
new allocation/publication and use this compatible reader; reverting the global
legacy repo cannot relocate new artifacts. Do not drop registry data or erase
claims to retry a failed publication. This change has no production migration,
deployment, repository creation or secret configuration side effects.

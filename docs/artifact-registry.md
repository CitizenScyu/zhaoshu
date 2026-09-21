# Artifact registry (T2)

`initializeArtifactSchema(sql)` is an explicit, additive migration exported by
`business-schema.ts`. Run it only after the existing business tables exist. It uses
its own `artifact_schema_migrations` version 1, a transaction and a transaction
advisory lock. It does not modify auth migrations or require T1. It also accepts
T1's pre-existing nullable bigint `artifact_id` column and adds the foreign key;
either migration order is supported. Existing dangling IDs fail the migration
transaction instead of being silently reassigned. The local/test
entry point is `node --experimental-strip-types scripts/migrate-artifacts.mjs`,
which accepts only the guarded `TEST_DATABASE_URL`; it is not run by requests.

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

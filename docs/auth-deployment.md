# Authentication deployment baseline

## A01 behavior

- `AUTH_ACCOUNTS_ENABLED` is disabled unless its later implementation explicitly recognizes an enabled value. A01 does not open registration or member access.
- The database row `auth_settings.id=1` is initialized with `members_enabled=false` and `registration_mode='closed'`.
- `APP_OWNER_TOKEN` remains the only active credential. It is never copied into `users`; fixed owner `users.id=1` has no password hash.
- `/api/owner` and existing business routes retain their synchronous, database-free owner-token behavior. `AUTH_SECURITY_SECRET` is reserved for A02 and its absence cannot disable the old mode.

## Isolated migration and verification

Both commands require an explicit `TEST_DATABASE_URL`:

```powershell
npm run migrate:auth
npm run test:auth-db
```

They intentionally never fall back to `DATABASE_URL`. The migration acquires a transaction advisory lock, checks the supported schema version, initializes the fixed owner and closed settings idempotently, and rejects conflicting owner identity instead of overwriting it.

Use only a dedicated empty or A01-only test database with `test:auth-db`; its identity-sequence check consumes one sequence value. No A01 command migrates existing business tables or creates member accounts.

## Opening gate and rollback floor

Do not enable member access until A02-A08 authentication, ownership isolation, negative permission tests, real isolated-database concurrency tests, browser state isolation, and rollback rehearsal are complete. A01's rollback floor is the existing `APP_OWNER_TOKEN` path plus schema version 1. The new tables may remain unused during rollback; do not drop them or reinterpret existing rows as members.

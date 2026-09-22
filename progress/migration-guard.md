# A pending migration failing loudly instead of confusingly

Branch `feature/collab-vertical-slice`.

## The defect

Three separate, expensive incidents, all with the identical root cause -- a database missing one
or more migrations -- and none of them looked like a migration problem at the time:

1. The owner's dev database sat two migrations behind during the billing work. Discovered only
   when a feature failed.
2. The first Railway deployment ran with zero migrations applied, because the deprecated
   `railway.toml` was inert. Sign-up failed with `relation "user" does not exist` while the
   healthcheck stayed green (fixed separately; see `progress/deploy-config.md` and
   `.railway/railway.ts`'s `preDeploy` step).
3. Most recently: the dev database was at 6 of 7 migrations. `apps/collab`'s `onLoadDocument`
   failed with `relation "document_yjs_state" does not exist`, which surfaced as an authentication
   denial and, before an unrelated fix, as a silent permanent hang. Three sessions of diagnosis and
   two wrong theories -- the actual cause was a missing table.

The common thread: `pnpm test`, `pnpm test:integration`, and `pnpm test:system:persistence` each
migrate a throwaway database from scratch, so a fully green suite says nothing about whether the
developer's own database is current. Nothing in the repository ever checked that before a real
server process started against it.

## Where the check lives, and why

`packages/database/src/migrationCheck.ts` (plus `migrationStatus.ts` for the pure comparison and
`migrationCheckMessage.ts` for the message), invoked once by a new `db:check-migrations` script
that root `pnpm dev` runs between `build:packages` and starting `apps/api`/`apps/web`/`apps/collab`
in parallel.

Not duplicated into each server's own boot sequence: `apps/api` and `apps/collab` both start
against the identical `DATABASE_URL`, so a check at each boot would be the same query run twice,
and under `pnpm dev`'s `--parallel --stream` a shared failure would print as two interleaved,
redundant diagnoses instead of one clear one. A single preflight, gating the whole stack before
either server starts, is both less code and a better failure experience than two copies.

Not inlined directly into the root `dev` script either: the comparison and the database read are
real logic with edge cases (see below), which belongs behind unit tests, not embedded in a shell
one-liner.

## How "behind" is decided, and what a naive version misses

The two sides being compared: `packages/database/drizzle/meta/_journal.json` (plus each numbered
`.sql` file it lists) is this checkout's own record of what migrations exist; `drizzle.
__drizzle_migrations` is the database's own record of what it has applied -- the identical
bookkeeping table drizzle-orm's own migrator reads and writes (confirmed by reading the installed
`pg-core/dialect.cjs`).

A row-count comparison ("7 on disk, 6 applied") was the obvious first idea, and the one most easily
fooled: it says nothing about whether the applied migrations are the _same_ migrations in the
_same_ order. Concretely, it cannot distinguish an ordinary pending migration from an already
-applied migration file that was edited after the fact (count unchanged on both sides) or from
migrations squashed/reordered in a way that happens to leave the counts equal.

The check instead compares by content hash -- the same sha256-of-raw-file-contents drizzle's own
migrator computes and stores per applied row -- position by position, for as much as the two lists
overlap. Only once every overlapping entry matches byte-for-byte does the remaining length
difference decide the outcome:

- **`behind`**: the journal has entries the database does not. Names every pending migration tag.
- **`ahead`**: the database has more applied rows than the journal lists on disk (most likely a
  stale checkout relative to whichever branch last migrated this database, or the wrong database).
- **`diverged`**: an overlapping entry does not match by hash -- the database's applied history and
  this checkout's journal disagree about something that already happened. Reported distinctly
  because blindly running `db:migrate` against a diverged history is not safe, and a plain
  pending-migration count could never tell the two apart.
- **`upToDate`**: everything matches.

`compareMigrationState` (`migrationStatus.ts`) is the pure function computing this -- no
filesystem, no database -- and is unit-tested directly for all four outcomes above, including the
count-equal-but-diverged case a naive comparison would misreport as current.

## Unreachable database vs. missing table vs. pending migration

A database that cannot be reached at all (Postgres down, wrong host) is classified separately, and
first, before any migration comparison is attempted -- Node/pg's own connection-level error codes
(`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `ETIMEDOUT`) and pg's own
`'timeout expired'` message (thrown when `connectionTimeoutMillis` elapses against a silently
unresponsive host). This is a deliberate, named result (`unreachable`), distinct from `behind`: the
owner's own second-listed incident was misdiagnosed the other way once already, and conflating the
two here would make that mistake easy to repeat.

A database that _can_ be reached, but has never had a migration applied to it, is not an error
either -- a `select` against `drizzle.__drizzle_migrations` on such a database fails with
Postgres's `undefined_table` (`42P01`), which is read as "zero migrations applied" (i.e. every
journal entry pending), not surfaced as a failure. The check never creates the schema or table
itself; it is read-only, unlike drizzle's own migrator which `CREATE ... IF NOT EXISTS`s it as a
side effect of running.

Any other query failure (bad credentials, insufficient privilege) gets its own `queryFailed`
result rather than being folded into either bucket, since neither "start Postgres" nor "run
db:migrate" is the right next step for it.

## The message

Printed directly to the terminal as plain text (not the JSON structured logs `apps/api`/
`apps/collab` use in production) -- this runs once, locally, read by a developer in their own
terminal, not by a log aggregator. Exactly as it appears for the real incident this replaces (one
pending migration):

```
Database schema is behind this checkout.

Pending migration:
  - 0006_remove_screenplay_version_add_document_yjs_state

Run:

  pnpm --filter @finaler-draft/database db:migrate

then restart `pnpm dev`.
```

Never mentions `db:migrate` for `ahead`, `diverged`, `unreachable`, or `queryFailed` -- each of
those needs a different next step, and suggesting the wrong command is worse than a generic one.
The `unreachable` message includes the driver's own error detail (e.g.
`connect ECONNREFUSED 127.0.0.1:5432`), which carries a host and port but never a connection
string or credential; verified directly against a real closed port (see below).

## Auto-applying migrations: no

Considered and rejected. `db:migrate` already exists as an explicit, single-purpose command, run on
purpose by a developer locally or by `.railway/railway.ts`'s `preDeploy` step in production.
Auto-applying from this check would turn every `pnpm dev` into a place a schema change can happen
silently and unreviewed -- exactly the failure mode a migration workflow exists to prevent -- to
save one command's worth of typing. The check's entire value is in naming the exact command; it
does not need to also run it.

## What this does not cover

**Production is unchanged**, as required: `.railway/railway.ts`'s `preDeploy` step already runs
`db:migrate` against the real `DATABASE_URL` before either service starts, which is the correct
mechanism there (a migration failure blocks the deploy outright, rather than starting a service
against a stale schema). A parallel startup assertion in production would be redundant with that
gate, not additionally safe -- though a cheap read-only assertion at boot (distinct from a
`preDeploy` migration run) could still be worth adding later as defense in depth against a
misconfigured `DATABASE_URL` reaching the wrong database; flagged here, not built.

## Verified

**Manual smoke test**, a disposable database (created via the same admin-connection pattern this
package's own integration tests already use, dropped afterward -- the owner's real dev database was
never touched):

- Fresh, unmigrated database: reports `behind`, naming all seven migrations, exit 1.
- Fully migrated: silent, exit 0.
- Fully migrated with the last applied row deleted from `drizzle.__drizzle_migrations`: reports
  `behind`, naming only `0006_remove_screenplay_version_add_document_yjs_state`, exit 1.
- `DATABASE_URL` pointed at a closed port: `Cannot reach the database... connect ECONNREFUSED
127.0.0.1:1`, exit 1 -- confirmed no connection string appears anywhere in the output.
- `DATABASE_URL` unset entirely: a distinct "DATABASE_URL is not set" message, exit 1.

**Mutation test**: temporarily forced `checkMigrations` to `return { ok: true }` unconditionally.
`migrationCheck.test.ts` went from 11/11 to 5/11 (the connectivity, ahead, diverged, and
pending-migration cases all failed as expected); reverted and confirmed 11/11 again.

**Gates, every one run and checked by `$?`:**

1. `pnpm lint` -- exit 0.
2. `pnpm format:check` -- exit 0 (after `prettier --write` on the four files it initially flagged).
3. `pnpm typecheck` -- exit 0.
4. `pnpm test` -- exit 0 (`packages/database` now 30/30, up from 1; every other package unchanged).
5. `pnpm check:bundle-budget` -- exit 0.
6. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/api test:integration` -- exit 0, 39/39
   (persistence.integration.test.ts alone: 19/19, matching the pre-existing baseline).
7. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/collab test:integration` -- exit 0, 6/6.
8. `TEST_DATABASE_URL=<...> pnpm test:system:persistence` -- exit 0, 18/18.
9. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/database test` -- exit 0, 32/32 (the new
   `migrationCheck.integration.test.ts`, self-skipped in gate 4 above without
   `TEST_DATABASE_URL`, exercised here against a real, freshly created and dropped throwaway
   database -- both the up-to-date and the pending-migration case).

No port left listening on 3001/4400/5173/4174/4175 after the run; none was in use before it
started either.

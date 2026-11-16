# Account purge: the grace-period cron (slice C)

Account deletion (slice B, `progress/account-deletion-backend.md`) marks an account deleted
**immediately** and leaves the physical rows -- `"user"`, its owned projects, every screenplay and
history row under them -- in place for a 30-day grace window. Nothing purged any of it until this
slice. This is that purge: a script in the repository, invoked on a schedule by a Railway cron
service, following the architecture the owner confirmed twice and explicitly rejected two
alternatives for.

**Why a script, not `pg_cron` or `node-cron`, restated because it constrains every decision
below.** `pg_cron` is not in Railway's Postgres image, and the deciding reason is that SQL alone
cannot reach Stripe or send mail, which would put irreversible deletion logic outside `pnpm test`,
typecheck, PR review, and audit. `node-cron` buys cron syntax and nothing else for a once-a-day
sweep, adds a dependency while the licence review is an open launch item (`progress/
find-and-replace.md` records the identical reasoning for a different dependency), and keeps a
scheduler inside the web process. This slice's purge logic needs neither Stripe nor mail at all --
both already happened in slice B -- but the architecture decision was made for the category of
problem, not this specific instance of it, and a script under version control is also simply the
right shape for code that destroys a writer's work irreversibly on a timer.

## The script's entry point, and how it guarantees exit

Two new files in `apps/api/src/`:

- **`accountPurge.ts`** -- the orchestration: every query, every bound, every "must not purge"
  rule. `createPostgresAccountPurgeStore(pool).run({ dryRun, now? })`.
- **`accountPurgeCli.ts`** -- the process wiring: reads `DATABASE_URL`, opens a `pg.Pool`, calls
  `run`, and closes the pool. Nothing else.

Railway's own cron documentation states the hard constraint this file exists to satisfy: a cron
service "executes the start command for that service on the given schedule," and the process "must
exit and leave no open resources" -- "If the code that runs in your Cron service does not exit,
subsequent executions of the Cron will be skipped." A silently skipped purge is exactly the class
of failure this project has already paid for once (`progress/deploy-visibility.md`'s thirteen
silent days), so this is not treated as an incidental detail.

`runAccountPurgeCli` (the testable core `main` wraps) closes the pool in a `finally`, not at the
end of the happy path, so it still runs when `store.run` throws. Proven three ways, not trusted:

1. `accountPurgeCli.test.ts` asserts `pool.end()` is called exactly once on the success path, the
   thrown-error path, and the real-default-`Pool`-construction path (against port 1 on loopback,
   which refuses the connection immediately and needs no database).
2. `accountPurgeCli.integration.test.ts` spawns the **real, unmodified** `accountPurgeCli.ts`
   through `tsx` as a genuine child process -- not a function call inside the test process, which
   proves nothing about the process boundary -- against the real test database, and asserts the
   child process exits with code 0 (or 1, for the missing-`DATABASE_URL` case) on its own. This is
   the one test that actually proves the Railway constraint; the unit test proves a necessary but
   not sufficient condition for it.
3. Every one of those subprocess tests completes in well under a second, which is itself evidence
   against a dangling handle keeping the event loop alive -- a leak would show up as the process
   hanging past `execFile`'s 20-second timeout, not as a slow but eventually-successful exit.

`DATABASE_URL` is checked directly rather than through `@finaler-draft/server-config`'s
`requirePersistenceEnvironment`: that schema is the full `apps/api` server's persistence contract
and, in production, additionally demands `STRIPE_SECRET_KEY`, `COLLAB_TOKEN_SECRET`,
`FEEDBACK_MAIL_TO`, and more -- none of which this script ever touches (Stripe cancellation already
happened in slice B; this script only removes database rows). Reusing it would make this cron fail
to start in production over a missing variable it has no use for -- a false dependency, not a
safety net.

## The cron declaration

`.railway/railway.ts`'s new `account-purge` service:

```ts
const accountPurge = service('account-purge', {
  source: finalerDraft,
  build: 'pnpm build:packages',
  preDeploy: 'pnpm --filter @finaler-draft/database db:migrate',
  start: 'pnpm --filter @finaler-draft/api purge:accounts',
  replicas: { 'us-west2': 1 },
  deploy: { cronSchedule: '0 3 * * *', restartPolicyMaxRetries: 3 },
  env: { DATABASE_URL: preserve(), NODE_ENV: preserve() },
});
```

**The field is `deploy.cronSchedule`, confirmed from the installed `railway` package's own types**
(`DeployConfig.cronSchedule?: string | null`, `node_modules/railway/dist/index-C3uk0ruc.d.ts`)
rather than guessed -- nothing else in this file's `deploy` blocks had needed it before. `'0 3 * *
*'`: once daily is far more resolution than a 30-day window needs, and 03:00 UTC sits outside this
product's only known usage pattern so far; there is no stronger reason behind the specific hour
than "outside the only pattern observed," named here plainly rather than dressed up as a load
study that was never done.

`build: 'pnpm build:packages'`, not the full `pnpm build`: this service needs only
`@finaler-draft/database` and `@finaler-draft/api` compiled, not `apps/web`'s production bundle or
`apps/landing`'s static build. `preDeploy` runs the identical, idempotent migration step `app`
already runs on every deploy -- this service's own index additions (below) must exist before its
first scheduled run reads them, and this service's deploy is not ordered against `app`'s anywhere
in this file, so it carries its own migration step rather than depending on `app` having deployed
first. No `healthcheck`: every other service here answers an HTTP probe continuously; this one runs
once per trigger and exits, and there is nothing for a healthcheck to probe between runs. No
`PORT`: this service never listens on one.

`restartPolicyMaxRetries: 3` is declared for the identical reason every other service's own comment
gives (Railway's documented default is already `ON_FAILURE` with 10 retries, and declaring a value
matching that default produces permanent phantom drift in `railway config plan`) -- 3 genuinely
differs from the default. Whether Railway's restart policy even applies the same way to a cron
trigger's single run as it does to a persistent service's crash loop is something this slice could
not confirm against a live project (see "What could not be verified," below); the number is kept
for consistency with the rest of this file rather than independently justified for cron semantics.

**`railway config plan`/`apply` were not run against a live project.** This worktree has no Railway
project link or credentials, and `.railway/README.md` is explicit that `apply` is a manual, reviewed
step nothing in CI runs -- so this declaration is typechecked (`npx tsc --noEmit` against
`.railway/railway.ts` directly, exit 0) and linted, but never plan-previewed against the real
infrastructure. That is stated here rather than implied by its absence.

## The grace window

`ACCOUNT_PURGE_GRACE_PERIOD_DAYS = 30`, the one named, exported constant every reader -- code,
tests, this doc -- cites. `accountPurge.test.ts`'s "names the grace window and retention windows
as the documented values" pins it so a change to the number is a deliberate edit of that test, not
silent drift between this doc and the code.

## The project-before-user ordering, and the test that proves it

**The trap:** `projects` has no owner column of its own (`packages/database/src/schema.ts`) --
ownership is recorded only by a `project_members` row with `role = 'owner'`, and
`project_members.user_id` cascades the instant the `"user"` row it names is deleted. The moment
`"user"` is gone, the one link identifying which projects belonged to that account is gone with
it -- not flagged, not orphaned in any way anything will ever find again, just permanently
unreachable rows on the volume.

`purgeOneAccount` reads that link (`fetchOwnedProjects`, a join on `project_members`) and deletes
the account's owned, soft-deleted projects **before** deleting the `"user"` row, in the same
transaction.

Proven two ways, not just argued:

- **`accountPurge.integration.test.ts`'s "the ordering trap" describe block** reproduces the
  failure directly, by hand, with raw SQL -- deleting `"user"` first and showing the project row
  sits there afterward, soft-deleted, forever unreachable by ownership (`ownedAfter.rowCount` is
  `0`, but `projectExists(projectId)` is still `true`) -- before showing the real function avoids
  it (`"the real purge avoids the trap"`).
- **Mutated the real function** to match the trap: moved the `delete from "user"` statement to
  execute before `fetchOwnedProjects` runs. Two tests failed for exactly the right reason -- see
  "Every mutation," below.

## Every category purged, and its bound

| Category                           | Predicate                                                                                   | Bound                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Accounts past the grace window     | `"user".deleted_at is not null and deleted_at <= now() - 30 days`                           | `ACCOUNT_PURGE_BATCH_SIZE` (200) accounts per run, each in its own transaction                    |
| Their owned, soft-deleted projects | `project_members.role = 'owner'` for that account **and** `projects.deleted_at is not null` | Whatever a purged account owns (no separate cap; bounded transitively by the account bound above) |
| Expired sessions                   | `session.expires_at < now()`                                                                | `HYGIENE_PURGE_BATCH_SIZE` (5,000) rows per run                                                   |
| Expired verification rows          | `verification.expires_at < now()`                                                           | 5,000 rows per run                                                                                |
| Stale Stripe dedupe events         | `stripe_processed_events.processed_at < now() - 90 days`                                    | 5,000 rows per run                                                                                |
| Resolved membership invitations    | `status in ('accepted', 'declined') and updated_at < now() - 90 days`                       | 5,000 rows per run                                                                                |

Hard-deleting a purged account's owned, soft-deleted project cascades (`schema.ts`'s own `onDelete:
'cascade'` chain) to its `screenplays`, and from there to every `document_yjs_updates`,
`document_yjs_checkpoints`, `document_yjs_quarantined_updates`, and `document_revisions` row those
screenplays ever had -- **retired-epoch rows included**. That is deliberate: a screenplay whose
owning account has been erased is not "live" by any definition this product uses, and an erasure
request is precisely a request that its history stop existing too. `accountPurge.integration
.test.ts`'s "cascades a solo-owned, soft-deleted project away entirely -- screenplay, revisions,
and every Yjs row" seeds two epochs' worth of `document_yjs_updates` rows and asserts the count
reaches zero.

Deleting `"user"` itself then cascades to `session` (redundant with the hygiene sweep above, but
immediate and harmless), `account`, `subscriptions`, `feedback`, `editable_slots`, and the
remaining `project_members`/`screenplay_members` rows on projects it did not own, and nulls the
`set null` foreign keys (`document_yjs_updates.authenticated_actor_id`,
`document_revisions.authored_by`, `membership_invitations.invited_by_user_id`) -- exactly what
`progress/account-deletion-backend.md`'s own "What slice C will need" section predicted: "run the
delete and let the existing foreign keys do the rest."

The retention windows for Stripe events and membership invitations
(`STRIPE_PROCESSED_EVENT_RETENTION_DAYS`, `MEMBERSHIP_INVITATION_RETENTION_DAYS`, both 90) are
independent of the account grace window -- ordinary housekeeping on dedupe/audit tables, not tied
to any account's deletion. 90 days is comfortably past any plausible Stripe redelivery or
billing-dispute window, and past any plausible "who did I invite and how did they answer" lookback,
kept generous rather than tight because nothing reads these tables for their original purpose after
a much shorter window anyway.

Three new indexes were added (migration `0013_violet_steve_rogers.sql`) so these four sweeps are
not full-table scans: `session_expires_at_index`, `verification_expires_at_index`,
`stripe_processed_events_processed_at_index`, plus a partial index,
`membership_invitations_resolved_updated_at_index`, scoped to `status in ('accepted', 'declined')`
so it stays small and never covers the live `pending` rows this module must never touch. Generated
with `drizzle-kit generate` against the provided test database, confirmed idempotent by hashing the
whole `drizzle/` tree, re-running `db:generate`, and diffing -- identical both times, which is the
actual CI check (`git diff --exit-code`), not merely "no error was thrown."

## Every category deliberately not purged

- **A live account's own soft-deleted projects and screenplays.** `plan.md:767`: "There is no
  retention window and nothing is purged... Introducing automatic purging later is a separate
  product decision." Every query in `accountPurge.ts` is scoped through a soft-deleted _account_
  first -- it never reads `projects.deleted_at`/`screenplays.deleted_at` for a project whose owner
  is not itself being purged. Proven, not merely argued from the code's shape:
  `accountPurge.integration.test.ts`'s "never touches a live account's own soft-deleted project or
  screenplay" soft-deletes a project owned by a never-deleted account, runs a real purge, and
  asserts both rows (and the owner's own `"user"` row) are untouched.
- **A live screenplay's retired-epoch Yjs history.** The audit's DB-6 named these as load-bearing
  (`progress/restore-as-current.md`: the cutover "leaves the retired epoch's updates and
  checkpoints untouched precisely so historical replay works"). No query in this module ever
  targets `document_yjs_updates`/`document_yjs_checkpoints` directly, by age or by epoch, for any
  reason -- the only path that reaches them at all is the project cascade above, which only ever
  starts from a purged (dead) account's own project. `accountPurge.integration.test.ts`'s "never
  touches a retired epoch's Yjs updates for a live screenplay" seeds two epochs' worth of rows on a
  live screenplay and asserts the count is unchanged after a real run.
- **Current-epoch checkpoint growth** (audit COL-2, roughly 0.6 MB per checkpoint against a 5 GB
  volume) is real, but a daily sweep is the wrong mechanism for it -- plan.md's reconstruction path
  wants the latest checkpoint kept, not aged out by a timer that knows nothing about reconstruction.
  The fix belongs inside `createCheckpoint` (`updateLog.ts`) itself, not here. Named explicitly so
  its absence from this file reads as a decision, not an oversight.
- **The narrow collaborator-race anomaly `accountDeletion.ts` already documents** -- an owned
  project that somehow was never soft-deleted (a collaborator accepted in the gap between that
  transaction's membership read and its commit). Never hard-deleted: it may still have a live
  collaborator who never asked for it to be removed, and this slice's "what NOT to purge" rules are
  explicit that a live collaborator's access is never a casualty of someone else's account
  deletion. `purgeOneAccount` finds these (`ownedProjects.filter((row) => row.deletedAt === null)`),
  logs a count and their ids (`account_purge_owned_project_not_soft_deleted`) so an operator can go
  look -- expected to be zero in practice -- and leaves them untouched; the owning account is still
  purged, which leaves the project ownerless rather than owned by a zombie, a strictly smaller
  problem than the one `accountDeletion.ts` already accepted, and not one this slice repairs.
  `accountPurge.integration.test.ts`'s "never hard-deletes an owned project that was never
  soft-deleted..." constructs exactly this state and asserts the project survives, the collaborator
  keeps their `'editor'` row, and the warning is logged.
- **An account still inside its grace window.** Tested on both sides of the boundary, against a
  real `<=` comparison in SQL -- see "Every mutation," below, for why the first version of this
  test would have passed even with the boundary wrong.
- **Pending membership invitations, regardless of age.** `status in ('accepted', 'declined')` never
  matches `'pending'` -- a pending invitation is live state a prospective member has not yet
  answered, not history. `accountPurge.integration.test.ts`'s hygiene test seeds a year-old pending
  invitation alongside a stale accepted one and asserts only the latter is purged.

## Dry run

`run({ dryRun: true })` issues only `select count(*)` queries mirroring the exact predicates the
real deletes use, opens no transaction, and takes no lock of any kind -- an operator can run it
against production at any time with no write-lock contention. Unlike the real run, dry run reports
the **full** backlog for the account category, not clipped to `ACCOUNT_PURGE_BATCH_SIZE`: the point
of a dry run is to see the whole picture, including how large a backlog has accumulated, not just
what the next scheduled run would touch. `accountPurgeCli.ts` exposes it as `--dry-run`
(`pnpm --filter @finaler-draft/api purge:accounts:dry-run`).

`accountPurge.integration.test.ts`'s "dry run" describe block seeds a full purge-worthy scenario
(an expired account, its soft-deleted project, an expired session) and asserts the reported counts
are accurate **and** that every row is still present afterward -- the "does X survive" half of the
proof that a dry run finding nothing is not simply because the script does nothing.

## Idempotency

Running this twice in a row is safe and the second run is a no-op, for a simple reason: every query
is a plain predicate-based `select`/`delete`, not keyed on a request id that could double-apply.
Nothing un-deletes an account or un-expires a session, so a row the first run already removed
simply does not match the second run's predicate -- there is no separate idempotency mechanism to
get wrong. `accountPurge.integration.test.ts`'s "running twice in a row purges nothing the second
time" seeds one of every category, runs the sweep, runs it again, and asserts the second result is
every count at zero.

## How work is bounded, and why re-entering it next run is safe

`ACCOUNT_PURGE_BATCH_SIZE` (200) caps how many expired accounts a single run processes, each in its
own short transaction (`purgeOneAccount`). `HYGIENE_PURGE_BATCH_SIZE` (5,000) caps each hygiene
category's single `delete` statement the same way. Re-entry is safe because the predicate that
selects work (`deleted_at <= cutoff`, `expires_at < now()`, and so on) only ever **shrinks** the
remaining backlog as rows are purged -- a capped run today simply leaves the oldest remainder for
tomorrow's run, in the same order (`order by deleted_at, id`), and nothing grows that backlog faster
than real account deletions and real session/verification expirations occur in the ordinary course
of the product being used.

Proven directly: `accountPurge.integration.test.ts`'s "bounded work per run" seeds
`ACCOUNT_PURGE_BATCH_SIZE + 5` already-expired accounts (via a single bulk `insert ... select *
from unnest(...)`, not 205 round trips), runs the purge once, asserts exactly
`ACCOUNT_PURGE_BATCH_SIZE` were purged and `5` remain, runs it again, and asserts the remaining `5`
are purged on the second pass.

## Lock order

`purgeOneAccount` takes exactly one explicit row lock: `"user"`, with `for update skip locked` --
not a plain `for update`, and not an advisory lock -- as its first statement after `begin`. `skip
locked` is what keeps two purge runs that happen to overlap (an operator running a dry run or a
manual pass while the schedule also fires; Railway's own cron contract otherwise prevents true
overlap by skipping a trigger while the previous run has not exited) from ever forming a lock-wait
cycle with each other: the second simply finds zero rows and moves on, rather than blocking on the
first.

No second account-level lock is ever contended between two purge runs for _different_ accounts
either, because `project_single_owner_unique` guarantees a project has exactly one owner -- two
different accounts' owned-project sets can never overlap, so there is no row either run's `delete
from projects` could be racing the other for.

Beyond that one lock, `projects` and then `"user"` are only ever _written_ (`delete`), never
separately locked with `for update` first -- the `delete` statement itself takes whatever lock it
needs, in the order those two statements run, which is "projects before user," agreeing with every
other writer in this codebase (`projects.ts`'s `deleteProject`/`renameProject`, `sharing.ts`'s
`lockScope`/`fetchProjectRole`/`transferOwnership`, and `accountDeletion.ts`'s own sweep) that
already locks `projects` before `project_members`.

**No advisory lock is taken**, and the reasoning was checked against the paths it could
contradict, not just asserted: nothing else in this codebase can be concurrently holding the
`"user"` lock and waiting on a `projects` row this transaction wants, because the deleted account
cannot itself be the actor behind any live request (sign-in is refused and `isAccountDeleted`'s
choke-point recheck covers the narrow race around that refusal -- both from slice B). So there is
no existing cross-table order this transaction's two writes could contradict, and nothing to tag a
marker comment onto the way `restore.ts`/`revisions.ts`/`sharing.ts`'s advisory-lock call sites do
for each other -- this module takes none.

Proven directly, not only argued: `accountPurge.integration.test.ts`'s "concurrency: skip locked,
never block" holds a manual `for update` lock on a candidate account's `"user"` row from a second
client, runs the purge, and asserts it returns promptly reporting zero accounts purged (a plain
`for update` here would have made the test hang -- see "Every mutation," below, for the actual
timeout that produced).

## Every mutation, and the test it killed

Each mutation below was applied with a single, uniqueness-checked string edit (`grep -c` showing
exactly one match before editing), run against the real file, confirmed to fail the expected test
with the expected message, then reverted and the suite re-run green.

| #   | Mutation                                                                                                                                             | Expected failure                                                                                                                   | Actual result                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `findExpiredAccountIds`'s bounded SQL: `deleted_at <= $1` changed to `deleted_at < $1`                                                               | "purges an account exactly at the boundary..." (integration)                                                                       | **First attempt passed anyway** -- see below. After pinning a fixed `now` through both the test's `deletedAt` and `run`'s own cutoff (removing clock skew between two separate `Date.now()` calls), failed as expected: `expected +0 to be 1`.                  |
| 2   | `purgeOneAccount`: moved `delete from "user" where id = $1` to run _before_ `fetchOwnedProjects`                                                     | "the real purge avoids the trap..." and "cascades a solo-owned, soft-deleted project away entirely..." (both integration)          | Both failed: the project survived (`expected true to be false`) and the cascade count stayed at `+0` instead of reaching the asserted `1` -- `fetchOwnedProjects` found nothing because `project_members` had already cascaded away.                            |
| 3   | `purgeOneAccount`: the `toPurge` filter (`.filter((row) => row.deletedAt !== null)`) removed, purging every owned project regardless of `deleted_at` | "never hard-deletes an owned project that was never soft-deleted..." (integration)                                                 | Failed: `expected 1 to be +0` -- the un-soft-deleted, collaborator-shared project was hard-deleted.                                                                                                                                                             |
| 4   | `countOrPurgeStaleMembershipInvitations`'s real-delete predicate: the `status in ('accepted', 'declined') and` clause removed                        | "purges a resolved membership invitation past retention but keeps a recent one and a pending one, regardless of age" (integration) | Failed: `expected false to be true` -- the year-old pending invitation was deleted.                                                                                                                                                                             |
| 5   | `purgeOneAccount`'s row lock: `for update skip locked` changed to a plain `for update`                                                               | "skips an account another transaction currently holds, rather than waiting on it" (integration)                                    | Failed with a **test timeout** (8s, then the suite's `afterAll` hook timed out too, trying to close a pool with a client still blocked) -- the mutated query blocked on the held lock instead of skipping it, exactly the regression this test exists to catch. |

**Mutation 1 is the most important entry in this table, not because it killed a test, but because
it didn't, the first time.** The original version of "purges an account exactly at the boundary"
computed `deletedAt` from the test's own `Date.now()` call and let `run()` compute its cutoff from
a separate `new Date()` a few milliseconds later -- so `deletedAt` ended up strictly _before_
whatever cutoff `run` computed regardless of whether the SQL comparison was `<=` or `<`. The
mutation above was applied against that version first, and the full boundary suite still passed.
That is precisely the brief's own warning -- "if a test passes before you write the thing it tests,
treat that as a bug in the test" -- caught by deliberately trying to break the thing the test
claimed to protect. The fix was to pin a single `now` and pass it through to both
`softDeleteUser`'s timestamp and `run({ now })`, removing the skew; only then did the mutation fail
the test. This is recorded here in full, not cleaned up into "the boundary is tested," because the
failure mode is the more useful fact for the next reader than the eventual pass.

## For every "must not purge" rule, the allowed case in the same file

- `accountPurge.integration.test.ts`'s "never touches a live account's own soft-deleted project or
  screenplay" is paired, in the same describe block's sibling tests, with "cascades a solo-owned,
  soft-deleted project away entirely" (a _dead_ account's project, same shape, opposite outcome).
- "never touches a retired epoch's Yjs updates for a live screenplay" is paired with the same
  cascade test, which seeds the identical two-epoch shape on a screenplay whose account **is**
  purged and asserts the count reaches zero -- so "retired epochs survive" is not passing because
  nothing in this suite ever purges Yjs rows at all.
- "never hard-deletes an owned project that was never soft-deleted..." is paired with "cascades a
  solo-owned, soft-deleted project away entirely" -- the same account-purge path does delete an
  owned project when it _is_ soft-deleted, so "survives" above is not vacuous.
- The membership-invitation "keeps... a pending one, regardless of age" assertion sits in the same
  test as "purges a resolved membership invitation past retention," which does purge the sibling
  accepted row in the identical `run()` call.

## Gate results

Postgres: the provided isolated container, `purge-pg`, on port **55475** -- used as given, never
started a second one.

| Gate                                                    | Result                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                             | exit 0                                                                                                                                                                                                                                                                                                     |
| `pnpm typecheck`                                        | exit 0 -- every package, `apps/web`, `apps/api`, `apps/collab`, `apps/landing` (astro check: 0 errors)                                                                                                                                                                                                     |
| `pnpm test` (no `TEST_DATABASE_URL`, CI-style)          | exit 0 -- `apps/api` 397 passed / 148 skipped (34 files, including `accountPurge.test.ts` 6/6 and `accountPurgeCli.test.ts` 7/7), `apps/web` 1263 passed, `apps/collab` 181 passed / 32 skipped, every other package green                                                                                 |
| `pnpm test:integration` (`TEST_DATABASE_URL` set)       | exit 0 -- `packages/database` 12/12, `apps/api` 148/148 across 11 files (including `accountPurge.integration.test.ts` 18/18 and `accountPurgeCli.integration.test.ts` 3/3), `apps/collab` 32/32                                                                                                            |
| `pnpm test:coverage` (no `TEST_DATABASE_URL`, CI-style) | exit 0. `apps/api/src/accountPurge.ts`: 90.95% statements / 83.87% branch / 100% functions / 90.95% lines. `apps/api/src/accountPurgeCli.ts`: 81.81% / 69.23% / 100% / 81.81%. Both added to `vitest.config.ts`'s coverage `include` list. Aggregate across the package: 96.46% / 92.25% / 95.6% / 96.46%. |
| `pnpm build`                                            | exit 0 -- every package, including `apps/web`'s production bundle and `apps/landing`'s static build                                                                                                                                                                                                        |
| `pnpm format:check`                                     | run bare, last; see below                                                                                                                                                                                                                                                                                  |

### Coverage, read honestly rather than only by the aggregate

`accountPurgeCli.ts`'s branch coverage (69.23%) is below the 80% bar this project generally holds
new code to, even though its statement/line/function coverage and the package aggregate all clear
it (the configured `thresholds` in `vitest.config.ts` are aggregate, not per-file, and the run
exits 0). The uncovered branch is the `if (import.meta.url === pathToFileURL(process.argv[1] ??
'').href)` process-entry guard -- deliberately written so it never fires when this file is merely
_imported_ under Vitest, which is exactly what makes it structurally untestable from inside the
same process that would be running the coverage instrumentation. It is proven correct a different
way: `accountPurgeCli.integration.test.ts` spawns this exact file as a real process, where the
guard genuinely does fire, and asserts the resulting exit code -- that run is skipped from the
coverage report because `test:coverage` runs without `TEST_DATABASE_URL`, matching CI's own
convention (`test:integration` runs _with_ the variable, `test`/`test:coverage` run _without_ it).
`accountPurge.ts`'s own small shortfall (lines 301-311: the `delete from projects` branch and the
`catch`/`rollback` path) is the identical shape -- proven by the real-database integration suite,
invisible to this particular coverage run. Stated here rather than left for the aggregate number to
paper over.

### `pnpm format:check`, bare and last

Run bare twice during this slice -- Prettier caught real violations the first time (the three new
test files, plus the regenerated Drizzle metadata JSON, not yet formatted), fixed with `prettier
--write` on exactly the flagged files, the affected test files re-run to confirm the reformat
changed no behaviour (34/34 still passed), and the full gate sequence re-run afterward. The actual
last command run before this report was finished:

```
$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!
```

Exit code: **0**.

## What could not be verified

- **`railway config plan`/`apply` against the live project.** This worktree has no Railway project
  link or credentials. The declaration is typechecked directly against the installed `railway`
  package's own types (`npx tsc --noEmit` on `.railway/railway.ts`, exit 0) and linted, but a plan
  preview -- the one thing `.railway/README.md` says is the actual warning before a destructive
  apply -- was never run. Whoever runs `railway config plan` next should read it before `apply`,
  per that file's own instructions; this slice does not shortcut that.
- **Whether Railway's restart-policy semantics for a cron trigger match the always-running-service
  semantics the comment on `restartPolicyMaxRetries` describes.** The number is carried over by
  convention from `app`/`collab`/`landing`'s identical declarations; what "retry" means for a
  single scheduled execution rather than a crash-looping persistent process was not independently
  confirmed against Railway's own cron documentation beyond the one constraint quoted throughout
  this doc (the process must exit).
- **No real-production-scale rehearsal.** `ACCOUNT_PURGE_BATCH_SIZE`/`HYGIENE_PURGE_BATCH_SIZE`
  were exercised at `ACCOUNT_PURGE_BATCH_SIZE + 5` accounts (205) and the hygiene bound was never
  driven anywhere near 5,000 rows in a single run -- there was no production-sized backlog to
  rehearse against. The bounding mechanism itself (a `limit`, re-entrant because the predicate only
  shrinks) is proven at a small scale; its behaviour under an actual multi-year accumulated backlog
  is argued, not measured.
- **The anomaly case (an owned project that escaped soft-deletion) was reproduced directly, not
  through the real race that produces it.** `accountDeletion.test.ts`'s own equivalent note applies
  identically here: constructing the real interleaving (a concurrent `respondToInvitation` racing
  the exact gap in slice B's transaction) was not attempted; this slice's test constructs the
  resulting _state_ and proves this module's reaction to it, which is the property this slice
  actually owns.
- **No visibility or alerting on the `account_purge_owned_project_not_soft_deleted` warning
  beyond the structured log line itself.** If that anomaly ever does fire in production, nothing
  pages anyone -- it is only visible to whoever reads the cron's logs. The identical gap
  `progress/deploy-visibility.md` closed for deploy failures (a failed run notifies the pusher
  through GitHub's own mechanism) has no equivalent here, because this is a log line from a
  scheduled job, not a CI run with a pusher to notify. Worth a real alerting path if this anomaly
  turns out not to be as rare as assumed.

## Lead verification, run independently

| Gate                                           | Result                                                |
| ---------------------------------------------- | ----------------------------------------------------- |
| `pnpm lint`                                    | exit 0                                                |
| `pnpm typecheck`                               | exit 0                                                |
| `pnpm test` (CI-style, no `TEST_DATABASE_URL`) | exit 0                                                |
| `pnpm test:integration`                        | exit 0 -- 3, 11 and 3 files across the three packages |
| `pnpm build`                                   | exit 0                                                |
| `pnpm format:check`                            | exit 0, bare and last                                 |

### End-to-end, driven by hand against a real database

Not through the test harness -- a fresh migrated database, one account seeded with
`deleted_at = now() - interval '60 days'`, and the actual `pnpm` scripts an operator or the cron
would run:

| Step                     | Observed                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `purge:accounts:dry-run` | `{"event":"account_purge_dry_run","accountsPurged":1,...}` and the user row **still present** |
| `purge:accounts`         | `{"event":"account_purge_completed","accountsPurged":1,...}` and the user row **gone**        |
| `purge:accounts` again   | `accountsPurged: 0`, exit code 0 -- a genuine no-op                                           |

So the dry run reports accurately without writing, the real run deletes, the second run is
idempotent, and the process exits cleanly in all three cases. The structured log carries counts and
no PII, as required.

### Mutations re-run by the lead

| Mutation                                                                      | Result                                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Hard-delete owned projects that were never soft-deleted (the documented race) | failed "never hard-deletes an owned project that was never soft-deleted..." |
| Grace window `30` -> `29`                                                     | failed the exported-constants test                                          |
| Boundary `<=` -> `<`, **both** query variants                                 | failed "purges an account exactly at the boundary" -- `expected +0 to be 1` |

Two notes on method, because the first attempt at each of the last two was misleading:

- Mutating **only** the unbounded query variant passed everything. There are two nearly identical
  statements -- one with `limit`, one without -- and the integration tests exercise the `limit` one.
  A mutation that misses the path under test proves nothing, and an exact match count of 1 is not
  sufficient protection when the same predicate appears twice.
- Changing `ACCOUNT_PURGE_GRACE_PERIOD_DAYS` does **not** fail the boundary tests, because their
  fixtures are derived from that constant and move with it. That is a reasonable division of labour
  -- the constants test pins the value, the boundary tests pin the mechanism -- but it is worth
  stating, because "I changed the window and the boundary tests still passed" looks alarming until
  you know why.

### The verification the implementing agent could not do

It reported being unable to confirm the cron declaration against a live Railway project. Closed from
both directions:

- The installed Railway IaC package's own types declare `cronSchedule?: string | null`, and the
  declaration uses `cronSchedule: '0 3 * * *'`.
- Railway's **API** reports a `cronSchedule` field per service -- it comes back `null` for each of
  the five existing services in the production environment. So the field exists on the platform side
  too, not only in the client types.

What remains genuinely unverified is the same thing the agent said: no `railway config plan` or
`apply` has been run, so this is a correct _declaration_, not an observed deployment. `config apply`
is a manual reviewed step by design (`.railway/README.md`) and nothing in CI runs it, so the cron
does not exist in production until someone applies it. That is the one action needed to finish this
slice, and it is the owner's to take.

## Two corrections after the first real production run

The cron was applied to Railway and **fired before this branch merged**, which surfaced two problems
in the service declaration. Neither was in the purge logic.

### The `preDeploy` migration is removed

The declaration carried `preDeploy: 'pnpm --filter @finaler-draft/database db:migrate'`, copied from
`app`. The first scheduled run failed on it outright:

```
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @finaler-draft/database db:migrate
DATABASE_URL is required for Drizzle commands.
```

The immediate cause was a missing variable (below), but removing the step is right regardless, and
the original justification for having it does not survive checking. That justification was: this
slice's migration adds indexes the purge reads, this service's deploy is not ordered against
`app`'s, so it should run the idempotent migration itself.

- The migration (`0013_violet_steve_rogers.sql`) adds **only indexes** -- four of them. A missing
  index makes a nightly batch job slower; it never makes it incorrect. So the purge does not need
  the migration to have run before its first execution.
- Giving a 03:00 cron the ability to migrate the production database races whatever schema `app`
  believes it is running against, on a schedule nobody is watching. `app` owns migrations for the
  ordering reason its own declaration states: it deploys before `collab` so the schema is migrated
  before the other reader of that database restarts against it. One owner, one ordering.

If this job ever runs against a schema older than it expects, a loud failure is the correct outcome,
not a 3am schema change.

### `preserve()` on a brand-new service preserves nothing

The declaration had `env: { DATABASE_URL: preserve(), NODE_ENV: preserve() }`, and the live service
had **neither** -- only Railway's own injected `RAILWAY_*` values.

That is the mechanism worth remembering: `preserve()` means "keep whatever Railway already holds for
this key", which is exactly right for an existing service and a no-op for a new one. It is the
`FEEDBACK_MAIL_TO` lesson inverted -- there, _omitting_ a variable from this file deleted it; here,
`preserve()`-ing it on a service that had never existed never created it. A new service's variables
have to be set once, by hand, before `preserve()` has anything to hold on to. The owner has since
set both.

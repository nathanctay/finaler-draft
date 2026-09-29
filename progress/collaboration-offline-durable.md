# Collaboration slice 3: browser offline support and a durable, append-only update log

Branch `feature/collab-offline-durable`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/collab-offline`, off `8503d71`.

## Why this scope exists

`progress/collaboration-slice-1.md`'s own `document_yjs_state` table comment is explicit that it
is snapshot durability, "not yet the append-only `document_yjs_updates`/`document_yjs_checkpoints`
log plan.md's schema sketch describes." This slice builds that log, adds a browser-side offline
copy so an editor survives a real connection drop, and adds the quarantine mechanism plan.md's
"a lapsed subscription must not silently lose a writer's honest work, and must not silently grant
free editing either" tension requires.

## Schema decisions

**Naming: `screenplay_id`, not `document_id`.** plan.md's own sketch (written before this schema
existed) names the foreign key `document_id`. This codebase has no `documents` table -- a
screenplay _is_ the collaboration document -- and the table it replaces
(`document_yjs_state`) already used `screenplay_id`. Kept consistent with the codebase as it
actually is rather than half-adopting the sketch's name for its own sake.

**`epoch`: introduced now, at a fixed `0`, not deferred.** Nothing varies it yet -- there is no
epoch cutover in this codebase. Introduced anyway because slice 5 (restore-as-current) is
specifically an epoch cutover (plan.md: "increments the document epoch... rejects writes to the
old epoch"), and `document_yjs_updates` will by then be the largest table in the schema. Adding the
column later means an `ALTER TABLE` under load on that table; adding it now, at a default, is a
single cheap migration. `database.ts`/`updateLog.ts` reference it through one named constant
(`DEFAULT_EPOCH`), not a scattered literal, so slice 5 has exactly one place to start threading a
real epoch through.

**`document_yjs_state` does not survive alongside the new tables.** It is replaced entirely:
`document_yjs_checkpoints` is the new fast path (`updateLog.ts`'s `latestCheckpoint` +
`updatesAfter`, not a full replay of history on every load), and keeping the old table too would
mean three overlapping stores of the same content with a real risk of the third drifting from what
the log+checkpoint pair would reconstruct after a crash mid-write. The migration
(`packages/database/drizzle/0007_empty_king_cobra.sql`) converts every existing
`document_yjs_state` row into exactly one bootstrap checkpoint (`epoch 0`, `through_sequence 0`,
`state_vector NULL` -- recomputing a real state vector from raw bytes needs `yjs`, not SQL, and
nothing in the reconstruction path reads it) before dropping the old table, so no existing
screenplay's collaborative history is lost. Verified directly against a throwaway database: created
the old table shape by hand, inserted a row, ran the migration's own `INSERT ... SELECT`, and
confirmed the resulting checkpoint round-trips the original bytes.

**Checkpoints are append-only, not upserted.** Each compaction inserts a new row rather than
updating one row per screenplay; `latestCheckpoint` picks the highest `id`. This costs one small
row per compaction and buys a diagnosable trail, and it is what let `updateLog.test.ts`'s
mutation-guard test construct a concrete "two checkpoints, the newer one incomplete" scenario to
prove the lock matters (see below) -- an upserted single row could not have shown that.

**`document_yjs_updates.sequence` is a single global identity column, not a per-document counter
reset to 1.** Every ordering and cutoff comparison this slice needs ("give me every update after
this checkpoint") only requires monotonic order, not a dense per-document sequence. A global
`GENERATED ALWAYS AS IDENTITY` column gets that from Postgres itself, safe under concurrent inserts
with no application-level locking or retry loop, which a per-document counter would need one of to
stay correct.

## Which Hocuspocus hook appends, and why

`onChange`, not `onStoreDocument`. Read directly from the installed `@hocuspocus/server` 4.6.0
source (`dist/hocuspocus-server.cjs`): `document.onUpdate` fires `handleDocumentUpdate`, which
calls `this.hooks("onChange", changePayload)` -- synchronously, once per individual Yjs update,
handing back that update's own raw bytes -- and only _then_, separately, calls
`storeDocumentHooks` (the debounced `onStoreDocument` the `Database` extension implements).
`onStoreDocument` only ever sees Hocuspocus's own merged, debounced result of however many updates
accumulated in the debounce window; it cannot be un-merged back into the individual writes an
append-only log exists to preserve. `onChange` is the one hook that hands back exactly what the log
needs.

A read-only connection's writes never reach `onChange` at all: Hocuspocus applies an update to the
document (firing `onUpdate`/`onChange`) only _after_ its own low-level `readOnly` check has already
passed a `syncStep2`/`update` message through, and that check drops a read-only connection's writes
before they are ever applied. `onChange`, by construction, only ever logs a write that was actually
allowed.

`document.onUpdate` is attached _after_ `onLoadDocument` runs (confirmed in the same source: the
seed/fetch result is applied via `Y.applyUpdate` inside `onLoadDocument`, and the update listener is
attached only once that resolves) -- so a freshly-seeded document's own seed is never itself logged
as an "update." `database.ts`'s `createFetch` accounts for this explicitly: both the first-ever
seed and the title-page/document-settings migration backfill call `writeCheckpoint` directly,
persisting that content as a checkpoint _before_ returning it to Hocuspocus, so the very first
genuine client edit afterward is a delta against a base that actually exists in the durable log's
lineage. Getting this wrong was a real bug caught before it shipped: without it, a delta captured
against a locally-merged-but-never-logged base fails to integrate on reconstruction (Yjs's YATA
algorithm references other operations by id; a delta whose referenced item was never persisted
anywhere cannot resolve against a fresh `Y.Doc`). Verified concretely while building
`updateLog.test.ts`: an early draft of the concurrent-append integration test used an
independently-constructed `live` doc merged with `base`, and its delta referenced an item that only
ever existed in the independent doc, never in `base` or its checkpoint -- reconstruction silently
lost the content. Fixed by deriving `live` from `base`'s own encoded bytes.

## How compaction preserves an update it has not yet absorbed

`createCheckpoint` (`updateLog.ts`) is driven entirely by what is durably in Postgres, never by a
live in-memory `Y.Doc`: it reads the current checkpoint and everything after it
(`updatesAfter`), rebuilds the merged state _from that data_, writes a new checkpoint whose
`through_sequence` is exactly the highest sequence it read, and deletes exactly those rows -- all
inside one transaction holding a `pg_advisory_xact_lock` keyed on `(hashtext(screenplayId), epoch)`.
`appendUpdate` takes the identical lock before its own insert. That single fact is what closes the
invariant: an update racing a compaction either commits fully before the lock is acquired (and is
therefore counted in the cutoff) or cannot even begin its own transaction until compaction's has
committed or rolled back (and is therefore never at risk, since its insert cannot happen until
after the delete that would have needed to include it is already over).

The actually dangerous interleaving is not "an update lands mid-compaction" (a single compaction's
own read-then-write is self-consistent regardless of what else is happening, since its
`through_sequence` is always derived from what it itself read) -- it is **two overlapping
compactions torn across two separate queries**: compaction B reads an old checkpoint before
compaction A writes a new one, and reads the tail after A has already deleted what A absorbed. B
then commits a _newer_ checkpoint (higher `id`, so `latestCheckpoint` prefers it) that is missing
whatever A absorbed and B never saw. This is provably impossible with the lock (B cannot even begin
its first read until A's whole transaction has committed or rolled back) and was reproduced,
deterministically, without it. See "Mutation testing" below.

## Offline catch-up and concurrent edits

Browser side: `App.tsx`'s `collab` useMemo constructs an `IndexeddbPersistence` (`y-indexeddb`
9.0.12) bound to `provider.document` -- the same `Y.Doc` `ySyncPlugin` renders and
`HocuspocusProvider` syncs, not a separate copy. `y-indexeddb`, not a hand-rolled `localStorage`
blob, because it already solves exactly this: it persists every local update as it happens and
replays whatever it finds back into the doc on construction, and Yjs's CRDT merge is commutative,
so it does not matter whether IndexedDB's replay or the server's own first sync lands first -- both
converge to the same content.

What happens to a genuinely concurrent edit made by someone else while a writer is offline: nothing
special. There is no conflict to resolve, because a CRDT has none -- both edits survive, on both
sides, once reconnected. Proven directly in
`apps/collab/src/collaboration.integration.test.ts`'s "an offline editor reconnects and catches the
server up with no loss, and a concurrent edit made while they were away survives alongside theirs."

**A real, honestly-scoped limitation found while building this, not silently worked around**: a
_cold_ page reload while genuinely offline does not currently recover a screenplay at all.
`$projectId.screenplays.$screenplayId.tsx`'s route loader fetches the screenplay via a plain
`useQuery` with no offline fallback; a reload with no network reachable fails that fetch and never
mounts the Yjs-backed editor, so there is no route by which a cold load can fall back to the
IndexedDB copy alone. What this slice proves is narrower and still real: an _already-open_ session
keeps accepting input through a live connection drop, persists it to IndexedDB as it happens, and a
reload performed _after_ reconnecting (standing in for a writer refreshing a stuck tab) recovers
instantly from IndexedDB and converges with the server. Making a genuinely cold, fully-offline
reload work is a separate, real enhancement (persisting the initial fetch, or falling back to
IndexedDB when it fails) that this slice does not implement.

## Quarantine: detection and retention, without merging

**The generalization made, and why.** The brief frames this around a lapsed subscription
specifically. The mechanism that actually decides "may this connection write" is
`authenticate.ts`'s `resolveConnectionAuthorization`, which already produces `readOnly: true` for
two structurally different reasons: a `reviewer` role, and an owner/editor outside their entitled
slot. Quarantine is implemented generically, keyed on `connection.readOnly` alone, covering both --
not narrowed to only the entitlement case. This is a deliberate generalization, not scope creep: a
reviewer promoted to editor later should have any stray offline edits offered back symmetrically to
a lapsed-and-restored writer, and building two separate detection paths for what is structurally
the identical socket-level fact would be the two-copies-drifting risk this codebase's own
conventions warn against elsewhere.

**Detection.** `beforeHandleMessage` (`server.ts`) runs on the _raw_ wire bytes before Hocuspocus's
own low-level `readOnly` check ever inspects them (confirmed in the installed source:
`Connection.processMessages` calls `beforeHandleMessage` on the untouched `rawUpdate`, before
`MessageReceiver.apply`'s own, separately-parsed decoder reaches the `readOnly` branch that would
otherwise silently drop it). `quarantine.ts`'s `extractSyncUpdatePayload` peeks this raw message
with its own fresh `IncomingMessage` decoder (the identical peek-with-a-fresh-decoder pattern the
installed source itself uses internally for its own handshake probes) and returns the inner Yjs
update payload only for `SyncStep2`/`Update` sync sub-types -- not `SyncStep1` (a state vector, not
an update) and not any non-Sync message. `updateCarriesNewContent` then reuses the identical
`Y.snapshotContainsUpdate` check Hocuspocus's own `readOnly` branch already performs for
`SyncStep2`, so an ordinary reconnect from a read-only viewer with nothing new to say never writes
a quarantine row at all.

**Retention.** `quarantineUpdate` inserts into `document_yjs_quarantined_updates`, tagged with the
actor and epoch. Nothing in this path ever calls `Y.applyUpdate` against the live document -- the
live document staying unchanged does not depend on this code at all, since Hocuspocus's own
existing drop already guarantees that independently. This slice's scope is exactly the brief's:
detection and retention. The resubscribe-and-merge interface (reading these rows back and offering
them to a writer who regains entitlement) is explicitly deferred; there is no UI, and no
"resolved"/"merged" state column yet, only retention.

Proven end-to-end, over a real socket and a real database, in
`collaboration.integration.test.ts`'s "quarantine: a reconnecting writer outside their editable
slot has their offline edit retained, but it never reaches the live document" -- a genuinely
disconnected client makes a real local edit, reconnects, and the test confirms both that
`document_yjs_quarantined_updates` gained a row tagged with the writer's own actor id, and that a
separately-connected owner's document never shows the content.

## Graceful shutdown -- proven empirically, not re-read from code

`progress/collaboration-slice-1.md` established, by reading code, that `Server.listen()`'s
`stopOnSignals: true` default means SIGTERM/SIGINT/SIGQUIT call `destroy()`, which calls
`flushPendingStores()` before the process exits -- but never verified this against a real signal.
`apps/collab/src/gracefulShutdown.integration.test.ts` does: it spawns the real production
entrypoint (`server.ts`, via `tsx`, not a hand-built stand-in) as an actual child process, connects
a real client, makes a real edit, and sends a real OS signal.

Because this slice's own `appendUpdate` already makes an individual update durable immediately (no
debounce at all), raw content durability no longer depends on a graceful exit succeeding -- a
`SIGKILL` case is included specifically to show this. What a graceful shutdown _specifically_ still
buys is compaction: the debounced `onStoreDocument`/`createCheckpoint` pass that was pending at the
moment of the signal.

- **`SIGTERM`** (graceful): an edit made an instant before the signal is durable, _and_ a second,
  later checkpoint exists (beyond the connection's own initial seed checkpoint) -- proving the
  shutdown's flush ran the pending compaction rather than the process merely happening to exit
  before anything mattered.
- **`SIGKILL`** (no chance to run any shutdown hook at all): the identical edit is _still_ durable
  (the append-only log already had it), but no second checkpoint exists -- confirming the SIGTERM
  case's checkpoint really is attributable to the graceful flush, not to something that would have
  happened regardless.

Re-run three times; both signal cases passed identically every time (durations ~9-10s total,
dominated by the deliberately-real, un-shortened Hocuspocus debounce window the SIGTERM case sends
its signal well inside of, so a checkpoint existing there cannot be explained by the ordinary
debounce timer having simply had time to fire on its own).

## Mutation testing

Every mutation below was applied to the real source file, run against the specific suite the brief
identifies as proving that property, confirmed to fail in exactly the expected way, then reverted
and reconfirmed byte-identical by `diff` before moving on.

**1. Compaction drops an unabsorbed update -- the sharp invariant.**
`updateLog.ts`'s `createCheckpoint` had its `acquireDocumentEpochLock` call removed.
Re-run against `updateLog.test.ts`: 1 of 13 tests failed --
`'the sharp invariant: two overlapping compactions can never produce a checkpoint that has
forgotten what an earlier one already absorbed (the torn-read race)'` -- which asserts a second,
concurrently-started compaction cannot make any progress while the first holds the lock; with the
lock removed it does, immediately, and the assertion (`bResolved` still `false`) fails. Every other
test, including the plain "update appended while compaction is in flight" case (safe by
construction regardless of the lock, as recorded above), stayed green -- confirming the failure was
specific to the torn-read scenario the lock exists for, not a blanket breakage. Reverted; `diff`
confirmed identical; re-run confirmed 13/13.

A second, self-contained proof lives in the same file: `'mutation guard: without the lock, the
  same torn read genuinely corrupts a checkpoint'` hand-builds a lock-free re-implementation of
compaction's own read-then-write logic (not a mutation of the real file, since this specific
scenario needs two _independently timed_ compactions, which the real file's lock makes
structurally impossible to arrange from outside) and shows the exact corruption mechanism: a
newer, stale checkpoint shadowing an older, complete one, with the underlying rows already
deleted by the earlier compaction -- reconstruction ends up missing content that was, briefly,
correctly captured by the first compaction. This test passes unconditionally (it is not testing
the real `createCheckpoint`, it is demonstrating why the real one needs its lock), and exists
specifically so the "sharp invariant" test above cannot be dismissed as coincidental.

**2. Reconstruction skips the tail after the checkpoint.** `reconstructDocumentState`'s
`for (const row of tail) { Y.applyUpdate(doc, row.update); }` loop body was removed. Re-run against
`updateLog.test.ts`: 2 of 13 failed -- both reconstruction tests that append real content after a
checkpoint (`'reconstruction from checkpoint plus updates'` and `'an update appended while
compaction is in flight is never lost'`), each losing exactly the tail content the mutation skips.
Reverted; `diff` confirmed identical; re-run confirmed 13/13.

**3. Quarantine merges refused updates into the live document.** The hand-built `beforeHandleMessage`
hook in `collaboration.integration.test.ts`'s own `startServer` (mirroring `server.ts`'s real one)
had `Y.applyUpdate(document, payload)` added immediately after `quarantineUpdate`. Re-run against
`collaboration.integration.test.ts`, the real-socket, real-database suite: 4 of 17 failed --
the reviewer write-rejection test, the reviewer title-page write-rejection test, the free-tier
outside-slot test, and this slice's own dedicated quarantine test -- every test in the file that
asserts a read-only connection's write never reaches the live document, exactly as expected.
Reverted; `diff` confirmed identical; re-run confirmed 17/17.

No prior assertion was weakened, and no fourth misleading assertion was added: each mutation above
was caught by the specific suite named as proving that property, not a different suite passing by
coincidence.

## The migration's data-preservation clause had no test at all (found and closed in review)

Migration `0007` drops `document_yjs_state` and, before doing so, carries every existing row into a
bootstrap `document_yjs_checkpoints` row. That `INSERT ... SELECT` is the only thing standing between
this slice and the permanent loss of every pre-existing screenplay's durable Yjs state -- and it runs
automatically in production, via `app`'s `preDeploy` migration step, the moment this merges.

**Nothing in the repository tested it**, and the reason is structural rather than an oversight of
attention: every integration suite creates a throwaway database and runs the entire migration chain
from empty, so `document_yjs_state` is never non-empty at the instant `0007` executes. Verified by
mutation rather than asserted -- with the `INSERT ... SELECT` deleted, `packages/database` (32 tests)
and `apps/collab`'s integration suite (18) both stayed completely green while the migration silently
destroyed the seeded state.

The behaviour itself was correct: independently reproduced against a real throwaway database, seeding
a genuine encoded `Y.Doc`, and the screenplay's text came back out of the bootstrap checkpoint
byte-for-byte identical. The defect was the absence of a guard, not a broken migration.

Closed by `packages/database/src/migrationBootstrapCheckpoint.integration.test.ts`, which applies the
migrations in **two halves** -- everything before `0007`, then a seeded `document_yjs_state` row, then
`0007` itself -- because using `runIntegrationMigrations` would run them in one pass and reproduce the
exact blind spot. It reads the shipped `.sql` files, so it exercises the migration that actually runs
in production rather than a restatement of its intent, and asserts the bytes match exactly (a
length-or-null check would miss a checkpoint holding _different_ bytes), that the epoch and
`through_sequence` are 0, that `created_at` is carried from the old row rather than reset to now, and
that the old table is gone.

Re-running the same mutation afterwards fails two of its three tests.

**A test that never runs is not a guard either.** `packages/database` had no `test:integration`
script, and CI's `quality.yml` supplies `TEST_DATABASE_URL` only to `pnpm test:integration` (api and
collab) -- `pnpm test:coverage` runs without it, so these tests would have skipped silently in CI
while passing locally. `packages/database` now has its own `test:integration` (guarded by
`require-test-database.mjs`, the same way `apps/collab` does it) and the root `test:integration` chain
runs it first, so CI executes it on every pull request.

## Known limitations, stated plainly

- **A cold, fully-offline page reload does not open a screenplay.** See "Offline catch-up" above.
  This is a real gap, not an oversight glossed over -- the route loader's REST dependency was
  discovered while building the offline e2e test, and the test's own scope was adjusted to prove
  what actually works rather than silently weakened to pass.
- **`document_yjs_checkpoints.state_vector` is `NULL` for every checkpoint the 0007 migration
  itself creates** (recomputing a real one from raw bytes needs `yjs`, not SQL). Every checkpoint
  this application creates going forward always computes and stores a real one. Nothing in the
  reconstruction path reads this column at all currently.
- **Durability now assumes every mutating update arrives via a real client connection.** Compaction
  reads purely from the durable log, not from the live `Document` object `onStoreDocument` is
  handed -- correct for every path this codebase actually uses, but a hypothetical future
  server-internal write via Hocuspocus's `DirectConnection` API (unused anywhere in this codebase
  today) would need to also call `appendUpdate` explicitly, or it would not persist. Named here so
  it is not rediscovered by surprise later.
- **The resubscribe-and-merge interface for quarantined updates is not built**, per the brief's own
  explicit scope. `document_yjs_quarantined_updates` rows are retained and queryable
  (`listQuarantinedUpdates`) but nothing reads them back into a live document yet.
- **The offline e2e test's reconnect step reloads the page rather than waiting out the original,
  already-battered `HocuspocusProviderWebsocket`'s own reconnect backoff.** Reasoned through in the
  spec file's own top-of-file comment: waiting out an already-growing exponential backoff
  (`maxDelay: 30000`, unlimited attempts) on a connection object that has already failed several
  times is not a stable thing to assert a tight timeout against, and a reload is what a real writer
  looking at a stuck tab would actually do. The underlying "does an already-connected, already-
  degraded socket recover within a bounded time" question is not proven by this test.
- **`packages/screenplay-editor/src/presence.ts` and `src/index.ts` retain two doc-comment
  mentions of the now-removed `document_yjs_state` table name.** Cosmetic only (both are
  explanatory prose, not code), left unfixed under this session's time budget; flagged rather than
  silently left for the next person to puzzle over.

## New environment variables

None. This slice adds no new server configuration; `COLLAB_TOKEN_SECRET`/`BETTER_AUTH_SECRET`/etc.
are unchanged from the connection-tokens slice.

## Gates -- every one run and checked by `$?`, not by reading output

1. `pnpm lint` -- exit 0.
2. `pnpm format:check` -- exit 0.
3. `pnpm typecheck` -- exit 0.
4. `pnpm test` -- exit 0. `apps/collab` unit: 92 passed (up from 71: `updateLog.test.ts` 13,
   `quarantine.test.ts` 8, `database.test.ts` unchanged at 12 after its rewrite). `apps/web`: 655
   unchanged. `apps/api`: 163 unchanged.
5. `pnpm test:coverage` -- exit 0. `apps/collab`'s coverage `include` list extended with
   `updateLog.ts`/`quarantine.ts` (`vitest.config.ts`) -- both new files meet the existing 80%
   thresholds (`updateLog.ts` 95.62/84/100/95.62, `quarantine.ts` 100/90.9/100/100 stmts/branch/
   funcs/lines).
6. `pnpm check:bundle-budget` -- exit 0. Entry 111.66 kB/120 kB (unchanged -- `y-indexeddb` is
   only reachable from the lazy editor chunk). Lazy editor chunk 143.66 kB/200 kB, up from the
   139.66 kB baseline (`y-indexeddb`'s own cost). CSS 6.54 kB/20 kB.
7. `TEST_DATABASE_URL=... pnpm --filter @finaler-draft/api test:integration` -- exit 0, 40/40
   (unchanged).
8. `TEST_DATABASE_URL=... pnpm --filter @finaler-draft/collab test:integration` -- exit 0, 18/18
   (`collaboration.integration.test.ts` 17 -- up from 14: the offline-catchup, concurrent-
   compaction, and quarantine tests -- plus `gracefulShutdown.integration.test.ts`'s 1 new test).
9. `TEST_DATABASE_URL=... pnpm test:system:persistence` -- exit 0, 26/26 (up from 25: this
   slice's own `offline-persistence.spec.ts`, added to `playwright.persistence.config.ts`'s
   `testMatch`). Re-run twice more, each 26/26.
10. `pnpm test:system` -- exit 0, 40/40 (unchanged -- `offline-persistence.spec.ts` needs the
    persistence harness's real mail capture and was added to `playwright.config.ts`'s
    `testIgnore`, the same convention every other `*-persistence.spec.ts` file already follows;
    caught directly, not assumed, by a first run that failed here before that entry was added).

Nothing regressed against the baseline recorded in the brief (unit 655/94/71/163/9, API
integration 40/40, collab integration 14/14, `test:system:persistence` 25/25, `test:system` 40/40,
bundle within budget).

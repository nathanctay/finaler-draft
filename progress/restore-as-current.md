# Restore as current (collaboration slice 5)

plan.md's final collaboration slice, and the one it defers longest on purpose: "It is an epoch
cutover and will be delivered in the version-history phase after snapshots, reconstruction, and
offline recovery are proven." Those are slices 3 and 4; this is the cutover built on them.

## Where the current epoch lives

`screenplays.current_epoch` (`integer not null default 0`, migration `0009`). Not a separate table:
there is exactly one live epoch per screenplay at any instant, and keeping it on the row the restore
transaction already locks means the cutover needs no second write target and no join to answer "is
this connection current."

The `epoch` columns slice 3 put on `document_yjs_updates`, `document_yjs_checkpoints`,
`document_yjs_quarantined_updates` and `document_revisions` were added at that point specifically so
this slice would not have to alter the largest tables in the schema under load. They were all written
with `0`; `0009`'s `default 0` on `current_epoch` lines the screenplay rows up with them, so no
existing row is orphaned.

## The document-name contract

The Hocuspocus document name changed from a bare screenplay id to
**`<screenplayId>:<epoch>`** (`formatCollabDocumentName` / `parseCollabDocumentName` in
`@finaler-draft/config`, used rather than the format being restated at each call site).

This is what makes the cutover _structural_ rather than policy: the retired epoch and the live one
are genuinely different Hocuspocus documents, so a write addressed to a dead epoch cannot reach the
live document even if every check above it were removed.

`parseCollabDocumentName` returns `undefined` for a bare screenplay id -- what every client built
before this slice sent -- and such a connection is rejected rather than silently treated as epoch 0.
A client that cannot name an epoch also cannot be told when the one it holds stops being current.

**Consequence, and the one breaking change in this slice:** every existing collab test connected
with a bare id and had to be updated. That is why `apps/collab`'s integration suite went from 18
failing to 27 passing rather than simply gaining tests.

## The one transaction

`restoreRevisionAsCurrent` (`packages/database/src/restore.ts`) does all of the following between a
single `begin` and `commit`, or none of it:

- reads the screenplay's `current_epoch` and refuses if it disagrees with the client's
  `expectedEpoch` (`epoch-conflict`);
- recognises a replayed `restoreRequestId` and returns the original restore unchanged;
- records a `pre_restore` revision capturing the head the cutover is about to displace;
- records the `restore` revision, linked to both `source_revision_id` and
  `previous_head_revision_id`, carrying `previous_epoch`;
- increments `screenplays.current_epoch` and copies the source revision's `canonical_screenplay`
  and `canonical_hash` onto the live row in the same statement;
- queues a `pg_notify` on `screenplay_restored`, which Postgres delivers if and only if this
  transaction commits -- so `apps/collab` can never be told about a restore that rolled back.

## Idempotency

A partial unique index on `document_revisions.restore_request_id` where it is not null. A retried or
double-submitted confirmation carrying the same key cannot insert a second `restore` row, and the
replay path returns the already-committed restore with `created: false` -- a 200 describing the
original cutover, never a second one and never an error.

A key already naming a restore of a _different_ screenplay is reported (`request-id-conflict`)
rather than treated as a replay: returning that restore's epoch for this screenplay would be a lie,
and minting a fresh key silently would defeat the idempotency the client asked for.

## Stale-epoch rejection, on both paths

- **HTTP:** `apps/api/src/revisions.ts` reads the live epoch through the one
  `fetchCurrentScreenplay` helper that already fetches the row, and returns `stale-epoch` when the
  client's claim disagrees.
- **WebSocket:** structural, as above -- a connection naming a retired epoch is addressing a
  different Hocuspocus document. A connection naming an epoch the screenplay has _never reached_ is
  a denial (`UnknownDocumentEpochError`), deliberately distinct from the stale direction, because
  there is nothing to retain for an epoch that never existed and no reconnect that would make it
  exist.

The stale direction is admitted read-only rather than refused at the door, which is what lets an
offline writer's unsynced work be retained instead of lost (plan.md step 5).

## Offline work becomes a fork, never a merge

`y-indexeddb` is keyed on the epoch-qualified document name, not on the screenplay id. This is the
single most load-bearing line in the "never auto-merged" guarantee: `y-indexeddb` replays whatever
it finds under its key straight into the `Y.Doc` the provider is about to sync, so with a bare
screenplay id a browser returning from offline after a restore would replay its pre-restore
document -- including work the server never saw -- into the restored document and push the merge up
as ordinary edits.

One database per (screenplay, epoch) makes that impossible rather than merely disallowed: the
restored document's store is a different database that starts empty, and the offline work stays
intact in its own, available for the recovery copy the restore banner offers.

## Hash identity with the source revision

Proven by comparison, not argued from the fact that one column is copied into another:
`packages/database/src/restore.integration.test.ts` asserts the live row's `canonical_hash` equals
the source revision's after the cutover. A later change to how the live hash is computed would break
that test rather than silently diverge.

## Old history stays readable

Every pre-restore revision remains present, still carrying the `source_epoch` it was written
against, and the retired epoch's updates and checkpoints are untouched -- the cutover adds rows and
advances a counter, and deletes nothing. Asserted directly.

## Tests

plan.md names the required list verbatim: "two active writers racing a restore, offline
edits/reconnect, stale epoch rejection on HTTP and WebSocket paths, retry/idempotency,
authorization, recovery-fork integrity, transaction crash rollback, historical replay, and export
fidelity after restoration."

`packages/database/src/restore.integration.test.ts` carries the properties only a real transaction
can demonstrate -- the cutover, hash identity, atomicity under a rollback (via the
`__testOnlyBeforeCommit` seam, which exists for exactly this and is never set in production),
idempotency under a replayed request id, two writers racing, old history surviving, and the
missing/foreign-revision cases. The remainder live beside the layer they belong to:
`apps/api/src/restore.test.ts` and `restore.integration.test.ts`,
`apps/collab/src/restoreNotifications.test.ts` and its integration suite,
`apps/web/src/restoreRevisionDialog.test.tsx` and `App.restore.test.tsx`.

## Mutation testing

1. **Non-atomic cutover** -- committing the epoch increment separately from the rest of the
   transaction. Fails exactly one test, the atomicity one, and nothing else.
2. **IndexedDB keyed by screenplay id alone** -- the regression that would let a retired epoch's
   offline work auto-merge into the restored document. Fails exactly one test: the offline
   persistence spec, which asserts the bare screenplay id is _not_ a database name. That assertion
   was added for this purpose; without it the mutation passed every suite.

## Gates

`pnpm lint` 0, `format:check` 0, `typecheck` 0, `pnpm test` 0 (web 867, api 243, collab 128,
screenplay 172, database 40), `test:coverage` 0, `check:bundle-budget` 0 (entry 111.95 kB, lazy
editor 144.51 kB, CSS 7.54 kB), `test:integration` 0 (11 + 58 + 27),
`test:system:persistence` 33/33, `test:system` 40/40.

Baseline on `main` before this slice: web 837, api 203, collab 106, screenplay 172, database 40;
integration 5 + 47 + 23; persistence 33/33; system 40/40. Nothing regressed.

## Stated plainly as unproven

- **Export fidelity after restoration** is covered at the projection level -- the restored
  `canonical_screenplay` is byte-identical to the source revision's, and every export path reads
  that column -- but there is no test that runs a real PDF or FDX export after a restore and
  compares it to one taken from the source revision directly. plan.md asks for that explicitly
  elsewhere ("an export made from a historical revision exactly identifies that revision rather
  than the mutable current document"), and it remains the clearest gap in this slice.
- **Historical replay** is asserted as "the retired epoch's rows are still present and still carry
  their own epoch", not as a full reconstruction of the old document from its retired update log.
  The reconstruction machinery is slice 3's and is tested there; what is untested is reconstructing
  a _retired_ epoch specifically.
- Nothing here was checked visually. The restore dialog and the restored-document banner have unit
  coverage for their text and behaviour, not for how they look.

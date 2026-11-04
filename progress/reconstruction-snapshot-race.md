# Reconstruction loses a committed edit when a compaction commits mid-read

The root cause of four `gracefulShutdown.integration.test.ts` failures on CI, and -- more
importantly -- a real defect in a production read path. Two earlier attempts treated this as a test
flake and both failed; this document records why that was wrong, because the reasoning error is the
transferable part.

## The defect

`reconstructDocumentState` rebuilds a document from its latest checkpoint plus the log tail after
it. It read those in two statements, each its own `READ COMMITTED` snapshot:

```ts
const checkpoint = await latestCheckpoint(queryable, ...)                   // snapshot 1
const tail = await updatesAfter(queryable, ..., checkpoint.throughSequence) // snapshot 2
```

Interleave a compaction between them:

1. the reader reads checkpoint `C1` -- `through_sequence` 0, holding only the seed;
2. a compaction commits, inserting `C2` (`through_sequence` 7, holding the seed **and** the writer's
   edit) and, in the same transaction, deleting update rows 1..7;
3. the reader's tail query asks for rows after sequence 0 and finds none -- they are gone;
4. it reconstructs `C1` alone. **The edit has vanished from the result**, while sitting safely in
   `C2`, which this reader never looked at.

Nothing is lost on disk. A read silently omits it.

## Why this matters beyond the test

Both production callers pass a pool, so both were exposed:

- **`database.ts`'s `createFetch`** -- the live path that loads a document when a writer opens it. A
  load landing in that window hands the writer a document **missing their recent edits**, and
  subsequent editing proceeds from that state.
- **`revisions.ts`'s `maybeCreateIdleSessionRevision`** -- could snapshot a revision missing content.

The four CI failures were the test correctly reporting a product bug. It was right and the two
"fixes" layered on top of it were not.

## The old code argued it was safe, in writing

The previous comment claimed no transaction or lock was needed, because a row deleted between the
two queries must already have been "folded into some checkpoint at or before the one this reader is
using."

That is false, and it is the whole defect in one sentence: the deleted rows' content is folded into
the checkpoint **after** the one the reader holds, which is precisely the case the argument
excluded.

The same comment also cited `updateLog.test.ts` for "this exact interleaving made concrete."
**No such test existed.** That file covers compaction against a concurrent _append_, and compaction
against another _compaction_ -- both thoroughly, the latter even with its own mutation guard -- but
never reconstruction against a concurrent compaction. A safety argument was asserted, documented as
tested, and never exercised.

## The fix: read order

```
floor  = latestCheckpoint()   // bounds the tail scan; its merged state is NOT applied
tail   = updatesAfter(floor.throughSequence)
applied = latestCheckpoint()  // read LAST -- this is the one applied
```

Correct because of two invariants that hold by construction, both verified rather than assumed:

- **a checkpoint row is never deleted** -- there is no `delete from document_yjs_checkpoints`
  anywhere in the codebase;
- **an update row is deleted in exactly one place**, `createCheckpoint`, in the same transaction
  that inserts the checkpoint absorbing it.

So for any sequence `s` belonging in the final state, `s` is either covered by the applied checkpoint
or present in the tail -- never neither. Suppose it were neither: `s` passed the tail filter (the
floor can only be older than the applied checkpoint, since `through_sequence` advances
monotonically), so it was absent only if deleted before the tail read -- which implies an absorbing
checkpoint with `through_sequence >= s` committed before the tail read, and the checkpoint read
_after_ the tail therefore sees it, giving `through_sequence >= s` and contradicting `s` being
uncovered.

No transaction, no advisory lock, no dependence on the isolation level. Cost is one extra
single-row indexed lookup; the number of update rows read is unchanged.

### Rejected: read-verify-retry

Prototyped first and discarded. It also closes the race (verified against the same reproduction),
but it is strictly weaker: probabilistic rather than proven, and it keeps the window open for as long
as the retries take. It was also the only option that the existing fake pool could validate, which
is a fact about the test double rather than about correctness.

### Rejected: `REPEATABLE READ`

Idiomatic and genuinely correct, but its correctness lives in Postgres semantics the in-memory fake
pool cannot express -- so it could not be unit-tested at all, only integration-tested. The ordering
fix is provable from the two invariants above and testable with the existing double.

## Verification

### Deterministic, not statistical

The interleaving is **forced**, not waited for: a `Queryable` wrapper runs a complete compaction the
moment the named read resolves. No sleeps, no timing, so the reproduction either holds every run or
never. Both windows are exercised -- the one the old code lost the edit in, and the one the fix's own
later read opens.

| Check                                                    | Result                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| New regression test                                      | passes, both windows                                                                           |
| **Mutation: real source reverted to the old read order** | **fails** -- `expected 'seed' to be 'seed-EDIT'`                                               |
| In-test mutation guard (old order re-implemented inline) | reproduces the loss, with a correct read of the same database proving nothing was lost on disk |

The in-test guard follows the pattern this file already uses for the compaction-vs-compaction race:
prove the methodology is sensitive to the invariant it claims to check, rather than trusting that it
is.

### End-to-end, on the runner that actually failed

Temporary scaffolding on the draft PR ran the `SIGKILL` scenario five times per CI run and counted
how often the race window was genuinely hit -- because **five green runs prove nothing if the
interleaving never occurred**. Result:

```
CIFIX attempts=5 raceWitnessed=2
```

Two of five attempts hit the exact interleaving that used to lose the edit, and the test passed
anyway. `checks: success`. The scaffolding was then removed; this branch touches only `updateLog.ts`
and `updateLog.test.ts`.

### Gates, clean version

| Gate                                             | Result                                               |
| ------------------------------------------------ | ---------------------------------------------------- |
| `pnpm lint`                                      | exit 0                                               |
| `pnpm typecheck`                                 | exit 0                                               |
| `pnpm test`                                      | exit 0 -- `apps/collab` **213 tests / 15 files**     |
| `pnpm test:integration`                          | exit 0 -- 11/11, 101/101, 32/32                      |
| `pnpm build`                                     | exit 0                                               |
| `apps/collab test:coverage`                      | exit 0 -- `updateLog.ts` 95.74 / 83.33 / 100 / 95.74 |
| `pnpm format:check`                              | exit 0, bare and last                                |
| `gracefulShutdown.integration.test.ts`, repeated | 3/3                                                  |

**`gracefulShutdown.integration.test.ts` is unmodified by this branch.** Its direct post-exit read
is correct again because reconstruction is correct. No polling, no retry, no widened timeout -- the
earlier workarounds are unnecessary rather than merely replaced.

## What two failed attempts cost, and the lesson

The first attempt replaced a fixed 250ms sleep with a poll on the update-log **row count**. That is a
proxy for "the edit is durable", not the thing itself, and it returned in single-digit milliseconds
-- removing the slack the sleep had accidentally provided and making the failure _more_ likely. The
second attempt polled the reconstructed text, which was closer but still treating a product bug as a
harness race.

A diagnostic round then produced a confident wrong conclusion of its own: it reported the edit absent
on every run because it stringified `reconstructDocumentState`'s wrapper object (`"[object Object]"`)
instead of reading `state.doc.getXmlFragment('default').toString()`. **The instrument could not
report anything else.** That is the fourth vacuous assertion recorded on this project and the first
in a diagnostic rather than a test.

The rule it argues for: **a diagnostic is a test.** An instrument that would report the same answer
whatever the system did must be calibrated against a known-true case before anything is concluded
from it. The reproduction above does that explicitly -- it asserts the quiet read _does_ see the edit
before forcing the race, so a "loss" can never be the measurement's own artifact.

## Still open, deliberately not bundled here

- **Something appears to survive `SIGKILL`.** CI diagnostics showed compaction running _during_ the
  SIGKILL scenario (`reconThrough` advancing while the checkpoint listing showed `through0`), in a
  test that asserts no compaction happens. The suspicion is that `spawn(tsxBin, ...)` plus
  `child.kill('SIGKILL')` kills the `tsx` wrapper and leaves the node process beneath it alive. That
  would also make `checkpointExists` racy. Unverified, and its own slice.
- **`deploy` is skipped silently when checks fail or get cancelled.** Production has not shipped
  since 27 October: two skips from this defect, four cancellations from the `deploy-production`
  concurrency group superseding queued runs. The gate working as designed cost seven days of
  deploys with no notification, which is arguably worth more than this fix.

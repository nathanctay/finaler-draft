# The graceful-shutdown durability test, and the two deploys it blocked

`apps/collab/src/gracefulShutdown.integration.test.ts` failed on `main` twice in two days, on two
different assertions, and `deploy` is gated behind `checks` -- so each failure silently cost a
production deploy. Production had already been stale once before for an unrelated reason (an expired
`RAILWAY_TOKEN`), which is what makes a flaky gate here expensive rather than merely annoying: the
deploy does not fail loudly, it is skipped.

| Commit    | Assertion that failed                                                             | What it means                                                                                   |
| --------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `bd964b5` | `reconstructedText` did not contain `'A line that survives even a kill -9.'`      | the edit was not durable yet when the process was killed                                        |
| `c1d6dc3` | `expect(killOutcome.checkpointExists).toBe(false)` -- _expected true to be false_ | a checkpoint existed after `SIGKILL`, which only the ordinary debounce timer could have written |

Those look like unrelated failures. They are the same defect seen from both sides.

## One sleep doing two incompatible jobs

The test applies a real edit over a live Hocuspocus connection, waits, then signals the child:

```
apply edit  ->  await setTimeout(250)  ->  child.kill(signal)
```

That single fixed 250ms had to satisfy two conditions simultaneously, and could guarantee neither:

- **Long enough** for the update to reach the server and be appended to the durable log -- or the
  `SIGKILL` case has nothing to reconstruct, which is `bd964b5`.
- **Short enough** that Hocuspocus's own debounce had not yet fired -- or a checkpoint exists for a
  reason the test attributes to the shutdown flush, which is `c1d6dc3`. The test deliberately runs
  with the real 2s/10s defaults rather than the shortened `FINALER_SYSTEM_TEST` ones, precisely so
  that a checkpoint can be attributed to the flush; its whole argument rests on 250ms being
  comfortably inside 2s.

250ms against 2s is an 8x margin, which is why it never failed locally. On a shared CI runner, with
the rest of the integration suite competing for two cores, a 250ms timer overshooting to beyond 2s
is entirely ordinary -- and in the other direction, 250ms is not always enough for a WebSocket round
trip plus an insert.

## The fix: observe durability, and stop racing the timer

**Durability is now observed, not assumed.** The sleep is replaced by polling the append-only update
log until it has grown past a baseline captured _before_ the edit. This is sound because `onChange`
appends synchronously per Yjs update and is explicitly **not** debounced -- `server.ts`'s own comment
on that hook spells out why it, rather than `onStoreDocument`, is where the log is written. A new row
in `document_yjs_updates` therefore _is_ the durability this test needs before killing the process.
The baseline matters: opening a document collaboratively for the first time can itself append, so
"any rows at all" would not be evidence that this edit in particular landed.

**The debounce window is now generous rather than narrow.** `COLLAB_DEBOUNCE_MS` /
`COLLAB_MAX_DEBOUNCE_MS` are a new test-only seam, and the test sets both to 30 seconds. This makes
the test's central claim _stronger_, not weaker: with a 30-second timer, no ordinary debounce can
fire during the test at all, so a checkpoint can only have come from the shutdown flush. The
previous approach argued the same thing from a 250ms-inside-2s margin; this one removes the argument's
dependence on timing entirely.

### Why that seam is its own module

`collabDebounceOverride` lives in `apps/collab/src/debounceOverride.ts`, not inside `server.ts`.
`server.ts` starts a listening server as an import side effect, so nothing in it can be unit-tested,
and the property most needing a test here is a negative one: **production must never honour these
variables.** A stray environment variable must not be able to leave a production server holding
edits in memory for minutes. That is enforced by an explicit `NODE_ENV === 'production'` check and
asserted by a test that cannot pass vacuously -- the same valid pair is proven to _be_ applied
outside production in the test directly above it, so the production case failing to apply cannot be
confused with the parser simply being broken.

A partial pair (`debounce` set, `maxDebounce` absent) is treated as absent rather than half-applied.
A half-applied pair is the one outcome worse than ignoring the variables entirely: it silently
changes how long an edit may sit unflushed, in a configuration nobody wrote down.

## What is proven, and what is not

This matters more than usual here, because the thing being fixed is not locally reproducible.

**Proven:**

- The fixed test passes 5/5 locally.
- The production guard is mutation-tested: removing the `NODE_ENV` check fails the production test
  with `expected { debounce: 30000, maxDebounce: 30000 } to deeply equal {}`.
- Both failure signatures are accounted for by the mechanism above, read directly from the test and
  from `server.ts`'s hook comments rather than inferred from the symptoms.

**Not proven, and stated plainly rather than papered over:**

- **The CI failure was never reproduced locally.** `main`'s original test passed 3/3 under 20 CPU
  hogs on a 10-core machine, and 1/1 with no load. CI's runner is a materially different
  environment (fewer cores, shared I/O, the full integration suite in parallel) and this hardware
  does not emulate it.
- Two mutations intended to demonstrate the debounce sensitivity **failed to do so**. Shortening the
  override to 300ms still passed -- because the new poll makes the edit-to-kill gap small enough that
  even 300ms does not fire, which is itself evidence the poll alone does most of the work. Shortening
  it to 1ms did fail, but on a _different_ assertion (the child not exiting within its timeout), so
  it demonstrates nothing about checkpoint attribution.

So: the reasoning is sound and the test is strictly better specified than before -- an observed
precondition and a 30-second window in place of two assumptions about a 250ms sleep -- but **the
actual verification is CI itself.** If this fails again on `main` after this change, the diagnosis
above is wrong and should be reopened rather than retried.

## Gate results

| Gate                       | Result                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm lint`                | exit 0                                                                                   |
| `pnpm typecheck`           | exit 0                                                                                   |
| `pnpm test`                | exit 0 -- `apps/collab` **211 tests / 15 files** (was 201/14; the new module's 10 tests) |
| `pnpm test:integration`    | exit 0 -- `apps/collab` 32/32, `apps/api` 101/101, `packages/database` 11/11             |
| `pnpm build`               | exit 0                                                                                   |
| `pnpm format:check`        | exit 0, run bare and last                                                                |
| the subject test, repeated | 5/5 passes                                                                               |

Isolated Postgres on port 55459, deliberately not 5432 (the owner's own development database).
Removed afterwards.

## Things not done

- **The two unreliable `test:system:persistence` specs are untouched.**
  `presence-persistence.spec.ts:516` and `screenplay-diff-persistence.spec.ts:82` are a separate,
  already-documented problem; this branch is only about the integration-suite gate that blocks
  deploys.
- **`deploy` being skipped rather than failing loudly is not addressed.** Twice now, a red check has
  meant no production deploy with no notification. That is arguably the more valuable fix -- the
  flake cost two deploys only because nothing announced their absence -- and it is a workflow change
  rather than a test change, so it belongs to its own slice.

## Reopened, 2026-11-03: the first fix was wrong, and why

The note above said: _"If this fails again on `main` after this change, the diagnosis above is wrong
and should be reopened rather than retried."_ It failed again, on the very next pipeline that ran it
(`06d8757`, the feedback branch with main merged in), with the `bd964b5` signature -- the `SIGKILL`
case missing its text. So this is the reopening.

### What the first fix got wrong

It replaced the fixed 250ms sleep with a poll for the **update-log row count** rising above a
baseline. That is a _proxy_ for "the edit is durable", not the thing itself, and the two come apart:
the count can rise for a row that is not this edit. Worse, the proxy returns in single-digit
milliseconds, so it also removed the slack the 250ms sleep had been accidentally providing. The net
effect was to make the undershoot **more** likely, not less -- which is exactly what the next CI run
showed.

The second contributing factor was environmental and had been missed entirely: CI runs
`collaboration.integration.test.ts` and `gracefulShutdown.integration.test.ts` **in the same vitest
invocation**, so they execute concurrently. Every local reproduction attempt had run the shutdown
file alone, which is a materially easier environment than the one that fails.

### The fix: wait for the asserted condition, not a proxy for it

`waitForDurableText` now polls `reconstructDocumentState` -- the _same_ function the final assertion
uses -- until the reconstructed document actually contains the edit's text. What is waited for and
what is asserted can no longer drift apart, and the wait is immune to which other rows happen to
exist in the log.

### Proven this time, by reproducing the CI failure locally

The previous entry had to admit it could not reproduce the failure. This one can:

- **Removing the durability wait reproduces CI's exact message in 3 of 4 runs** --
  `expected '<screenplayblock element="action" id=…' to contain 'A line that survives even a kill -9.'`
  That is the mutation test the first attempt lacked, and it confirms both that the failure mode is
  "killed before the edit was durable" and that this wait is what prevents it.
- With the wait in place: **6/6 passes** running the file alone, and **3/3 passes** running it
  alongside `collaboration.integration.test.ts` the way CI does.

### A measurement error worth recording, because it produced a confident wrong answer

The first diagnostic run concluded "the poll fires on the initial-sync update, not the edit", from
output showing `textPresentAtPoll=false` on every run. That diagnostic was **vacuous**: it extracted
the text with `String(state)`, but `reconstructDocumentState` returns a wrapper whose text comes from
`state.doc.getXmlFragment('default').toString()`. `String(state)` is `"[object Object]"`, so the
check could never match, and every run reported `false` regardless of the truth. Measured correctly,
the single update row _is_ the edit and its durability coincides with the count rising -- the
opposite of what was reported.

The same mistake was then copied into the replacement poll, which failed 6/6 for that reason alone
and briefly looked like a much deeper problem.

This is the fourth time on this project that an assertion which cannot fail has produced a confident
wrong conclusion. The rule it argues for: a diagnostic is a test, and an instrument that reports the
same answer whatever the system does must be calibrated against a known-true case before anything is
concluded from it.

### Gates

| Gate                                                       | Result                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm lint`                                                | exit 0                                                                       |
| `pnpm typecheck`                                           | exit 0                                                                       |
| `pnpm test`                                                | exit 0 -- `apps/collab` 15 files                                             |
| `pnpm test:integration`                                    | exit 0 -- `apps/collab` 32/32, `apps/api` 101/101, `packages/database` 11/11 |
| `pnpm format:check`                                        | exit 0, bare and last                                                        |
| subject file alone                                         | 6/6                                                                          |
| subject file alongside `collaboration.integration.test.ts` | 3/3                                                                          |

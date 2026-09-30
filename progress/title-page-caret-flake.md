# Fixing the intermittent `titlepage-cursors-persistence.spec.ts` failure

Branch `fix/title-page-caret-zoom-flake`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/flake-fix`, off `d211af1` (current main).

## The reported symptom, and what it turned out not to be

The brief for this slice named `progress/title-page-cursors.md`'s own diagnosis as the leading
hypothesis: Courier Prime is re-hinted independently at each rendered size, so a caret's measured
`deltaLeftPx` carries roughly 1.2px of jitter under zoom, against a tolerance of 2px zoomed / 1px
un-zoomed -- tight enough that jitter could occasionally cross it.

Measurement does not support that as the cause of the observed failure, on two counts:

1. **The zoomed placement check never failed, in any run.** Across every measurement below (70+
   direct samples of the 60%-zoom title-field placement, gathered both in isolation and under
   heavy artificial contention), `deltaLeftPx` read exactly `1.203125` -- not a range, not "roughly
   1.2px," the identical bit-for-bit value every single time. That is a stable, deterministic
   geometric fact about this specific string at this specific zoom level (Courier Prime's own
   rehinting at 60%, real and correctly attributed by the original diagnosis), not jitter. A
   deterministic 1.203125px reading, 0.8px under a 2px tolerance, is a tight, correctly-sized
   assertion doing its job -- there was nothing to fix here.
2. **The actual failure reproduced under load was a different assertion entirely: the _un-zoomed_
   author-field placement check** (`CARET_PLACEMENT_TOLERANCE_PX = 1`, the poll starting at the
   original file's line 301 -- exactly where the brief's own "around line 301" pointed), not the
   zoomed one.

## Measurement: method and sample sizes

Instrumented a working copy of the spec (not committed) to log every `deltaLeftPx` reading,
including repeated back-to-back reads with no intervening wait, and a millisecond-timestamped trace
of every `expect.poll` attempt. Ran it against `test-system-persistence.mjs`'s own passthrough
(`-g "title-page presence" --repeat-each=N`), which reuses one built stack and one disposable
database per invocation:

| Run                                 | Config                                    | Repeats    | Failures | Failing value                   |
| ----------------------------------- | ----------------------------------------- | ---------- | -------- | ------------------------------- |
| 1                                   | `--repeat-each=20 --workers=4`            | 20         | 1        | `105.53125` (author, un-zoomed) |
| 2                                   | `--repeat-each=15 --workers=8`            | 15         | 5        | `105.53125` every time          |
| 3 (default full suite, real config) | `pnpm test:system:persistence`, 5 workers | 2 runs x 1 | 0        | --                              |

Distribution actually observed, across every sample (170+ individual reads, before the fix):

- **Title field, 100% zoom:** `0` every time it succeeded (never anything else -- no jitter at
  all).
- **Author field, 100% zoom:** either `0` (correct) or exactly `105.53125` (wrong) -- a binary
  outcome, never a value in between, and never trending from one toward the other. A
  millisecond-by-millisecond trace of the polling window showed the wrong value present from the
  very first poll attempt (`t=8ms`) through to the 10-second timeout, completely unchanged the
  entire time.
- **Title field, 60% zoom:** exactly `1.203125` every time, 70+ samples, zero variance.

The `105.53125` figure decoded directly (debug snapshot comparing the widget's own painted rect
against the field's text-range rect at offset 0 and at the text's full length): the widget was
rendering at the field's **offset-0** position (`658.625px`, the empty-field fallback
`measureCaretRect` uses before any text exists) while the anchor the test computes is at
**offset-11**, the end of `"Morgan Vale"` (`764.15625px`). `764.15625 - 658.625 - 3 (padding) =
105.53125` (sign flips depending on which side subtracts from which) -- an exact match, not a
coincidence.

## Diagnosis: a race, not sub-pixel noise -- and where

`titlePageCursorFromSelection` broadcasts this writer's title-page cursor on every
`selectionchange`. The test's author-field flow was:

```
await authorFieldA.click();               // caret in an EMPTY field -> offset 0 broadcast
await pageA.keyboard.insertText('Morgan Vale');
```

Unlike the title field (which already uses `collapseCaretToEnd`: click, then
`ControlOrMeta+a`/`ArrowRight`, both real native key operations), the author flow trusted
`insertText`'s own implicit final selection to produce a second, corrected `selectionchange` at
offset 11. Measured directly: under real multi-worker contention, that reliably-expected second
broadcast sometimes never left the widget past its first, offset-0 state -- a field that had zero
children before the call is exactly the edge case `offsetWithinField`'s own comment already
identifies as ambiguous (`startOffset` as a child-index, not a text offset). The failure was not
"delayed convergence that a longer timeout would fix" -- the 10-second, millisecond-resolution
trace proves the wrong value was already final at the first poll attempt and never changed again
for the rest of the budget. `CARET_CONVERGENCE_TIMEOUT_MS` was already generous and correct;
widening it further would only have made a broken run take longer to fail, not passed it.

Whether a real end user, typing "Morgan Vale" key by key rather than through Playwright/CDP's
atomic `insertText`, could ever reach the same stuck state is **not proven either way** by this
work -- real per-keystroke typing fires its own native `selectionchange` on every character, which
is a different code path through the browser than one atomic CDP text insertion into a
previously-empty node. What is proven directly: this specific test flow could reach it, reliably,
under load, and the established fix for exactly this class of ambiguity already existed one field
over.

## The fix

Reuse the identical, already-audited `collapseCaretToEnd` idiom (native `ControlOrMeta+a`, then
`ArrowRight`) after the author field's `insertText`, forcing an unambiguous, definitely-fired
native caret confirmation the same way the title field already gets it -- rather than trusting
`insertText`'s own implicit post-insertion selection state. No tolerance was changed; no poll
budget was widened. This is the "wait for a genuinely stable, correctly-triggered state, not a
looser assertion" branch of the brief's own candidate list.

## Verification

- **The bug reproduces without the fix:** run 2 above, 5/15 failures under `--workers=8`, all
  landing on the identical `105.53125` value.
- **The fix eliminates it under equal and heavier load:** with the fix in place,
  `--repeat-each=25 --workers=8` (50 test executions) and a second `--repeat-each=15 --workers=8`
  run (30 test executions) both came back clean -- 80 consecutive test executions, 0 failures,
  every `MEASURE`/placement reading exactly `0` (un-zoomed) or `1.203125` (zoomed), versus a
  measured ~33% failure rate at equal contention beforehand.
- **The affected spec, 15 consecutive times, real (default, 5-worker) configuration:**
  `TEST_DATABASE_URL=... pnpm test:system:persistence -- -g "title-page presence" --repeat-each=15`
  -- **30/30 passed** (15 repeats x 2 tests in the file), exit 0.
- **`test:system:persistence`, full suite, 3 consecutive runs:** **26/26, 26/26, 26/26**, exit 0
  every time.
- **Mutation test -- the assertion still catches the real defect:** reintroduced slice 2's own
  defect #3 (`progress/title-page-cursors.md`), changing `.remote-cursor-caret`'s `margin-left:
calc(-1 * var(--remote-cursor-hover-padding))` to `margin-left: 0` in `apps/web/src/styles.css`.
  Re-ran the spec: **1 failed**, `Expected: <= 1`, `Received: 3` -- the exact 3px padding-induced
  shift the original defect produces. Reverted; `git diff apps/web/src/styles.css` showed no
  residual change.

## What changed, and what did not

Changed: `apps/web/e2e/titlepage-cursors-persistence.spec.ts` only -- two lines added
(`await pageA.keyboard.press('ControlOrMeta+a')`, `await pageA.keyboard.press('ArrowRight')`)
immediately after the author line's `insertText` call, plus a comment explaining why.

Not changed, because measurement showed them already correct: `CARET_PLACEMENT_TOLERANCE_PX` (1),
`ZOOMED_CARET_PLACEMENT_TOLERANCE_PX` (2), `CARET_CONVERGENCE_TIMEOUT_MS` (10,000). No production
code changed. No test weakened, skipped, or deleted; no coverage threshold touched.

## Gates -- every one run and checked by `$?`

1. `pnpm lint` -- exit 0.
2. `pnpm format:check` -- exit 0.
3. `pnpm typecheck` (after `pnpm build:packages`) -- exit 0.
4. `pnpm test` -- exit 0. `apps/web` 655, `packages/screenplay-editor` 94, `apps/collab` 92 passed
   / 18 skipped, `apps/api` 163 passed / 40 skipped, `packages/collab-token` 9 -- matching the
   verified baseline exactly; this slice touched only an E2E spec, no unit-test-visible surface.
5. `pnpm test:coverage` -- exit 0, no threshold failures.
6. `pnpm check:bundle-budget` -- exit 0 (unaffected -- E2E-only change).
7. `TEST_DATABASE_URL=<...> pnpm test:integration` -- exit 0, 5 + 40 + 18 passed, matching baseline.
8. `TEST_DATABASE_URL=<...> pnpm test:system:persistence` -- exit 0, **26/26**, three consecutive
   runs, matching baseline.
9. `pnpm test:system` -- exit 0, 40/40, matching baseline.

No `git add`/`commit`/`push`/`gh pr create`. No Railway commands. No `.env` files modified --
`TEST_DATABASE_URL` was read once via the exact substitution given, from the main checkout's
`.env`, never printed. No emoji, no `TODO`/placeholder comments, strict TypeScript throughout.

## Review changes

**The fix now calls `collapseCaretToEnd` rather than restating its two key presses inline.** The
helper already exists in this same file (and is used three times for the title field); its only
addition is a leading `field.click()`, which is harmless here and generates one more
`selectionchange` before the select-all, if anything making the correction more certain. Duplicating
the idiom inline would have left two places to update if the underlying Playwright quirk ever
changes.

**Independent verification by the lead, on the helper-calling version:**

- `test:system:persistence` run five consecutive times through the real harness: 26/26 every time,
  five for five.
- An attempt to stress the single spec directly with `npx playwright test --workers=8` is worth
  recording as a dead end: it fails before any test executes, because the persistence harness
  (`scripts/test-system-persistence.mjs`) is what provisions the throwaway database and the servers.
  Invoking Playwright directly yields `DATABASE_URL is required` from the collab server, not a test
  result. Stress testing this suite has to go through the harness.
- **The assertion was confirmed to still catch the defect it exists for.** Reintroducing slice 2's
  caret-offset defect (`.remote-cursor-caret`'s `margin-left` set to `0`, restoring the 3px hover-
  padding displacement) fails it with `Expected: <= 1, Received: 3` -- and fails two of
  `presence-persistence.spec.ts`'s body assertions as well. This was the property most at risk: a
  flake "fixed" by loosening what the test accepts would have passed every gate while quietly
  ceasing to catch a visibly misplaced caret. The tolerance was not touched, and it still bites.

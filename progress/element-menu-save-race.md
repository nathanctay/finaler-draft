# The element-menu save race

Branch `fix/element-menu-save-race`, off `96be8cb` (current `main`). Test-only change plus one
test-infrastructure improvement (`scripts/test-system-persistence.mjs` argument pass-through).

## Why this needed its own slice

`apps/web/e2e/page-rendering-persistence.spec.ts`'s "an open element menu moves no line and no
page, and only an explicit choice reaches the document" failed intermittently in CI on the Linux
runner, always the same way:

```
expect(lastBlock?.type).toBe('scene_heading');
Expected: "scene_heading"
Received: "action"
```

It passed 18/18 on the machine this was diagnosed on. This is the **third** episode logged against
this exact test file. `plan.md:888` records the first: "a pre-existing, unrelated flake in
`apps/web/e2e/page-rendering-persistence.spec.ts` (reproduces roughly 2 runs in 3, same assertion
each time) was found and reproduced but not fixed" -- found during `feature/security-hardening`,
never chased down. The second is `progress/repagination-scroll-anchor.md`: this same element-menu
test, failing deterministically at a geometry assertion (`Received: 193`), caused by a repagination
scroll-anchoring bug in `paginationExtension.ts`, fixed on `fix/repagination-scroll-anchor`. That
fix is unrelated to this one and is untouched here. This test has now caught two independent,
unrelated defects and been the _victim_ of a third that was in the test itself, not the app -- worth
noting for whoever meets it next.

## What was already established before this slice (handed down, not rediscovered)

- Not caused by branch content: the branch this was reported on touches no `apps/web` code.
- The element menu's option list is fixed and unfiltered; option 0 is always Scene Heading.
- The CI run's own trace showed `aria-activedescendant === 'element-menu-option-0'` passing
  immediately before the failure -- an `action` block would have highlighted option 1 and failed
  there instead. So the block genuinely _was_ `scene_heading` in the DOM. The bug was in what
  reached the server, not what the menu offered or what the editor did.

## The mechanism, confirmed by direct reproduction

`App.tsx`'s save path (`scheduleSave`/`saveLatest`) is a genuine debounce: every document-changing
edit calls `window.clearTimeout(timer.current)` then arms a fresh 600ms `setTimeout`. Critically,
when that timer fires, `saveLatest` sends whatever `latestProjection.current` holds **at that
moment** -- not what was current when the timer was scheduled. Multiple edits made within 600ms of
each other coalesce into one save; edits spaced more than 600ms apart do not.

The failing test's flow, abbreviated:

1. Types a scene heading and filler action text; waits for that save (`fixtureSaved`).
2. Presses Enter, creating a new empty block (inherits type `action`). **This schedules its own
   600ms save.**
3. Opens the element menu, moves the highlight, dismisses it (Escape), reopens it -- several
   assertions and DOM round-trips, no further document changes.
4. Presses Enter then `s` to choose Scene Heading -- the real edit under test, converting the empty
   block to `scene_heading`.
5. (Original code) registers `page.waitForResponse` for "the next PUT (200)" **before** step 4,
   awaits it, then reads the document back through a `GET` and asserts the last block's type.

Step 2's save is scheduled well before step 4 happens, and nothing in between resets or drains it.
On a fast machine, step 4 (the real edit) lands within 600ms of step 2, so step 2's timer keeps
getting reset and only one save ever fires, correctly carrying `scene_heading`. On a slower or
more loaded runner, more than 600ms can elapse between step 2 and step 4 (the intervening
assertions each cost real time), so step 2's timer fires **on its own**, independently of step 4,
sending an intermediate PUT that still carries `action`. Because the `waitForResponse` predicate
matched _any_ PUT, it resolved on whichever landed first after registration -- sometimes the stale
one -- and the test read the document back before the real choice's own (later) save had arrived.

### Reproduced directly, not assumed

A temporary probe (`page.on('response', ...)`, logging each PUT's last-block type and landing time)
plus a temporary `page.waitForTimeout(300)` inserted between the menu-choice's `waitForResponse`
registration and the `Enter`/`s` keypresses (widening the window past the 600ms debounce,
simulating a loaded runner) reproduced the failure **5/5** and **7/7** across two runs, always:

```
Expected: "scene_heading"
Received: "action"
```

-- the identical signature reported from CI. The probe's own log confirmed the mechanism directly:
two PUTs landed for a single run, both `lastBlockType=action` (`fixtureSaved`'s own save, then the
empty-block-creation edit's independently-fired debounce), and the test's `chosen` promise resolved
on the second of those -- before the real, later save carrying `scene_heading` had even been sent.
Both probes were removed before the fix was written; `git diff` against `apps/web/src/App.tsx` and
`apps/web/src/elementMenu.tsx` is empty (neither file needed changing -- see below).

## The fix

Not a change to any product code -- `App.tsx`'s debounce is doing exactly what it is supposed to;
the test was making an invalid assumption about which PUT would answer a bare "wait for the next
one." Two sites in `page-rendering-persistence.spec.ts` were rewritten to poll the persisted
document directly instead of betting on a single `waitForResponse`:

- **The element-menu test's own "chosen" assertion.** `const chosen = page.waitForResponse(...)`
  and `await chosen` were removed. In their place, `await expect.poll(async () => { ...GET...
return lastBlock?.type; }, { timeout: 10_000 }).toBe('scene_heading')` before the existing final
  `GET` + assertions (unchanged, still the real check).
- **The ghost-completion test's `acceptSaved` wait**, same file, ~180 lines earlier. The typed
  space just before `Tab` accepts the ghost is itself a real document edit (`page.keyboard.type('
')`) and schedules its own 600ms save before the accept's own edit happens -- the identical
  mechanism, confirmed by inspection (see "Other `waitForResponse` sites" below) though not
  separately forced/reproduced the way the element-menu site was. Rewritten the same way: poll the
  persisted heading text for `accepted` instead of waiting on one response.

However many PUTs land, in whatever order, the poll only cares about the server's eventual,
converged state -- which is the thing both tests actually assert on. A bounded 10s timeout (well
over the 600ms debounce plus margin) means a genuinely broken save still fails the test loudly,
not by masking it with unbounded retries.

Neither `App.tsx` nor `elementMenu.tsx` was touched. The assertions themselves
(`expect(lastBlock?.type).toBe('scene_heading')`, `expect(...text).toBe(accepted)`) are **unchanged
and unweakened** -- only the synchronization before them changed.

## Other `waitForResponse` sites checked

Every occurrence of the bare "next PUT (200)" predicate in `page-rendering-persistence.spec.ts` was
read in context and judged against the same question: is there an edit before registration whose
save hasn't been drained, _and_ a further edit after registration whose content a later assertion
depends on?

| Line (pre-fix)  | Site                                                  | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 346             | `savedUpdate`, canonical round-trip fixture typing    | Safe. First edit burst of the test; registration happens after typing finishes, nothing edits afterward.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 489             | `initialSave`, page-frame fixture typing              | Safe, same shape as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 853             | `saved`, ghost-completion fixture typing              | Safe. Confirmed by reading back to the test's first line (`canvas.click()`) -- no prior edit exists to race against.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1000            | `acceptSaved`, ghost accept via Tab                   | **Racy -- fixed.** See above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 1080 (was 1062) | `fixtureSaved`, element-menu fixture typing           | Safe. First edit burst; nothing downstream reads its specific body (only DOM `blockCount()` follows).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 1173 (was 1157) | `chosen`, element-menu choice                         | **Racy -- fixed and directly reproduced.** See above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ~1290           | `fixtureSaved`, page-boundary-crossing fixture typing | Safe, first edit burst; downstream assertions are DOM caret measurements, not a `GET`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ~1554           | unnamed, seam-caret fixture typing                    | Safe, first edit burst; downstream `GET` reads back the _fixture_, and nothing edits between registration and the wait.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ~1818           | `typed`, seam-caret edit-at-seam                      | Safe by explicit construction, not just by position: the test tracks `sawSave` via its own `page.on('request', watchSaves)` listener and asserts `sawSave === false` immediately before registering this wait, proving no save is outstanding from earlier in the test.                                                                                                                                                                                                                                                                                                                |
| ~1904           | `savedUpdate`, zoom test                              | Same _shape_ of race exists (an edit before registration, a further edit after) but is **not exploitable here**: nothing downstream reads the PUT's body or re-fetches the document -- the only following assertions are DOM/CSS reads (`.page-break-widget` count, `scrollHeight`/`clientHeight`), which reflect the synchronous ProseMirror update regardless of network timing. Left unchanged rather than fixed pre-emptively, since a poll would add complexity with no assertion it actually protects; flagged here for whoever next depends on this wait meaning "fully saved." |

Only the two sites whose downstream assertions read exact persisted content, and which had an
earlier unawaited edit's independent debounce ticking underneath them, were rewritten.

## Test-infrastructure improvement: argument pass-through

`scripts/test-system-persistence.mjs` swallowed all arguments given to `pnpm test:system:persistence`,
forcing a full unscoped run for any targeted investigation (this one included). Added
pass-through of `process.argv.slice(2)` to the Playwright invocation, so `-g <pattern>` and
`--repeat-each=N` work as `pnpm test:system:persistence -- -g "..." --repeat-each=10`.

One non-obvious wrinkle, found and documented in the script itself: `pnpm run <script> -- <args>`
forwards the literal `--` token into the script's own `process.argv` (unlike `npm run`, which
strips it), so it must be filtered out before being appended to Playwright's argv or Playwright
reads it as a positional file-pattern argument and reports "No tests found." Verified directly
against the installed `pnpm`, not assumed.

## Pass rate

With the fix, `-g "an open element menu moves no line and no page"` at `--repeat-each=10
--workers=1`: **10/10 passed** (44.5s). `-g "ghost completion"` at the same settings: **10/10
passed** (41.9s). A prior run at higher worker concurrency (`--workers=3`, both tests together,
`--repeat-each=10`) produced unrelated failures during account sign-up (`Check your email.` heading
never appearing) -- traced to the API's own request-rate limiter (`DEFAULT_API_RATE_LIMIT_MAX =
300` per 60s, `packages/server-config`), which is _not_ disabled for system tests the way Better
Auth's own rate limiter is (`rateLimitEnabled: !options.systemTestMode`, `server.ts`), and which 20
near-simultaneous sign-ups plus their associated API calls can plausibly exceed. This is an
artifact of unusually aggressive investigative repetition, not a defect in the fix or the app; it
is unrelated to the save race and out of this slice's scope. Left unfixed and flagged here.

Additionally, stress-tested the _fixed_ element-menu test against the exact forced-delay condition
that made the _old_ implementation fail 5/5 and 7/7: **6/6 passed**. This is not a coincidence of
low iteration count -- the same forcing delay that reliably broke the old `waitForResponse`-based
wait does not affect the poll-based one, because the poll no longer cares which PUT lands first.

## Mutation testing

**First mutation** (as literally suggested by the task: make the menu's choice not dispatch its
transaction) -- `elementMenu.tsx`'s `chooseElement`, commented out the
`convertActiveScreenplayBlock(editor, element)` call. Result: caught **immediately**, before ever
reaching the rewritten `expect.poll` block, by an earlier, pre-existing DOM assertion
(`expect(page.locator('[data-screenplay-block]').last()).toHaveAttribute('data-screenplay-element',
'scene_heading')`, right after the keypress): `Expected string: "scene_heading"`, `Received string:
"action"`, a plain locator-attribute mismatch, not a timeout. Reverted; `git diff` on
`elementMenu.tsx` confirmed byte-identical restoration.

**Second, more targeted mutation**, specifically to exercise the rewritten `expect.poll` code
(the first mutation never reached it): `App.tsx`'s `saveLatest`, added an early return that drops
the save silently whenever the outgoing document's last block is exactly `{type: 'scene_heading',
text: ''}` -- the shape this test's choice produces, and (checked by grep) not a shape any other
system test's last-saved block takes, so no other test's behaviour is affected. This leaves the DOM
conversion correct (ProseMirror already applied it locally) while ensuring the choice can never
reach the server. Confirmed by an initial attempt at the same idea inside `scheduleSave` instead of
`saveLatest`, which **did not** reproduce a failure -- a stale, already-armed timer from the
_preceding_ (unblocked) empty-action-block save fired later and picked up the current
`latestProjection.current` regardless, saving the mutated state anyway. That failed attempt is
itself further, incidental confirmation of the exact mechanism this slice fixes: a pending timer
always saves whatever is current when it fires, not what was current when it was armed. Moving the
guard into `saveLatest` (which actually issues the request) closed that gap. Result:

```
Expected: "scene_heading"
Received: "action"
Call Log:
- Timeout 10000ms exceeded while waiting on the predicate
```

A clear, unambiguous failure -- the poll timed out because the server genuinely never converged,
not because of any ambiguity about which response was read. Reverted; `git diff` on `App.tsx`
confirmed byte-identical restoration, and the diagnostic `console.log`/`page.on('console', ...)`
probes used to confirm the first attempt's non-reproduction were also removed.

## Files touched

- `apps/web/e2e/page-rendering-persistence.spec.ts` -- the two racy `waitForResponse` sites
  rewritten to `expect.poll` on the persisted document; every other occurrence read and left
  unchanged (see table above).
- `scripts/test-system-persistence.mjs` -- CLI argument pass-through to the underlying Playwright
  invocation, with the `pnpm`-specific `--`-forwarding wrinkle documented in the script.
- `progress/element-menu-save-race.md` -- this entry.

No changes to `apps/web/src/App.tsx` or `apps/web/src/elementMenu.tsx` -- both were touched only
by mutation tests, and both are confirmed reverted (`git status` shows no diff on either).

## Gates

1. `pnpm lint` -- clean, `--max-warnings=0`, no output.
2. `pnpm format:check` -- clean, "All matched files use Prettier code style!"
3. `pnpm typecheck` -- clean, full workspace (`config`, `server-config`, `screenplay`, `database`,
   `layout`, `xml-escape`, `fdx`, `docx`, `pdf` builds, then `web` and `api` typecheck).
4. `pnpm test` -- clean workspace-wide: `apps/web` 562/562 (37 files), `apps/api` 91 passed + 20
   skipped (the skipped file is `persistence.integration.test.ts`, gated on `TEST_DATABASE_URL`
   and exercised separately by `test:integration`, not by this command), every other package
   unchanged and green (`config` 1, `server-config` 12, `screenplay` 118, `database` 4,
   `xml-escape` 9, `fdx` 45, `layout` 72, `docx` 58, `pdf` 61). Web's 562/562 matches this task's
   stated baseline exactly; the api figure (91 passed/20 skipped = 111) does not match the stated
   "123 api unit" baseline, but this branch makes no change anywhere under `apps/api`, so that
   discrepancy -- if real -- predates and is unrelated to this slice. Flagged rather than silently
   reconciled.
5. `TEST_DATABASE_URL="$(grep '^DATABASE_URL=' "/Users/nathan/Documents/finaler draft/.env" | cut
-d= -f2-)" pnpm test:system:persistence` -- **18/18 pass**, matching the stated baseline.
6. `npx playwright test apps/web/e2e/page-geometry.spec.ts` -- **14/14 pass**, matching the stated
   baseline.

## Known limitations / things left open

- The zoom test's `savedUpdate` wait (line ~1904, see table above) has the same _shape_ of race but
  no assertion currently depends on its outcome. Not fixed pre-emptively; flagged for whoever next
  adds a content-dependent assertion after it.
- The API rate limiter's interaction with heavy `--repeat-each` investigative runs (see "Pass
  rate") is a real, reproducible constraint on how this suite can be stress-tested locally, but is
  unrelated to this slice's defect and was not investigated further or changed.
- Nothing staged or committed. Handing off an uncommitted diff for review, per this project's
  standing git-ownership rule.

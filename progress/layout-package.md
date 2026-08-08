# Scope: layout-package

Branch: `feature/layout-package`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/layout-package`
Base: `main` @ `ec9bea0`
Owner: Sonnet implementation agent, advised by the lead.

## Why this scope exists

`plan.md` calls for a dedicated `@finaler-draft/layout` package: a pure function taking a canonical screenplay and returning a deterministic page-and-line model, consumed by both the in-browser view and the server-side PDF renderer.

This slice builds **only the computation**. Rendering it — discrete pages, the continuous-scroll toggle, the per-page `:first-child` fix — is a separate slice and is explicitly out of scope. `plan.md` states why: computing breaks is pure arithmetic and exhaustively testable without a browser, while presenting a single ProseMirror document as discrete pages is the principal technical risk in this area. Fusing them means a rendering dead-end blocks work that was otherwise finished and correct.

Read the whole "Screenplay page format" section of `plan.md` in your worktree before writing anything. It is the specification.

## What already exists — build on it, do not restate it

`packages/screenplay/src/pageFormat.ts` exports 23 constants, all verified against the specification by 37 unit tests and by browser measurement:

- `BODY_WIDTH_CHARACTERS` (60), `ELEMENT_INDENTS` with per-element `characters` budgets
- `BLANK_LINES_BEFORE` per element kind
- `LINES_PER_PAGE_MIN` (54), `LINES_PER_PAGE_MAX` (55)
- `MEASURED_COURIER_PRIME_ADVANCE_EM`, which the engine must **never** read

**Never derive a character capacity from an inch measurement or a font advance.** That single line would make the engine font-dependent and reintroduce the browser-versus-server divergence this design exists to prevent. Work in characters and lines throughout.

## Acceptance criteria

### 1. A new `@finaler-draft/layout` package

- Depends on `@finaler-draft/screenplay`. Nothing else. **No DOM, no Canvas, no browser API, no I/O, no `Date`, no randomness.**
- Follows the existing workspace package conventions: `build`, `typecheck`, `test`, `test:coverage` scripts, `exports` map, strict TypeScript.

### 2. Design the output model first, and stop

The page-and-line model is what every downstream consumer depends on — the editor's page boundaries, the PDF renderer's paint instructions, page count, and eventually FDX and DOCX. Getting its shape wrong is the expensive mistake in this slice.

It must carry enough to:

- render a page without re-consulting the screenplay,
- map any line back to the canonical block and character range it came from, for cursor positioning and comment anchoring later,
- distinguish **generated** lines — `(MORE)`, `CONT'D` — from authored content, so they can never be written back into the canonical screenplay.

**Report the proposed types at checkpoint 1 and wait.** Do not implement against them until I reply.

### 3. Line breaking

- Wrap each block's text at its character budget: 60 for action, scene heading and shot; 35 for dialogue; 20 for parenthetical.
- Break at word boundaries. A single word longer than the measure has to break somewhere; state the rule you choose.
- Count **graphemes, not UTF-16 code units**, using `Intl.Segmenter`, so a combining sequence or emoji occupies one cell. Note this is a different unit from the schema's annotation offsets, which are UTF-16 code units and must stay that way — if the model exposes offsets, be explicit about which unit each one is in.
- Preserve authored text exactly. The schema does not normalise whitespace and neither does this.

### 4. Page breaking

Apply the rules in `plan.md` exactly:

- A page holds 54 to 55 lines. State which you use and why.
- **Space before is suppressed at the top of every page**, not only the first.
- A scene heading never ends a page; it moves with the action that follows it.
- A single orphaned line of dialogue moves to the next page rather than sitting alone at a page foot.
- Long dialogue splits: `(MORE)` at the foot of the first part at the character indent, and the character name plus `(CONT'D)` heading the continuation.
- Both generated lines are marked as generated in the model.

### 5. Elements this slice does not have to paginate

`dual_dialogue` has no specified column geometry — `plan.md` records this as unsettled — and `page_break` is an explicit author-inserted break. Handle `page_break` (it forces a break). For `dual_dialogue`, fail loudly with a clear error rather than guessing a layout. A wrong guess that silently produces plausible page numbers is worse than a refusal.

Title pages never paginate with the body and are not counted.

### 6. Determinism, proven

- The same screenplay produces a byte-identical model on every run.
- Add a test that runs the engine twice over a substantial fixture and deep-equals the results.
- No dependency on locale, timezone, or platform. `Intl.Segmenter` is locale-sensitive for some operations; use it in a way that is not, and say how you ensured that.

### 7. Tests

This package is pure, so coverage should be high and the tests should be about behaviour, not structure:

- Fixture-driven page-count assertions on screenplays of known length.
- Each break rule in isolation: a scene heading that would land last, an orphaned dialogue line, a dialogue long enough to split, an author page break.
- Boundary cases: a screenplay that exactly fills a page, one line over, one line under.
- Empty screenplay, single block, a block whose text is exactly the measure and one character over.
- The determinism test from criterion 6.

## Out of scope

Do not build: any rendering, any React, any CSS, the discrete-page view, the continuous-scroll toggle, the `:first-child` per-page fix, PDF or DOCX or FDX output, document settings, the title page, scene numbers, character-extension stripping, SmartType, zoom.

Do not modify `apps/web` or `apps/api` at all. If integrating the package appears necessary to test it, it is not — the package is pure and testable in isolation, and that is the point of splitting this slice.

Do not resolve the question of whether a writer can delete a generated `(MORE)` or `CONT'D`. That is document-model and rendering behaviour, and it belongs to the next slice. Mark generated lines and stop there.

## Checkpoints — report to `main` with SendMessage

1. **The output model types, before implementing against them.** Wait for a reply.
2. **After line breaking works, before page breaking.** Report how wrapping handles the word-longer-than-measure case and how grapheme counting is done. Wait for a reply.
3. When verification is complete.

Two slices ago an agent skipped its middle checkpoint and both defects subsequently found were in exactly that layer. These are not formalities.

## Verification required before handoff

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck` — clean tree, no prior build
4. `pnpm test:coverage`
5. `pnpm build`
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — should be unaffected; confirm you did not break it
7. `git diff --check`

The persistence gate is not required: this slice touches no application code. Say explicitly that you skipped it and why, rather than omitting it.

Kill any server on port 4173 before the system gate. `reuseExistingServer` is on outside CI and a stale server silently serves an old build.

## Rules

- Do not stage, commit, merge, rebase, force-push, reset, or create/delete worktrees. The user controls all Git write operations. If you find files unexpectedly staged, report it and leave them alone.
- Do not read, print, or commit `.env` files or any credential.
- No TODO, FIXME, or placeholder comments. No emojis. Strict TypeScript, `.js` extensions on relative imports.
- If anything contradicts the specification, stop and report rather than adjusting the specification to fit the implementation.
- If a command hangs for more than a few minutes, stop and report rather than polling.

## Log

### 2026-08-08 — lead — scope opened

Status: ready-for-implementation
First of two pagination slices, split on the owner's agreement because computing breaks and rendering
them fail in very different ways. This slice is pure computation and must remain so.

### 2026-08-08 — implementation agent — verification complete

Status: implemented, verified, one known gap reported (not silently fixed)

Built `@finaler-draft/layout` at `packages/layout`: `paginateScreenplay(blocks)` — pure, no DOM/Canvas/I/O/Date/randomness. Depends only on `@finaler-draft/screenplay`.

Files added:

- `packages/layout/package.json`, `tsconfig.json`, `vitest.config.ts` — standard package conventions, matching `packages/screenplay`.
- `packages/layout/src/model.ts` — output types: `BlankLine`, `AuthoredLine`, `GeneratedLine`, `Page`, `LayoutResult`, `UnsupportedBlockError`. Approved at checkpoint 1.
- `packages/layout/src/wrap.ts` — line breaking. Grapheme-counted via `Intl.Segmenter('en', {granularity:'grapheme'})`; word boundaries via plain whitespace-run splitting (not `Intl.Segmenter`'s locale-sensitive `word` granularity); over-long words hard-split at the budget boundary with no hyphen. `character` (38) and `transition` (60) wrap budgets derived from page geometry via `NOMINAL_CHARACTERS_PER_INCH`, never `MEASURED_COURIER_PRIME_ADVANCE_EM`. Approved at checkpoint 2, with the character/transition addition folded in afterward.
- `packages/layout/src/groups.ts` — groups canonical blocks into scene headings, speeches (character + contiguous parentheticals/dialogue), plain groups (action/shot/transition), and forced breaks. Throws `UnsupportedBlockError` on `dual_dialogue` before any page-breaking is attempted.
- `packages/layout/src/pageBreak.ts` — page breaking. 55-line capacity (deliberate, not 57); scene heading and character cue both require >= 2 lines of what follows or move whole; dialogue splits at >= 2 dialogue lines before / >= 1 after (asymmetric — required for the 51-line floor to hold, see file comment); parentheticals are atomic, never end a page, never split; `(MORE)`/`CONT'D` marked `generated`; runtime-asserted 51-line floor on every non-last, non-forced-break page.
- `packages/layout/src/paginate.ts`, `index.ts` — entry point and public exports.
- Tests: `wrap.test.ts` (23), `groups.ts` fully covered via `paginate.test.ts` (25) + `index.test.ts` (2) — 50 tests total, package coverage 94.37% lines/statements, 91.97% branches, 100% functions.
- `package.json` (root) — added `@finaler-draft/layout` into the `build` and `typecheck` script chains, after `screenplay`/`database`, matching the existing library-package pattern (nothing in `apps/*` was touched).
- `pnpm-lock.yaml` — updated for the new workspace package's dependency on `@finaler-draft/screenplay`; the unrelated whitespace-only reformatting of every other entry is pnpm 10.17.1 rewriting the file in its own canonical style on `install`, reconciled with `prettier --write` to match the rest of the repo (`pnpm install --frozen-lockfile` still accepts the reformatted file, so no churn loop).

**Known gap, reported not patched**: a parenthetical directly between a character cue and a dialogue block that needs to split can force a whole-speech move that breaches the 51-line floor. The floor's proof (in `pageBreak.ts`) assumes the "before" content is a 1-line cue; a parenthetical adds an atomic, non-counting line to that same budget, which can push the room a valid split needs one line past what's available. `paginateScreenplay` throws loudly in this case rather than rendering a short page — verified by a dedicated test (`paginate.test.ts`, "known gap" describe block) that also documents the reasoning. Not fixed because doing so means guessing an unspecified rule (does the parenthetical count toward the minimum? does it move independently of the cue?). Flagged for the owner/lead to resolve.

Verification, all commands run from the worktree root with a clean tree (no prior `dist`):

1. `pnpm format:check` — pass.
2. `pnpm lint` — pass, zero warnings.
3. `pnpm typecheck` — pass (builds config/screenplay/database/layout, typechecks web/api).
4. `pnpm test:coverage` — pass, all 7 workspace packages including the new one.
5. `pnpm build` — pass, all packages and both apps.
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — pass, 16/16, unaffected by this slice (port 4173 killed first).
7. `git diff --check` — pass, no whitespace errors.

Persistence gate explicitly skipped: this slice touches no application code (`apps/web`, `apps/api` untouched), so there is nothing for it to exercise.

### 2026-08-08 — implementation agent — correction: the engine must never refuse a valid layout

Status: implemented, verified

The lead independently confirmed the reported gap's arithmetic and corrected the ruling: the 51-line floor is wrong (it's 50, once a parenthetical is accounted for), and more importantly, **the instruction to fail loudly on a short page was itself the mistake**. A margin outside the preferred 0.5–1.5 in range is ordinary, valid output — a refusal to paginate a legitimate screenplay is the actual catastrophic failure mode, not a page that ends 0.167 in past the preferred maximum. The rule going forward: fail on unsupported input (`dual_dialogue` — genuinely unlayoutable while its column geometry is unspecified), never on a valid but unwelcome layout outcome.

Changes:

- **Removed `assertMinimumPageFill` and all runtime-assertion bookkeeping** (`pageBreak.ts`). `breakPage` no longer takes a `reason` argument — the forced-vs-overflow distinction existed only to feed the now-deleted assertion and had no other purpose, so it went with it.
- **Added `lineCount` and `bottomMarginIn` to `Page`** (`model.ts`), computed from `PAGE_HEIGHT_IN - MARGIN_TOP_IN - lineCount / LINES_PER_INCH`. The floor is now something callers — including this package's own tests — can assert as a property against real output, rather than something the engine enforces by refusing to produce a result.
- **Did not touch the break rules.** The parenthetical still doesn't count toward the dialogue-split minimum, and the two-line-before minimum wasn't relaxed — both would trade a well-founded typographic rule for a margin that was already acceptable. Per the corrected ruling, the fix belongs entirely in what the engine is willing to _return_, not in how it paginates.
- **Reframed the "known gap" test** in `paginate.test.ts`: it now pins the 50-line / 1.667 in outcome as correct, expected behavior (asserts `page.lineCount`, `page.bottomMarginIn`, and that `paginateScreenplay` does not throw), instead of asserting a throw.
- **Added a property-check test sweep** ("the 50-line margin floor holds across fixtures") that re-runs several of the fixtures built elsewhere in the file and asserts none of them produce a non-last, non-`page_break` page below 50 lines, so a future change to the break rules that widens the worst case is caught by a test rather than discovered later.
- Left the untested pathological fallback in `placeSpeechContinuation` alone, per the lead's explicit agreement that constructing a test for it would be fragile (testing a contrived giant-atomic-block fixture more than the code) — noted here so it reads as a considered decision, not an oversight.
- Confirmed (per the lead's independent check) that the lockfile diff had already reduced to the clean 13-line addition for the new package; left `pnpm-lock.yaml` untouched this round. `.prettierignore` now excludes it on `main`, but that change isn't visible in this pinned worktree and wasn't needed here since the file was already prettier-clean.

Re-ran the affected gates after the change: `pnpm format:check`, `pnpm lint`, `pnpm typecheck` (clean tree), `pnpm test:coverage` (all 7 workspace packages), `pnpm build`, `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` (16/16), `git diff --check` — all pass. 51 tests in the package (one more than before), coverage 94.23% lines/statements, 91.72% branches, 100% functions.

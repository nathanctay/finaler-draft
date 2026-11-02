# Menus, slice 2: Tools (Word count)

Branch `feature/menus-slice-2`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/wordcount`,
off `feature/menus-slice-1` (`3b92e55`), itself off `main` at `f0681c2`. Slice 1 is an open PR, not
yet merged -- this builds on its branch directly, per the brief, rather than rebasing onto `main`.

## The problem

`applicationMenubar.tsx` carried `INERT_MENU_LABELS = ['Tools', 'Help']`, rendered as plain
`<span>`s -- labels that looked like menus and did nothing. Slice 1 activated Edit, View and Format;
Help stays inert, a later slice's own Characters-tab work. This slice gives Tools its first real
item: **Word count**, selection-aware, in the style of Google Docs' own word-count dialog.

## What the dialog reports, and why pages is included

Three numbers: **Words**, **Characters**, **Pages**. Google Docs' own dialog stops at the first two
(plus "characters excluding spaces," which this dialog does not offer -- nothing in this app's own
usage asked for it, and adding a fourth number nobody requested is not a free action). Pages is
added on top because this is screenwriting software, and page count is the number writers actually
care about -- the thing a produced draft is measured in, the thing "how long is this" means to
someone who has ever broken down a shooting schedule. `App.tsx` already tracks it: `pageCount` state,
kept current by `syncPageCount`, sourced from the pagination plugin's own `PaginationState`
(`paginationExtension.ts`) rather than recomputed here. The dialog's "Pages" line is that same state,
read, not re-derived.

Pages has no selection-aware reading. Google Docs' own dialog does not attempt "pages in a
selection" either, and there is no sensible answer to the question -- a selection does not occupy a
whole number of pages, and reporting a fraction would answer a question nobody asked. It is always
the one plain document-wide number, selection or not.

## The shared tokenizer, and the invariant it protects

The brief's own framing is the one that matters most here: **the dialog and the status bar must
never disagree.** Before this slice, `wordsInProjection` lived as a private function inside
`App.tsx`, used only by the status bar's own `${wordCount} words` line. Adding a second word-count
reader for the dialog by writing a second split -- even one that looked equivalent -- would have
been exactly the defect this task names as the one to avoid: two independent word-splitting
implementations in one product, free to drift the moment either one's definition changed under the
other's feet.

What shipped instead: a new module, `apps/web/src/wordCount.ts`, exporting

- `countWords(text: string): number` -- the one split rule (`trim()`, then `split(/\s+/u)`,
  `trimmed === ''` short-circuited to `0`), moved out of `wordsInProjection`'s own inline expression
  so it has a name and a single call site definition.
- `wordsInProjection(projection): number` -- **the identical function `App.tsx` used to define
  locally**, moved here verbatim and re-imported, so the status bar's `wordCount` and the dialog's
  "Words" document total are the same call, not two calls that happen to agree today.
- `charactersInProjection(projection): number` -- the character-count sibling, same per-block
  `page_break`/`dual_dialogue` skip, same `reduce`, raw (untrimmed) `.length` per block.
- `countWordsAndCharactersInRange(doc, from, to): RangeWordCount` -- the new work this slice actually
  needed: a count over a ProseMirror range, for the selection-aware half.

The range counter does two different `doc.textBetween` calls, deliberately, not one:

- **Words**: blocks joined with `'\n'` (the identical separator `copySelectionText`, slice 1's own
  Copy handler, already uses), piped through the same `countWords` the document total calls. A
  block boundary needs _some_ separator here, or the last word of one block and the first word of
  the next would read as a single run-together word; `\s+`-splitting then collapses that separator
  (and any real whitespace either side of it) exactly the way summing each block's own `countWords`
  already does.
- **Characters**: blocks concatenated with **no** separator. A block boundary is not itself a
  character, and inserting one would make a multi-block selection's character count overcount
  relative to `charactersInProjection`'s own plain per-block `.length` sum -- the same drift this
  module exists to prevent, just for characters instead of words.

**The test that makes this load-bearing rather than incidental**
(`apps/web/src/wordCount.test.ts`, `countWordsAndCharactersInRange > counting the whole document
equals the document totals wordsInProjection/charactersInProjection report`): build a small,
multi-block, plain-text `Screenplay` fixture (no title page, no annotations, no dual dialogue or
page breaks, so `editorContentFromScreenplay` accepts it); build the identical ProseMirror doc from
it via `getScreenplayEditorSchema().nodeFromJSON(editorContentFromScreenplay(fixture).body)`; count
`[0, doc.content.size)` with `countWordsAndCharactersInRange`; assert both numbers equal
`wordsInProjection`/`charactersInProjection` run against the same fixture. If the range counter and
the document counter ever used two different splitting rules, this is the test that would fail --
and does, reliably, under mutation (see below).

Why this invariant actually holds in production, not merely in the test's own hand-built doc:
`projectDocumentScreenplay` (`packages/screenplay-editor`) walks `doc.forEach`, producing exactly one
`ScreenplayBlock` per top-level ProseMirror node -- the identical 1:1 mapping the test fixture
exercises. `dual_dialogue` and `page_break` block types have no ProseMirror representation this
text-block editor's schema can author at all (`editorContentFromScreenplay` refuses either feature
closed, falling the whole document back to read-only before any editor mounts), so whenever a real
`editor` exists for a selection to be drawn in, `wordsInProjection`'s own skip for those two block
types is unreachable -- not a discrepancy waiting to happen, dead code kept only because the
read-only revision comparison's own `projectDocumentScreenplay` call does reach it.

## Selection-aware behaviour, Docs-style

With a selection active, Words and Characters report the selection's count against the document's,
the way Docs renders "Words: 12 of 345." With no selection, each reports the document's count alone.
`App.tsx` computes this fresh on every render:

```ts
const wordCountSelection =
  editor && hasSelection
    ? countWordsAndCharactersInRange(
        editor.state.doc,
        editor.state.selection.from,
        editor.state.selection.to,
      )
    : undefined;
```

`hasSelection` is the identical boolean slice 1's Cut/Copy already gate on (`editor.state.selection
.empty`, read from the ProseMirror model). Reading it live rather than snapshotting it at the moment
the dialog opens is safe, not merely convenient: `.dialog-overlay` is a fixed, full-viewport overlay
with no `pointer-events: none`, so it blocks every click to the canvas underneath for as long as the
dialog is open -- the selection genuinely cannot change while it is up, the same property that lets
`DocumentSettingsDialog`'s own fields read live state with no snapshot-and-refresh dance either.

`WordCountDialog` (`wordCountDialog.tsx`) takes each stat as `{ documentTotal, selection }`, where
`selection: number | undefined` -- `undefined` only when there is no selection to report, never
because a real, present selection's own count happens to be `0`. That distinction is deliberately
not collapsed into a falsy check: a non-empty selection that covers only whitespace is a real
selection with a genuine `0`-word count, and must render "0 of N," not silently fall back to the
no-selection rendering. Pinned directly: `wordCountDialog.test.tsx`'s "reports a selection's own
zero distinctly from 'no selection' when the stat says so" constructs exactly that case and a
mutation (`stat.selection === undefined` weakened to `!stat.selection`) kills it (see Mutation
testing below).

Word count never mutates the document, so -- unlike "Document settings…" and "Save named
revision…" -- the menu item carries **no `editingAllowed` gate**. A reviewer on a read-only
entitlement may count words exactly as they may still copy text; `App.tsx`'s own comment at the item
states this explicitly, and `App.test.tsx`'s "stays enabled while editing is not allowed" proves it
the same way slice 1's "lets a reviewer copy but not cut" proves Copy's identical exemption.

## The Tools menu itself: the prop seam, and the comparison-view decision

`toolsMenuItems`/`toolsMenuRef` were added to `ApplicationMenubarProps` the identical shape slice 1
gave Edit/View/Format: an optional, caller-built `readonly OverflowMenuItem[] | undefined`, gated by
the existing `hasItems()` guard (untouched), and a `Ref<HTMLDivElement>` attached to the
`.menu-tools` wrapper so `App.tsx` can return focus to the Tools trigger after the dialog closes --
the same purpose `fileMenuRef` already serves for File's own dialogs. `INERT_MENU_LABELS` shrank from
`['Tools', 'Help']` to `['Help']`: Tools is no longer a label in any of its own rendering paths, real
or absent, exactly as Edit/View/Format already were not after slice 1.

**Decided by the brief, not re-litigated here:** Tools is omitted entirely on the read-only revision
comparison (`routes/projects/$projectId.screenplays.$screenplayId.revisions.$revisionId.diff.tsx`),
which renders the same `ApplicationMenubar` but never passes `toolsMenuItems` at all. Because the
label was removed from `INERT_MENU_LABELS` rather than kept with a runtime "is it supplied"
check, "not passed" and "cut entirely" are the same code path `hasItems()` already gives Edit and
Format -- no new mechanism, no second place this decision could drift from Edit/Format's own. The
reasoning matches slice 1's own for Edit and Format, for a related but distinct reason stated in
that route's comment: a comparison is a read-only reading view of **two** stored snapshots, so "the
word count" has no single referent -- counting one side silently would be worse than not offering
it at all, and there is no "disabled, because..." sentence to attach to the one item the way File's
six disabled items each carry their own. Proven in `applicationMenubar.test.tsx`'s "renders exactly
File and View, with Edit, Format and Tools absent," the diff route's own "omits Edit, Format and
Tools entirely," and the real-browser chrome enumeration in `screenplay-diff-persistence.spec.ts`
(see "A real regression this slice's own tests caught" below).

## Both themes verified, and a wrong conclusion drawn from it

The dialog was verified in both themes with a real-browser measurement
(`word-count-dialog-dark-contrast.spec.ts`), wrapping the markup in `.dark` the way the editor shell
does. The heading and both stat columns are correct: they paint directly onto `.dialog`'s surface,
which is one of the surfaces that deliberately stays white in both themes, and they read identically
in each.

**The conclusion drawn about the Close button was wrong, and it shipped a regression into this
branch that the lead caught in review.** Recorded here in full because the reasoning error is more
useful than the fix.

The spec asserted the light-island property of `.dialog-actions button` -- that its text must read
the same in both themes, like everything else on the white dialog. It does not, and must not:

```css
.dialog {
  background: var(--surface-01);
} /* white in BOTH themes */
.dialog-actions button {
  background: var(--surface-03);
  color: inherit;
}
```

`--surface-03` **is** one of the tokens `.dark` redefines (to `#34424b`). So the button's own
background genuinely goes dark while the dialog behind it stays white, and `color: inherit` --
following the theme to a near-white -- is the correct behaviour, not a defect. `styles.css` already
documents this exact distinction for `--text-04` and `.primary-button:disabled`: a control whose
background follows the theme must have text that follows the theme too.

The measurement that produced the wrong conclusion compared the button's text against **the
dialog's** background (`rgb(255, 255, 255)`) rather than against **the button's own**
(`rgb(52, 66, 75)`). Measured properly, in the dark theme:

|                              | text                 | on its own background | ratio      |
| ---------------------------- | -------------------- | --------------------- | ---------- |
| before the "fix" (correct)   | `rgb(227, 232, 235)` | `rgb(52, 66, 75)`     | **8.4:1**  |
| after the "fix" (regression) | `rgb(32, 37, 43)`    | `rgb(52, 66, 75)`     | **1.49:1** |

`color: var(--text-19)` on `.dialog` has been reverted. It affected all eight dialogs that use
`.dialog-actions` (sharing, restore-revision, named-revision, upgrade, the two FDX dialogs,
document settings, rename), so the regression was app-wide rather than local to this slice.

### Why nothing caught it, and what now does

`text-contrast.spec.ts` measures each target against its own resolved background in both themes --
it is precisely the suite that should have caught this -- and it passed, because its only dialog
button case is `.primary-button:disabled`, which sets its own explicit `--text-04` and is therefore
immune to any ancestor's `color`. The **enabled** button, the one that inherits, had no case.

It has one now: `.dialog-actions button (enabled -- its own background follows the theme)`,
`themes: BOTH`, minimum `REAL_TEXT` (4.5). Re-applying the reverted declaration fails it at
`#20252b on #34424b`, `1.489:1`, in the dark theme only -- the light run still passes, which is
correct, since the forced colour is harmless there.

The lesson generalises past this one rule: "this surface stays white in both themes" is a property of
**a surface**, not of everything inside it. A descendant that paints its own themed background is a
separate surface and gets its own answer. Asserting the parent's property on such a child does not
merely fail to catch a bug, it actively demands one.

## A real regression this slice's own tests caught: the persistence suite's chrome enumeration

`screenplay-diff-persistence.spec.ts` (`test:system:persistence`) carries a real-browser enumeration
of the editor's and the comparison's own menubar children, asserted literally -- slice 1's own
progress doc names this test as the one that proves the comparison's Edit/Format omission against a
real database, not only against jsdom. Running the full persistence suite against this slice's
changes failed exactly this test: the editor frame's "Tools" child was still asserted as
`{ className: 'menubar-inert', tag: 'SPAN' }`, when it is now genuinely
`{ className: 'menubar-menu menu-tools', tag: 'DIV' }`, and the comparison frame's own expected list
still included an inert "Tools" span that the comparison no longer renders at all. Updated both
expected arrays (editor: Tools now a real `DIV` menu, in order after Format; comparison: Tools
dropped from the list entirely) and added `'Tools menu'` to the editor frame's own
`menubarControls` name list. Re-run against a fresh disposable database afterward: both of this
spec's tests pass (see Gate results).

This is exactly the kind of drift a real-browser, real-database suite exists to catch that neither
`applicationMenubar.test.tsx` nor `App.test.tsx` could: both of those render through jsdom against
the components this slice edited directly, so neither one was ever at risk of asserting something
about a _different_ copy of the same markup going stale. The persistence spec's copy of "what
should be in the menubar" is independent, hand-maintained prose, and it was simply not updated as
part of writing the feature -- caught by running the gate, not by inspection.

## Mutation testing

Every guard below was broken, confirmed to fail the specific test(s) that should catch it, then
restored. `git diff --stat` against the pre-mutation tree was re-confirmed empty after each revert.

| #   | Mutation                                                                                                                  | Result                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | `countWordsAndCharactersInRange`'s word-count `textBetween` separator changed from `'\n'` to `''` (no block separator)    | Killed exactly `wordCount.test.ts`'s whole-document invariant test (`expected 22 to be 23` -- two adjacent blocks' words merged into one token across the boundary).                       |
| M2  | `wordCountDialog.tsx`'s `formatStat` changed `stat.selection === undefined` to `!stat.selection`                          | Killed `wordCountDialog.test.tsx`'s "reports a selection's own zero distinctly from 'no selection'" (the `0`-selection case fell back to the document-total-alone rendering).              |
| M3  | `applicationMenubar.tsx`'s `hasItems(toolsMenuItems)` guard replaced with an unconditional render, `toolsMenuItems ?? []` | Killed the 3 "Tools … absent" assertions across `applicationMenubar.test.tsx` and the diff route's own test file (a `Tools menu` button appeared where none should).                       |
| M4  | `App.tsx`'s Word count item given `disabled: !editingAllowed, disabledReason: readOnlyMenuReason`                         | Killed `App.test.tsx`'s "stays enabled while editing is not allowed" (the item became disabled under the read-only fixture).                                                               |
| M5  | `App.tsx`'s `wordCountSelection` guard weakened from `editor && hasSelection` to `editor` alone                           | Killed 2 tests: "reports the document's own … with no selection framing" and "never disagrees with the status bar's own word count" (both began reporting "0 of N" with nothing selected). |
| M6  | `.dialog`'s `color: var(--text-19)` removed                                                                               | Killed `word-count-dialog-dark-contrast.spec.ts`'s `closeButton` light/dark equality (see "Both themes verified" above for the exact measured values).                                     |

Not separately mutation-tested: `OverflowMenu.tsx` itself (untouched, per the brief) and
`hasItems()`'s own general mechanism, both already covered by slice 1's own mutation table and
39-test `OverflowMenu.test.tsx` suite, neither of which this slice's Tools-specific wiring could
plausibly re-break without M3 above also catching it.

## Test-file updates, beyond the new tests

- **`apps/web/src/wordCount.ts`** (new) -- `countWords`, `wordsInProjection` (moved verbatim from
  `App.tsx`), `charactersInProjection`, `countWordsAndCharactersInRange`.
- **`apps/web/src/wordCount.test.ts`** (new) -- 11 tests: the tokenizer's own whitespace rules, both
  projection-level counters (including the `page_break`/`dual_dialogue` skip), the range counter on
  a partial single-block range, and the whole-document invariant described above.
- **`apps/web/src/wordCountDialog.tsx`** (new) -- the dialog component, following
  `DocumentSettingsDialog`'s own hand-built modal shell exactly (focus trap, Escape, `role="dialog"`).
- **`apps/web/src/wordCountDialog.test.tsx`** (new) -- 7 tests: no-selection rendering, selection "N
  of M" framing (for both stats, independently), the zero-selection-vs-no-selection distinction
  above, Escape/Close, initial focus, Tab/Shift+Tab wrapping (needed to clear the 80% coverage
  floor -- see Gate results), and "ignores a key other than Escape/Tab."
- **`apps/web/src/applicationMenubar.tsx`** -- `toolsMenuItems`/`toolsMenuRef` props, `hasItems()`
  gate reused unchanged, `INERT_MENU_LABELS` reduced to `['Help']`, doc comments updated throughout.
- **`apps/web/src/applicationMenubar.test.tsx`** -- `INERT_MENU_LABELS` reduced to match; new tests
  for Tools mirroring Edit/View/Format's own four ("renders … and fires," "does not render … when
  omitted," "does not render … when `[]`," "attaches the caller's ref"); the comparison-combination
  test extended to assert Tools absent alongside Edit and Format.
- **`apps/web/src/App.tsx`** -- `wordsInProjection`'s local definition removed in favour of the
  import; `characterCount`/`wordCountSelection` computed; `toolsMenuRef`/`wordCountDialogOpen` state;
  `toolsMenuItems`/`toolsMenuRef` passed to `ApplicationMenubar`; `WordCountDialog` rendered in
  `outOfFlow`; `closeWordCountDialog` mirroring `closeSettingsDialog`.
- **`apps/web/src/App.test.tsx`** -- new `describe('Tools menu: Word count', …)` block, 6 tests:
  the menu's one item, document-total rendering (words/characters/pages, with pages awaited past
  the pagination plugin's own async settle, the same property the pre-existing page-stack-height
  test already accounts for), status-bar agreement, selection "N of M" via "Select all" (the same
  realistic selection-reaching technique slice 1's own Cut/Copy tests use), Escape/focus-return, and
  the no-`editingAllowed`-gate proof under the entitlement-read-only fixture.
- **`apps/web/src/routes/.../$revisionId.diff.tsx`** and its test file -- comments and the "omits
  Edit and Format" test extended to "omits Edit, Format and Tools," asserting the Tools trigger is
  also absent on that route.
- **`apps/web/e2e/menubar-menus-position.spec.ts`** -- the hand-copied menubar markup updated to
  render Tools as a real `.menubar-menu.menu-tools` trigger (it was still the old inert `<span>`
  copy), and the flush-trigger-geometry test extended to assert Tools matches File's own
  border-radius/font-weight/height, the same property already proven for Edit/View/Format.
- **`apps/web/e2e/word-count-dialog-dark-contrast.spec.ts`** (new) -- see "Both themes verified."
- **`apps/web/e2e/screenplay-diff-persistence.spec.ts`** -- see "A real regression this slice's own
  tests caught."

## Gate results

All from the worktree root, after `pnpm install --frozen-lockfile`.

1. **`pnpm lint`** (`eslint . --max-warnings=0`) -- clean, exit 0.
2. **`pnpm typecheck`** (every package, both apps, `astro check` for `apps/landing`) -- clean, exit 0.
3. **`pnpm test`** -- exit 0. `apps/web` 1141 tests / 74 files; `apps/api` 317 passed + 101 skipped
   (integration, no database in this run) / 22 files; `apps/collab` 169 passed + 32 skipped / 14
   files; every `packages/*` suite green (`packages/screenplay` 172, `packages/screenplay-editor`
   143, `packages/layout` 72, `packages/pdf` 61, `packages/fdx` 127, `packages/docx` 58, among
   others) -- none touched by this slice.
4. **`pnpm test:coverage`** -- exit 0, every per-file threshold (80% lines/functions/branches/
   statements) met, across every package. `wordCount.ts`: 94.44/93.75/100/94.44 (the two uncovered
   lines are inside `charactersInProjection`'s `page_break`/`dual_dialogue` skip branch, unreachable
   from any editor-backed selection for the reason stated above, and already covered at the
   `wordsInProjection` sibling by the dedicated skip test). `wordCountDialog.tsx`: first run
   74.68/66.66/75/74.68 (below threshold) -- the Tab/Shift+Tab focus-trap branches had no test;
   added the wrap-to-self test and a stray-key test, re-ran: full file green against the 80% floor.
5. **`pnpm build`** -- clean (web, api, collab, landing, every package).
6. **`pnpm check:bundle-budget`** -- entry chunk 112.20 / 120.00 kB, lazy editor chunk
   167.66 / 200.00 kB (6 chunks), CSS 8.32 / 20.00 kB. All within budget with headroom.
7. **`pnpm test:system`** -- **100 passed**, including the 2 new
   `word-count-dialog-dark-contrast.spec.ts`/updated `menubar-menus-position.spec.ts` assertions and
   the full existing `text-contrast.spec.ts` suite (36 tests, re-verified unaffected by the `.dialog`
   CSS fix).
8. **`pnpm test:integration`** -- exit 0 against the disposable Postgres below: `packages/database`
   11/11, `apps/api` 101/101 (7 files), `apps/collab` 32/32 (3 files). None of this slice's own code
   is exercised by this tier (no server-side change); run anyway, per the gate list, to confirm the
   worktree as a whole is still sound.
9. **`pnpm test:system:persistence`** -- run twice against the disposable Postgres below, per the
   owner's own standing note that this suite is flaky on `main` already:
   - **Run 1: 34/37.** Three failures. `screenplay-diff-persistence.spec.ts:82`
     ("the diff view renders a real difference…") -- the exact known flake named in the brief
     (duplicated characters, `"Added after the milestone.tone."`). `screenplay-diff-persistence
.spec.ts:642` ("the inline diff reads as the document with changes marked in place…") -- **a
     real regression**, not a flake: this is the chrome-enumeration test described above, failing
     because its own hand-maintained menubar snapshot had not yet been updated for Tools becoming a
     real menu. Fixed (see above) and re-run in isolation against a fresh disposable database:
     both of this spec's tests pass, 2/2. `page-rendering-persistence.spec.ts:739` ("a page frame
     stays put when an edit changes a short page's fill without moving a block") -- not one of the
     two flakes named in the brief, and nothing this slice touched: no pagination, spacer, or `.page`
     code changed anywhere in this branch's diff. The failure (`expect(afterSplit.spacerHeightPx)
.not.toBe(baseline.spacerHeightPx)` -- the spacer's recompute apparently did not register
     before the assertion read it) is a timing shape, not a content one.
   - **Run 2 (full suite, after the chrome-enumeration fix): 37/37, clean.** Including
     `page-rendering-persistence.spec.ts:739` and both `screenplay-diff-persistence.spec.ts` tests.
     `page-rendering-persistence.spec.ts:739`'s run-1 failure did not reproduce, consistent with an
     ordinary timing flake rather than something this slice's (pagination-free) diff could cause;
     measuring its rate against the base commit was not additionally done (no second worktree was
     built against `3b92e55` for this), so this is reported as "did not reproduce on an immediate
     re-run," not as "confirmed pre-existing on the base commit" -- the distinction the brief asks to
     be stated plainly rather than blurred.

### Postgres

```
docker run -d --name wordcount-test-pg -e POSTGRES_PASSWORD=postgres -p 55457:5432 postgres:16
```

Removed with `docker rm -f wordcount-test-pg` once the gates above finished.

## Known limitations / things not done

- **`page-rendering-persistence.spec.ts:739`'s run-1 failure was not traced to a root cause**, only
  to "did not reproduce on a clean re-run." It touches no code this slice changed, so it is reported
  rather than silently dismissed, per the instruction to say plainly what was and was not verified.
- **Firefox and Safari were not driven directly** for the dark-theme dialog fix or anything else in
  this slice -- only Chromium is installed in this sandbox, matching slice 1's own stated limitation.
- **Arrow-key traversal between menubar menus remains out of scope**, per the brief: Tab still
  reaches File/Edit/View/Format/Tools independently; Left/Right does not move between them.
- **No "currently active" indication on the Word count item** -- it is a plain action item, not a
  toggle, so this does not apply the way it did to slice 1's View-menu toggles; noted only for
  completeness.

## Lead verification, re-run independently

The gate table above is the implementing agent's own run. These are the lead's, after reverting the
`.dialog` colour regression, correcting the Close-button assertion, and adding the enabled-button
contrast case:

| Gate                             | Result                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| `pnpm lint`                      | exit 0                                                          |
| `pnpm typecheck`                 | exit 0, 0 errors                                                |
| `pnpm test`                      | exit 0 -- `apps/web` **1143 tests / 74 files**                  |
| `pnpm test:system`               | exit 0, **102 passed** (100 plus the two new contrast cases)    |
| `pnpm test:system text-contrast` | exit 0, **38 passed** (36 plus light and dark for the new case) |
| `pnpm format:check`              | exit 0, run bare and last                                       |

One added mutation, beyond the agent's six:

| Mutation                                      | Test it had to kill                                             | Result                                                                       |
| --------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Re-apply `color: var(--text-19)` on `.dialog` | `text-contrast.spec.ts` dark `.dialog-actions button (enabled)` | failed: `#20252b on #34424b`, `1.489:1`, floor 4.5 -- light run still passed |

The mutation asserted an exact match count of 1, scoped to the `.dialog` block, because
`var(--text-19)` appears elsewhere in the file.

**Two full-suite timeouts, not reproduced:** running the three contrast specs together under a
filter, `menubar-menu-dark-contrast.spec.ts` and `text-contrast.spec.ts`'s `.ruler` light case both
hit the 30s limit. Neither is an assertion failure, both pass at `--workers=1`, and the full
`test:system` run of 102 is clean. Same contention signature as `app-bar-logo.spec.ts` in slice 1.
Worth noting as a pattern: three separate specs have now timed out under parallel load without any
of them failing an assertion, which suggests the worker count rather than any one spec.

## The tokenizer rule, revised after the owner checked it against Word

The owner selected the whole document, pasted it into a word processor, and got **2790 words where
this app reported 2781**. He also saw a 6-character difference in the other direction. That prompted
a real investigation, and the conclusion is worth recording because most of it was not what either
of us first guessed.

### Nothing extra is copied

`copySelectionText` is `doc.textBetween(from, to, '\n')` -- the clipboard receives exactly the
document's text, with no scene numbers, page numbers or element labels synthesised into it. The title
page is not part of the editor's document at all (it lives in `titlePageState`), so Select all does
not reach it. The clipboard and the counter therefore see the same text, which is why the two
numbers were able to differ in _opposite_ directions: it was never about content, only about rules.

### Where the 9 words actually were

The first hypothesis -- em dashes, which word processors break on and this tokenizer did not -- was
**wrong for this document**, which contains zero em dashes and zero double hyphens. Parsing the FDX
and reproducing the count exactly (2781, from the 120 body paragraphs) put the gap here:

- **3 standalone hyphens**, each counted as a word. These are the `-` in `INT. PLACE - TIME` scene
  headings, so this is not incidental: essentially every scene heading in every screenplay has one.
- **6 from four pasted configuration strings** -- URLs and `.env` lines -- which this tokenizer keeps
  whole and Word splits on `/` and `:`.

Only the first is a defect. The second is an artifact of a test document built from lorem ipsum plus
pasted configuration, and chasing it would mean tuning a screenplay word counter against a `.env`
file.

### The rule, and why it is narrower than first built

Shipped: dash _runs_ (`--`, em dash, en dash) separate two words; a token that is nothing but dashes
is not a word; a **single** hyphen between word characters still joins (`Spider-Man`,
`mother-in-law`, `same-origin`).

The owner's instinct was to break on every dash, reasoning that the two-thoughts use is more common
than the joining one. That is true of the _category_ and false of the single hyphen, and his own
script is the evidence: 1 intra-word hyphen, 0 em dashes, 0 double hyphens. Breaking every dash
would also push this count _above_ Word's rather than nearer it, since Word treats a single hyphen
as a joiner too. Narrowed on that evidence, with his agreement.

A broader exclusion -- any token containing no letter or digit -- was built first and then **backed
out**. Measured on the same script it removed 22 tokens where the dash rule removes 3; the extra 19
were `#` markers and divider lines from the pasted configuration. Word counts those as words, so the
broad rule moved the total away from Word (a gap of 31 against 12) on the strength of content no
screenplay contains, and it went further than the owner had agreed to. It remains a coherent option
if a lone `...` standing as a beat of dialogue should ever stop counting, but that is a judgement
about prose rather than punctuation hygiene and was not decided here.

Measured on the owner's script: **2781 before, 2778 after.**

### Mutations

| Mutation                              | Test it had to kill                                                             | Result                        |
| ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| Drop the `DASH_ONLY_TOKEN` filter     | `countWords` standalone-dash case, plus both `wordsInProjection` fixture totals | 3 failed                      |
| Stop replacing dash runs with a space | `countWords` em/en/double-hyphen case                                           | failed, expected 5 received 4 |

Both asserted an exact match count of 1 before applying.

### Two findings handed back rather than fixed here

- **The test screenplay contains credentials.** Four pasted `.env` lines, including a
  `BETTER_AUTH_SECRET` value and a database password. It had also been pasted into Google Docs to
  obtain the comparison count. Reported to the owner for rotation; no copy of that content was kept.
- **Five U+FFFD replacement characters** sit in the body text, meaning something did not survive an
  encoding boundary somewhere in the FDX path. Unrelated to word counting, not investigated here,
  and worth its own look.

### Gates after this change

| Gate                | Result                                         |
| ------------------- | ---------------------------------------------- |
| `pnpm lint`         | exit 0                                         |
| `pnpm typecheck`    | exit 0, 0 errors                               |
| `pnpm test`         | exit 0 -- `apps/web` **1147 tests / 74 files** |
| `pnpm test:system`  | exit 0, **102 passed**                         |
| `pnpm format:check` | exit 0, bare and last                          |

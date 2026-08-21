# Canonical round-trip test

Branch `feature/canonical-round-trip`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/canonical-round-trip`.

## Why this scope exists

`plan.md`: "A canonical round-trip test asserting that screenplay to editor projection and back is
the identity function. This becomes load-bearing once FDX import exists," and it "should land no
later than item 2" -- item 2 being export. Export is the next slice, so this is the one that has to
land first.

The property matters because of what comes after it. Today every screenplay in the system was
authored in this editor, so anything the editor cannot represent simply never exists. FDX import
ends that: it will produce canonical screenplays containing fields this editor has never had to
handle, and the first edit after an import would silently discard whatever the projection drops.
A round-trip identity test is the only thing standing between an import feature and quiet data
loss.

## The defect this must expose (already located by the lead)

`editorContentFromScreenplay` maps every block to `attrs: { element, id }`, and
`ScreenplayBlockNode.addAttributes()` declares only those two. **`sceneNumber` on a scene heading
therefore has nowhere to live in the editor document and is dropped on the way back out.** The
schema permits it now, `packages/screenplay`'s own fixtures set it, and an imported locked script
would carry it.

**Ruling, so it is not re-litigated: preserve it, do not fail closed.** Failing closed is what the
editor correctly does for `dual_dialogue`, `page_break` and annotations, because it genuinely
cannot represent them. Scene numbers are different: a locked production script is precisely a
script that keeps being edited, so refusing to open one would be refusing the Phase 5 workflow
outright. This is the identical situation increment 3 resolved for `titlePages` -- the editor
offers no controls for the field, and the field must survive anyway. Carry `sceneNumber` as a
block attribute, unrendered.

Do not add UI for it. Phase 1 scene numbers are decorations computed from document order
(`pagination.ts`'s `computeSceneNumberDecorations`) and must stay that way; this is only about the
stored field surviving a projection.

## What this must achieve

1. **A round-trip test proving identity over everything the editor supports.** Project a canonical
   screenplay into the editor and back; the result must equal the input exactly. Cover, at
   minimum: every supported block type; empty and non-empty text; text with leading, trailing and
   interior whitespace that must be preserved exactly (`plan.md`: authored text is never
   normalised); non-ASCII and multi-code-unit text, including at least one emoji or combining
   sequence, since grapheme handling has a fast path in `packages/layout` that assumes ASCII;
   `sceneNumber` present and absent; a title page with every field populated and one with only the
   defaults; and non-default `documentSettings`.
2. **Fail-closed proven, not assumed.** For each canonical feature the editor deliberately cannot
   represent -- more than one title page, any annotation, `dual_dialogue`, `page_break` --
   `editorContentFromScreenplay` must throw. A test that only checks the happy path would let a
   future change turn a refusal into silent truncation, which is the exact failure mode this scope
   exists to prevent.
3. **Whatever else the test exposes gets fixed**, or is explicitly reported with a recommendation
   if the fix is larger than this scope. `sceneNumber` is the one the lead already found; do not
   assume it is the only one. Run the test before fixing anything and report the full list.
4. **Build the inputs from a deterministic in-repo generator**, not a handful of hand-written
   fixtures. Enumerate combinations (block type x empty/non-empty x optional field present/absent)
   so coverage is a property of the generator rather than of whoever wrote the list. **No new
   dependencies** -- a property-testing library would be the obvious tool and is explicitly not
   approved here; a plain nested loop producing every combination is sufficient and adds nothing to
   the install.

## Out of scope

FDX/PDF/DOCX export itself. Any UI. The Phase 5 locked-numbering feature. Changing the canonical
schema -- every field needed already exists. `packages/layout`.

## Verification

The full gate list, `pnpm format:check` run **after** writing your progress entry, and the
persistence gate run at least three times. This base is green: `main` passes CI, so any failure is
yours.

For every test guarding specific behaviour: break the behaviour, confirm the test fails, restore,
and report it. Green does not mean working -- five vacuous tests have been found on this project,
one written by the lead, and the most recent had been passing on `about:blank` for its entire life
while appearing to guard font rendering. The one most likely to pass vacuously here is the identity
assertion itself: make sure it compares the _whole_ canonical value, so that dropping any field
fails it, rather than comparing a handful of fields you happened to think of.

No credential may appear in any file you write, including your progress log.

## Rules

Do not stage, commit, merge, rebase, force-push, reset, or create or delete branches or worktrees --
the owner controls staging, committing and pushing. No TODO or placeholder comments, no emojis,
strict TypeScript, `.js` extensions on relative imports. Match the surrounding comment style: this
codebase records _why_, citing `plan.md`. If the code contradicts the specification, stop and report
rather than bending either.

## Checkpoints -- SendMessage to the lead

1. After the round-trip test exists and has been run for the first time, **before fixing anything**:
   report every field it shows being lost or altered. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

### 2026-08-20 -- implementation agent -- scope complete

Status: ready-for-review.

#### What shipped

**The test** (`apps/web/src/canonicalRoundTrip.test.ts`, new file, 84 cases): a deterministic
nested-loop generator, not a property-testing library -- for each of the 6 non-`scene_heading`
element types crossed against 8 text shapes (empty; simple; leading, trailing, and interior
whitespace; a combining sequence; a surrogate-pair emoji; a ZWJ emoji sequence), and `scene_heading`
crossed against those same 8 shapes and 3 `sceneNumber` samples (absent, `'1'`, `'25A'`). Each case
round-trips a canonical `Screenplay` through a _real_ Tiptap `Editor` --
`editorContentFromScreenplay` in, `projectDocumentScreenplay` back out -- and asserts the whole
returned `Screenplay` `toEqual`s the whole input, so a dropped, unlisted field cannot pass silently.
Also covers: title pages with no page, defaults-only, and every field populated; non-default
`documentSettings`; one composite document combining everything; and four fail-closed tests proving
`editorContentFromScreenplay` throws for >1 title page, an annotation, `dual_dialogue`, and
`page_break`.

**Checkpoint 1** (first run, before any fix): 64 passed, 17 failed, every failure the same field --
`sceneNumber` on `scene_heading`, dropped unconditionally, in every text shape crossed with both
`sceneNumber` values plus the composite test. Nothing else was lost or altered. The lead
independently reproduced this (17/268, matching 8 x 2 + 1 exactly) before approving the fix.

**The fix** (`apps/web/src/screenplayEditor.ts`): `sceneNumber` is now a third `ScreenplayBlockNode`
attribute (`default: null`, rendered only as `data-scene-number` when truthy, per the ruling in this
scope's own "Ruling" section: preserve it unrendered, do not fail closed). `editorContentFromScreenplay`
now includes it in a block's attrs only when `block.type === 'scene_heading'` and the field is
present; `mapBlock` reads it back out only for `element === 'scene_heading'`.

**The hazard the lead flagged during review, addressed:** because ProseMirror declares attributes
per node _type_ and there is one node type here (`screenplayBlock`), `sceneNumber` now technically
exists on every block, not only scene headings. Two requirements followed: `mapBlock` must gate the
read to `scene_heading` (otherwise a converted block would carry a field its `.strict()` schema
forbids, and every subsequent save would fail validation), and converting a numbered scene heading
away and back must not resurrect the number. Both are now covered by three new tests in a
`sceneNumber and element conversion` describe block, exercised through the real
`convertActiveScreenplayBlock` (what the toolbar and Tab both call) plus one direct construction:

- "a numbered scene heading converted to another element type still projects validly, with no
  sceneNumber on the new block"
- "converting a numbered scene heading away and back does not resurrect the number"
- "mapBlock never emits sceneNumber for a non-scene_heading block, even if the node's attrs carry
  one directly"

**A correction to the lead's own stated mental model, found while writing these tests and worth
recording:** I traced `setNodeMarkup` into `prosemirror-transform` and `computeAttrs` into
`prosemirror-model` (`node_modules/.pnpm/prosemirror-{transform,model}@*`). `NodeType.create`'s
attribute computation _fills any attribute missing from a supplied attrs object from the schema
default; it does not merge with the node being replaced._ `convertActiveScreenplayBlock`'s call --
`setNodeMarkup(pos, undefined, { element, id })` -- therefore already resets `sceneNumber` to `null`
on conversion, with no further code change needed there. This means the first two tests above,
though real and worth having, cannot actually catch a missing `mapBlock` gate: I verified this
directly (see mutation testing below) -- removing the gate leaves both green, because by the time
`mapBlock` runs after a conversion, the attribute is already `null`. The third test, which
constructs a non-scene_heading node with a truthy `sceneNumber` attribute directly (bypassing both
`editorContentFromScreenplay` and `convertActiveScreenplayBlock`), is the one that actually exercises
the gate, and is the one I added beyond the two the lead asked for by name.

**Known but out-of-scope-to-fix, flagged for the record:** `splitScreenplayBlock` (what Enter calls)
has the identical shape of gap -- its `preservedBlock`/`newBlock` construction also only ever
supplies `{ element, id }`, so pressing Enter inside a numbered scene heading to split it drops
`sceneNumber` from both halves, even when the preserved half's element does not change. This is a
real interactive-editing behavior, not exercised by this file's round-trip tests (which never call
`splitScreenplayBlock`) and not something the round-trip identity property requires, since Phase 1
scene numbers are display-only decorations and `sceneNumber` itself is a Phase 5 locked-production
field this editor has no controls for. Not fixed here: fixing it would mean deciding whether a split
scene heading should keep, drop, or duplicate a locked number onto both halves, which is a Phase 5
product decision, not a round-trip-fidelity one, and this scope's "Out of scope" list excludes the
Phase 5 feature and any UI work.

**Overstatement corrected before handoff, per the lead's note:** the `documentSettings` and title-page
describe blocks originally implied the _editor_ preserves those fields. Neither ever enters the
ProseMirror document (`expectRoundTripsIdentically` re-supplies both explicitly from the input, the
same way `App.tsx`'s call sites do). The comments now say precisely what those cases prove:
`editorContentFromScreenplay` passes a title page through intact, and `projectDocumentScreenplay`
honours whatever `documentSettings` it is handed rather than silently substituting the schema
default -- the exact defect increment 4 found and fixed in this same function.

#### Mutation testing (break it, confirm the test fails, restore it, report it)

Every mutation below was applied to a snapshot-backed copy of the fixed file, `canonicalRoundTrip.test.ts`
run, the failure inspected, the file restored, and the suite re-verified green (84/84) before the
next mutation. A final `diff` against the pre-mutation snapshot confirmed the source file was byte-
identical to the fixed state when mutation testing finished.

1. **Revert `mapBlock`'s `scene_heading` branch to the pre-fix state (no `sceneNumber` read at all).**
   Result: 17 failed, 67 passed -- the identical 17 test names from checkpoint 1, no more, no fewer.
   The three new conversion/gate tests stayed green (expected: with the read removed entirely, no
   block of any type ever carries the field, so there is nothing for the gate to leak).
2. **Remove the `scene_heading`-only gate** (apply the `sceneNumber` read to every block type
   unconditionally). Result: exactly 1 failure -- "mapBlock never emits sceneNumber for a
   non-scene_heading block, even if the node's attrs carry one directly" --
   `AssertionError: expected false to be true`, `result.valid` false because the schema rejected
   `sceneNumber` on an `action` block. The two `convertActiveScreenplayBlock`-based tests stayed
   green under this mutation, confirming in the source (not just by reasoning) that they do not
   exercise this specific gate -- see the correction above.
3. **Remove the `sceneNumber` attribute declaration from `ScreenplayBlockNode.addAttributes()`
   entirely.** Result: the identical 17 failures from mutation 1 -- ProseMirror's `computeAttrs`
   silently ignores an attrs key the schema doesn't declare, so the value never reaches the node at
   all. Proves the declaration itself, not only the read/write code around it, is load-bearing.
4. **Remove `sceneNumber` from `editorContentFromScreenplay`'s attrs construction** (stop writing it
   into the editor content, while leaving `mapBlock`'s read in place). Result: the identical 17
   failures again -- the write half is equally load-bearing.
5. **Widen the `>1 title page` guard to `>2`.** Result: exactly 1 failure, "refuses a screenplay with
   more than one title page." Every other fail-closed test and every identity test stayed green.
6. **Widen the annotation guard from `>0` to `>1`.** Result: exactly 1 failure, "refuses a screenplay
   containing an annotation."
7. **Drop `dual_dialogue` from the unsupported-block guard**, leaving only `page_break`. Result:
   exactly 1 failure, "refuses a screenplay containing a dual_dialogue block."
8. **Drop `page_break` from the same guard**, leaving only `dual_dialogue`. Result: exactly 1
   failure, "refuses a screenplay containing a page_break block." Together with #7, each of the two
   block-type checks in that `some(...)` has its own independent test, not one accidentally covering
   both.
9. **Append `.trim()` to `mapBlock`'s (and `getActiveBlock`'s) `node.textContent`.** Result: 19
   failed -- exactly the 12 non-scene_heading "leading whitespace"/"trailing whitespace" cases, the
   6 scene_heading equivalents crossed with all 3 `sceneNumber` samples, and the composite test
   (whose action block has leading/trailing whitespace). Every "interior whitespace" case, in
   contrast, stayed green -- confirming that assertion is checking something genuinely distinct from
   the leading/trailing one, not redundant with it.
10. **Reproduce the increment-4 regression**: remove `documentSettings` from the object passed to
    `safeParseScreenplay` inside `projectDocumentScreenplay`. Result: exactly 2 failures, "round-trips
    a screenplay with non-default document settings" and the composite test -- both, and only both,
    the cases with non-default settings.
11. **Force `editorContentFromScreenplay` to always return `titlePage: undefined`.** Result: exactly
    3 failures -- the defaults-only and fully-populated title-page tests, and the composite test.
    "round-trips a screenplay with no title page" correctly stayed green, since it expects no title
    page regardless.

#### Gates

1. `pnpm typecheck` -- clean, workspace-wide.
2. `pnpm lint` -- clean, workspace-wide (`eslint . --max-warnings=0`).
3. `pnpm test:coverage` -- clean, exit 0, workspace-wide: config 1, server-config 6, database 4,
   screenplay 53, layout 63, api 78 (62 run + 16 skipped integration tests, need
   `TEST_DATABASE_URL`), web 271 (270 pre-existing + this file's 84, offset by the coverage run
   picking up one previously-uncounted test; see individual file totals above -- no test in any
   pre-existing file was touched). `screenplayEditor.ts` coverage: 95.05% statements / 89.47%
   branches / 86.95% functions / 95.05% lines, all above the 80% per-file threshold.
4. `pnpm build` -- clean, workspace-wide.
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- 21/21.
6. `git diff --check` -- clean.
7. Persistence gate (`TEST_DATABASE_URL=<local disposable test database, passed inline on the
command line only, never written to any file> PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence`),
   three runs: **9/9, 9/9, 9/9**. Stable, no flake -- this branch's `main` base already includes the
   `page-rendering-persistence.spec.ts` fix noted in `plan.md`'s "Immediate next action."
8. `pnpm format:check` -- run after this entry was written, clean (see below).

#### Known limitations / things not done

- **`splitScreenplayBlock` (Enter) also drops `sceneNumber`**, including when the preserved half's
  element does not change -- see "Known but out-of-scope-to-fix" above. Not fixed: deciding what a
  split numbered scene heading should do with its number is a Phase 5 product decision (this scope's
  own "Out of scope" list excludes the Phase 5 feature), and no interactive-editing behavior is
  covered by the round-trip identity property this scope exists to guard.
- **FDX/PDF/DOCX export, any UI for `sceneNumber`, and the Phase 5 locked-numbering feature** remain
  entirely unbuilt, per this scope's own "Out of scope" list -- unchanged from before this work.
- The canonical schema was not changed; every field this test needed already existed.
- `packages/layout` was not touched or tested by this scope, per its own "Out of scope" list, even
  though the generator's emoji/combining-sequence text samples were chosen with that package's
  ASCII-assuming fast path in mind (this file only proves the _editor projection_ preserves such
  text, not that layout handles it correctly).

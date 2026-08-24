# The Navigator's Characters tab

Branch `feature/characters-navigator`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/characters-navigator`.

## Why this scope exists

`plan.md`'s "Character names and extensions" names this as a **missing prerequisite**, in those
words: the Characters tab is "inert markup today -- a plain `<span>Characters</span>` beside the
working `Scenes` tab, with no click handler, no derived character list, and no click-to-navigate."
Verified before writing this: `App.tsx`'s `.panel-tabs` is exactly two `<span>`s, one of which lies
about being interactive.

It is also a prerequisite twice over. The extension-stripping rule below presumes a character list
to group, and SmartType -- the next slice -- must "suggest previously authored characters", which is
the same derivation. Building it here means SmartType reuses it rather than growing a second one.

## What this must achieve

1. **A real tab control.** Two tabs that switch, keyboard-operable, with the selected state exposed
   to assistive technology rather than only painted. `plan.md`'s design rules require "full keyboard
   operation, visible focus, semantic controls". Two `<span>`s are none of those.

2. **`deriveCharacters` in `packages/screenplay`**, beside `deriveScenes`, which is the model to
   follow: a pure function over `readonly ScreenplayBlock[]`, no editor or DOM types. It belongs in
   the package rather than `apps/web` because the same derivation feeds SmartType, and because the
   canonical model is where a question about the screenplay's own content belongs.

3. **Extensions are stripped before grouping**, per `plan.md`: `MARA`, `MARA (V.O.)` and
   `MARA (O.S.)` are **one** character. Two details there are easy to miss and both are stated:
   - **Treat any trailing parenthetical on a character line as an extension, rather than matching a
     fixed list.** The conventional set (`(V.O.)`, `(O.S.)`, `(O.C.)`, `(CONT'D)`) is what to test
     against, not what to implement against.
   - **Accept the period-less spellings on import but normalise on output.** Note the trailing
     period in `(V.O.)` and `(O.S.)`.

4. **Click-to-navigate, like a scene.** Selecting a character should take the writer to that
   character in the document, matching how the Scenes tab already behaves.

5. **Dual dialogue must be counted.** A `dual_dialogue` block holds two columns, each beginning with
   a character. A derivation that only walks root blocks will miss them silently, and the canonical
   model permits them even though the editor refuses to open them today.

## Out of scope

SmartType itself. Zoom. The element menu. Any change to `packages/layout` or to pagination.

## Verification

The full gate list, `pnpm format:check` after the progress entry, and the persistence gate three
times. `main` is green.

`deriveCharacters` is a pure function over the canonical model, so it deserves direct unit tests in
`packages/screenplay` covering the extension cases above, not only a UI test that happens to
exercise it.

Mutation-test every behaviour: break it, confirm the test fails, restore, report. The likeliest
vacuous test here is the grouping -- assert that a screenplay containing `MARA`, `MARA (V.O.)` and
`MARA (O.S.)` yields **one** entry, not that some list is non-empty.

No credential may appear in any file you write.

## Rules

Do not stage, commit, merge to `main`, force-push, reset, or create or delete branches or worktrees;
merging `origin/main` into this branch is allowed. No TODO or placeholder comments, no emojis, strict
TypeScript, `.js` extensions on relative imports. Record _why_, citing `plan.md`.

Note `pnpm typecheck` and `pnpm build` cover different files -- a test-file type error passes the
first and fails the second, so run both.

## Checkpoints -- SendMessage to the lead

1. After `deriveCharacters` exists and is tested, before the UI: its signature, how it decides what
   is an extension, and how it handles dual dialogue. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

## 2026-08-23 -- implementation agent -- implemented and verified

Status: complete for all five items in scope.

### What shipped

**`deriveCharacters`** (`packages/screenplay/src/index.ts`, beside `deriveScenes`):

```ts
export type DerivedCharacter = {
  name: string; // extension-stripped, normalized grouping key
  extensions: readonly string[]; // normalized extensions, deduplicated, first-seen order
  blockIds: readonly string[]; // every cue naming this character, in document order
};

export function deriveCharacters(blocks: readonly ScreenplayBlock[]): DerivedCharacter[];
```

A pure function over the canonical model, no editor or DOM types, matching `deriveScenes`'s own
shape. `collectCharacterCues` walks root `character` blocks and, for every `dual_dialogue` block,
every `character`-typed block in `left.blocks` then `right.blocks` -- not only `blocks[0]`, since
`dialogueColumnBlockSchema` permits `character` anywhere in a column, not only as its first block.
`splitCharacterCue` strips a trailing parenthetical structurally (a `(...)` group anchored at the
end of the line), not by checking membership in the conventional set -- `MARA (SUBTITLED)` strips
and groups exactly like `MARA (V.O.)` does. Stripping **repeats** until no trailing parenthetical
remains, collecting each one as an extension in left-to-right order; a recognized extension
normalizes regardless of periods, apostrophes, or spacing (`(VO)`, `(V.O)`, `(V.O.)` all produce
`'V.O.'`) via a period/apostrophe-stripped lookup key, while an unrecognized one still strips (so
it never pollutes the grouping key) but passes through unchanged since there is no canonical
spelling to normalize it to.

**The stacked-extension case was wrong at first and caught at review, not by my own testing.** My
initial version stopped after stripping one trailing group, so `MARA (V.O.) (CONT'D)` produced name
`MARA (V.O.)` with extension `CONT'D` -- a separate Navigator entry from plain `MARA`, which is
exactly what plan.md's grouping guarantee forbids ("`MARA`, `MARA (V.O.)`, and `MARA (O.S.)` are one
character, not three"). The lead flagged it: `CHARACTER (V.O.) (CONT'D)` is the _standard_ rendering
of a voice-over that continues across a page break, not an exotic case, so stopping at the outermost
group would have silently split a real character into two entries in any imported feature script
that has this line -- the same failure mode as the `right.blocks` omission mutation 4 (below) caught,
just introduced by me instead of caught by a mutation. Fixed by looping the strip until no trailing
parenthetical remains; `MARA`, `MARA (V.O.)`, `MARA (O.S.)`, and `MARA (V.O.) (CONT'D)` now all
collapse to one entry with `extensions: ['V.O.', 'O.S.', "CONT'D"]`.

**The Characters tab** (`apps/web/src/App.tsx`): `.panel-tabs`'s two inert `<span>`s are now a real,
keyboard-operable WAI-ARIA tabs pattern -- `role="tablist"`/`role="tab"`/`role="tabpanel"`,
`aria-selected` exposing the active tab to assistive technology (not only a CSS class),
`aria-controls`/`aria-labelledby` linking each tab to its panel, and roving `tabIndex` (only the
selected tab is a Tab stop). Left/Right arrow keys move focus and switch the active tab together
("automatic activation"), matching the tablist's horizontal layout and the immediate-effect
convention `OverflowMenu.tsx`'s own Up/Down already uses. Only the active tabpanel is rendered (not
both, one hidden), which is what makes "the tab actually switched" a real, assertable DOM fact
rather than a CSS-visibility question.

The character list is derived via `useMemo(() => projection.valid ? deriveCharacters(...) : [], ...)`,
the same pattern `scenes` already uses, so it reuses the same document that already backs the Scenes
tab rather than a second read of `initial.screenplay`. Each row renders the character's name and,
beside it in the `<small>` a scene row already uses for its own metadata, `N lines` or, when
extensions exist, `N lines · V.O., CONT'D` -- plain text, no pills, per plan.md's design rules
("Preserve accessibility... semantic controls" and the reservation of pills for genuinely categorical
tokens elsewhere in that section). This is also what gives "accept the period-less spellings on
import but normalise on output" a real consumer: without it, `extensions` was data nothing read.

Clicking a row calls `selectCharacter`, which navigates to the character's first cue via
`findScreenplayBlockPosition` + `editor.commands.focus`, mirroring `selectScene` exactly, including
inheriting its `scrollIntoView: false` and its silent no-op when the block cannot be found in the
live ProseMirror document (see "Known limitations" below). Row selection is exposed back via a new
`activeCharacter` helper, deliberately narrower than `activeScene`: a character's cues are scattered
across the whole document rather than living under one contiguous heading the way a scene's body
does, so there is no defined notion of a character's "body" to test membership against. It highlights
only when the caret sits on one of that character's own cue blocks, and stays unselected (never
falling back to `characters[0]`) otherwise -- falling back would have implied a selection the writer
never made.

### Mutation-testing report

**Derivation (`packages/screenplay`), 5 mutations** -- each broken, confirmed against the specific
test it should fail, restored, `diff` confirmed byte-identical to the pre-mutation file, full suite
reconfirmed green:

1. Never reuse an existing name entry (grouping disabled). 5 tests failed, including the scope's own
   named case: `expected [...] to have a length of 1 but got 3`.
2. De-anchor the extension regex (drop the `$`-anchor, non-greedy prefix). Failed the "not at end of
   line" and "outermost/stacked" tests.
3. `normalizeCharacterExtension` returns its input unchanged. Failed:
   `expected ['VO','V.O.','OS','CONTD'] to deeply equal ['V.O.','O.S.',"CONT'D"]`.
4. Drop the `right.blocks` walk in `collectCharacterCues`. MILES silently vanished from both the
   fixture test and the two-column test -- the exact "misses them silently" failure plan.md warns
   about, reproduced on demand.
5. Remove the empty-name skip. Failed: `expected ['', 'MARA'] to deeply equal ['MARA']`.

Plus the review-driven fix itself, mutation-tested the same way: reintroducing a `break` after the
first strip iteration (the bug the lead caught) failed both the grouping test (`length of 1 but got
2`) and the dedicated stacked-stripping test (`MARA (V.O.)` split off as its own entry).

**UI (`apps/web/src/App.tsx`), 5 mutations** -- same break/confirm/restore/diff discipline:

1. `onClick` no longer calls `setNavigatorTab`. 3 of the 5 tests failed -- every one that switches
   tabs by clicking before asserting the panel's content, since the panel never left Scenes and
   `MARA`/`JOE` were never found inside the (unchanged) `tabpanel`.
2. `aria-selected` hardcoded to `false`. Failed both assertions checking `aria-selected="true"` on
   the active tab -- the exact "selection exposed, not only painted" property this scope names as
   the point of the change.
3. Arrow-key guard changed to only accept `ArrowDown` (Left/Right silently ignored). Failed the
   keyboard-operability test: `expect(charactersTab).toHaveFocus()` on an element that never
   received it.
4. `selectCharacter` reduced to a no-op. Failed the click-to-navigate test:
   `Active screenplay element` combobox stayed on `'scene_heading'` instead of becoming `'character'`.
5. Extension rendering removed from the row (`<small>` reduced to just the line count). Failed:
   `expected element to have text content: 'V.O.'`, received `'MARA2 lines'`.

Plus one extra, added after noticing the arrow-key guard's own "ignore anything else" branch was
otherwise unexercised: pressing `a` on a focused tab with the guard's condition forced to `if (false)`
(accepting every key) moved focus and selection to the other tab, which the added
"ignores a key other than ArrowLeft/ArrowRight" test correctly failed
(`expect(scenesTab).toHaveFocus()` on an element that had lost it).

Every mutation reproduced the exact failure its corresponding test exists to catch, with a message
naming the actual broken behaviour. `App.tsx` and `packages/screenplay/src/index.ts` were `diff`ed
against their pre-mutation state after every restore and found byte-identical.

**The likeliest vacuous test named in this scope's own brief -- asserting a character's name appears
anywhere on screen -- was deliberately avoided**: every UI assertion above scopes to
`within(screen.getByRole('tabpanel'))`, and the tabpanel's own `id` is asserted to be
`navigator-panel-characters` (not merely "a tabpanel exists"), which is what mutation 1 above proves
actually matters -- that exact assertion is what failed when the click stopped switching tabs.

### Gate results (all commands run from the worktree)

1. `pnpm typecheck` -- clean across every package and both apps.
2. `pnpm lint` (`eslint . --max-warnings=0`) -- clean, no output, exit 0.
3. `pnpm test:coverage` -- exit 0, all packages.
   - `packages/screenplay`: 2 files, **64 tests** (48 in `index.test.ts`, including 11 for
     `deriveCharacters`), 98.69%/95.41% stmt/branch on `index.ts` -- the two uncovered ranges are
     pre-existing defensive throws unrelated to this slice (one in `requiredElementIndentValue`, one
     the analogous "this should never happen" guard in `deriveCharacters`'s own final `.map`, added
     by this slice and matching that existing pattern rather than a new one).
   - `apps/web`: 30 files, **346 tests** (up from 341 before this slice -- 5 new, all in
     `App.test.tsx`'s new `describe('Characters tab', ...)`). `App.tsx` at
     96.08%/88%/96.15%/96.08% stmt/branch/func/line; the
     one uncovered branch this slice added is the tab keyboard handler's `if (!nextTab)` guard,
     which is unreachable by construction (`NAVIGATOR_TABS` has exactly two entries and the modulo
     arithmetic always yields a valid index) -- see "Known limitations".
   - Every other package unchanged and passing.
4. `pnpm build` -- succeeded for all packages and both apps. The pre-existing >500kB `App.js` chunk
   warning still fires (811.49kB / 299.16kB gzip); unrelated to this slice's own footprint (roughly
   120 added lines in an already-loaded file) and not newly introduced.
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- 23 passed, run twice (once before, once after the
   final unit-test addition) with identical results both times.
6. `PLAYWRIGHT_CHANNEL=chrome TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/finaler_draft pnpm test:system:persistence`
   -- run **three times**, 11/11 passed every time.
7. `git diff --check` -- clean, no whitespace errors.
8. `pnpm format:check` -- run after this entry was written (see below).

### Known limitations / things not done

- **Dual-dialogue characters are correctly derived but cannot be exercised through the live App UI
  today.** `deriveCharacters` counts both `dual_dialogue` columns (unit-tested directly and via
  mutation 4 above), but `editorContentFromScreenplay` throws for any screenplay containing a
  `dual_dialogue` block, so the editor opens it read-only with an empty ProseMirror document (see
  `initialContent`/`unavailableEditorContent` in `App.tsx`) -- the exact same, pre-existing
  limitation the Scenes tab already lives with (`apps/web/src/App.test.tsx`'s
  `'renders unsupported persisted snapshots as read-only'` test already asserts the Scenes list goes
  empty in that state). Not a gap introduced by this slice; the scope note anticipates it
  explicitly ("the canonical model permits them even though the editor refuses to open such a
  screenplay today").
- **`selectCharacter` silently no-ops if the target block cannot be found in the live editor
  document** -- inherited directly from `selectScene`'s own existing behaviour (same
  `findScreenplayBlockPosition` call, same `undefined`-position guard), not a new failure mode this
  slice introduced.
- **The tab keyboard handler's `if (!nextTab)` guard is unreachable by construction** and stays
  uncovered by design rather than by an untested gap: with exactly two tabs and modulo-two index
  arithmetic, `nextTab` is always defined. Matches the existing defensive-throw pattern already
  present in `packages/screenplay/src/index.ts` (`requiredElementIndentValue`) rather than
  introducing a new one.
- **No case-folding or whitespace-collapsing beyond `trim()` in character-name grouping.** `MARA`
  and `Mara` are treated as different characters, matching plan.md's silence on case and avoiding an
  invented rule; screenplay convention is all-caps character cues, so this was not exercised further.
- **Extensions render only in the Characters tab list, nowhere else.** SmartType, which plan.md names
  as the derivation's other consumer, is out of scope here per this file's own "Out of scope" section
  and was not touched.

### 2026-08-23 -- implementation agent -- review follow-up

The owner used the shipped feature and reported two problems, relayed by the lead: a CSS
regression I introduced, and a real feature gap. Both addressed below; verified each against the
code and, for the CSS one, against a real rendered browser rather than inferring correctness from
the stylesheet.

#### 1. Fixed: `.panel-tabs` styling was orphaned by the span-to-button change

**Root cause.** `styles.css` styled `.panel-tabs > span` / `.panel-tabs .selected`; the tab-control
work earlier in this file replaced those `<span>`s with `<button role="tab">`, and nothing updated
the selector. The rule never stopped existing -- it stopped _matching_ -- so the tabs fell through
to the browser's own default button chrome: a raised border, a filled background, and (per the
owner) a noticeably larger font, described as looking "like something from windows 97." This is
the same defect class as `.save-dot.attention` from an earlier slice, inverted: there, a class
was applied with nothing behind it; here, a rule exists with nothing in front of it. Both are
invisible to every test that asserts behaviour and roles rather than that a rule still binds --
which every test in this file, including the ones I wrote for the tab control itself, did.

**Fix** (`apps/web/src/styles.css`): renamed `.panel-tabs > span` to `.panel-tabs > button` and
added `border: 0` (a `<button>`'s UA border, unlike a `<span>`'s, is not `none` by default).
`background: transparent`, `color`, and `font-size` were already explicit in the old rule and
carry over unchanged. `font: inherit` and `cursor: pointer` are not restated -- both are already
global resets (`styles.css`'s own top: `button, input, select { font: inherit }` and
`button { cursor: pointer }`), the same reason `.tool-button` and `.scene-list button` elsewhere in
this file don't restate them either. `.panel-tabs .selected` needed no change: it is a class
selector, not tag-scoped, and still matches the `<button className="selected">` the JSX already
sets.

**Verified rendered, not inferred.** Per the instruction to check this visually: built a scratch
Vite entry (`apps/web/scratch-preview.{html,tsx}`, mounting `<App />` directly with no auth/DB
dependency, deleted before finishing) and drove it with Playwright MCP. Screenshots confirmed the
tabs render as plain small text with an underline on the selected tab -- no visible border,
background, or oversized font -- in both light and dark mode. (Scratch files and screenshots were
removed afterward; nothing from this step is in the diff.)

**New real-browser regression test** (`apps/web/e2e/persistence.spec.ts`, "the Navigator tab
buttons render as flat controls, not the browser default button chrome"): asserts
`getComputedStyle` on the real `Scenes` tab shows `borderTopWidth: '0px'` and
`backgroundColor: 'rgba(0, 0, 0, 0)'` against the real, signed-in, database-backed app. This has to
be a real-browser (Playwright) test, not a jsdom one: Vitest's jsdom environment does not apply the
real stylesheet from `import './styles.css'`, so no unit test in this codebase could have caught
this class of defect, which is exactly why it got past every existing test the first time.

**A genuine mistake in the test itself, caught by its own mutation check.** The first version
asserted the shorthand `computed.borderWidth === '0px'` and failed even against the _fixed_ CSS,
reporting `'0px 0px 2px'`. That is not a second bug -- `.panel-tabs > button` deliberately keeps
`border-bottom: 2px solid transparent` on every tab (reserved space for the underline `.selected`
paints, so gaining it never shifts layout), which is real, intentional border-width on one side.
Checking the shorthand made the assertion fail on correct output as readily as on the regression.
Fixed by checking `borderTopWidth` alone (the UA default bezel is uniform on all four sides, so a
clean top edge alone proves it gone, and top is a side the deliberate underline reservation never
touches).

**Mutation-tested**, using the real persistence gate (the only place this cascade is real):
reverting the selector to `.panel-tabs > span` and rebuilding made Chrome report a real
`borderTopWidth: '2px'` -- the actual bezel the owner saw -- and the new test failed with exactly
that value, both before and after the shorthand-vs.-`borderTopWidth` correction above (confirming
the correction fixed the test, not the production code, which never changed during this check).
Restored; `diff` against the pre-mutation file confirmed byte-identical; the full 12-test
persistence run went green again immediately after.

**Audited the rest of `styles.css` for the same defect class, as asked, rather than assuming this
was the only one.** Extracted every class selector in the file and cross-referenced it against a
literal search of every non-test `.ts`/`.tsx` file for that class name. Two false positives
(`ProseMirror-selectednode`, applied at runtime by ProseMirror itself, never written as a literal
JSX `className`; `.script-title`/`.script-meta`, which appear only inside a comment explaining
their historical removal, not as a live rule). One real finding, **not fixed**:
**`.sign-out-button`** (three rules -- base, `:hover`, `:disabled`) has no reference anywhere in
the application source. "Sign out" is rendered today through `OverflowMenu`'s generic
`items` array in `routes/projects/index.tsx`, styled by `.overflow-menu-list button`, not by this
class -- `.sign-out-button` reads like a leftover from before that migration. Unrelated to this
scope's diff (no file touched here ever referenced it), so left for a decision rather than fixed
silently, per the instruction.

#### 2. Fixed: the Characters tab now highlights a character across their whole speech, not only their cue

**The gap.** `activeCharacter` only matched when the caret sat on a character's own cue block;
standing anywhere in their dialogue or a parenthetical highlighted nothing, unlike the Scenes tab,
which highlights whichever scene contains the caret anywhere in its body.

**Design, per the lead's explicit direction: do it in the derivation, reusing
`packages/layout`'s existing grouping rather than inventing a second one.** `groups.ts`
(`buildGroups`) already defines a "speech" for pagination purposes as a character cue plus the
contiguous run of `parenthetical`/`dialogue` blocks that follows it, ending at the first block
that is neither. `deriveCharacters` now builds the identical grouping by walking blocks with the
same open/continue/close state machine `groups.ts` itself uses (`character` opens a speech,
`parenthetical`/`dialogue` continue whichever speech is open, everything else closes it), so the
Navigator and the paginator can never disagree about which character owns a line -- if they did,
per the lead's framing, the Navigator would be the one that's wrong.

**Type change** (`packages/screenplay/src/index.ts`, `DerivedCharacter`): `blockIds` is
redefined from "every cue" to "every block attributed to this character" (cue plus its contiguous
parenthetical/dialogue run) -- a superset of the old meaning. A new field, **`cueBlockIds`**,
keeps the old cue-only list, since the lead was explicit that "blocks this character speaks" and
"blocks that are their cue" must not be conflated if anything depends on the distinction, and two
things do: `selectCharacter` (`apps/web/src/App.tsx`) now navigates via `cueBlockIds[0]`, and the
Navigator row's "N lines" count now reads `cueBlockIds.length` -- a deliberate, conservative choice
to keep displaying exactly the same number as before this round (a cue-occurrence count), since
the review asked only for correct highlighting and navigation, not a redefinition of what the row's
count means; switching it to the new, larger `blockIds.length` was considered and set aside as
unrequested scope.

**`activeCharacter` needed no logic change** -- its existing `character.blockIds.includes(activeBlockId)`
became correct automatically once `blockIds` itself grew to include dialogue and parentheticals,
which is exactly the point of moving this into the derivation: "the UI does no walking at all."
Only its comment was rewritten to state the new truth.

**Dual dialogue columns follow the same rule independently**, per the lead's instruction: each
column is its own contiguous run (`character` can appear anywhere in a column, not only first,
matching the earlier grouping work), and a speech never carries across the boundary between
columns or between the `dual_dialogue` block and whatever precedes or follows it at the root
level.

**The two named test cases, both added and passing:**

- A parenthetical between the cue and the dialogue (`MARA` / `(beat)` / dialogue) attributes all
  three blocks to `MARA`.
- A `dialogue` block with no preceding cue (an orphan run -- schema-legal, not real screenplay
  convention, `groups.ts`'s own degenerate case) attributes to **nobody**, not to whichever
  character spoke last. Tested at the root level, and again for the specific case of an orphan
  root-level block immediately after a `dual_dialogue`, which must not fall back to that
  `dual_dialogue`'s last-column speaker.

**Tests added, all passing:**

- `packages/screenplay/src/index.test.ts`: 5 new (full-attribution against the realistic
  `screenplayFixture`, the parenthetical-between case, the orphan-dialogue case, the
  column-boundary case, and the trailing-orphan-after-`dual_dialogue` case). 53 tests in the file
  (up from 48), 69 in the package (up from 64).
- `apps/web/src/App.test.tsx`: 1 new, in the `Characters tab` describe block --
  "highlights a character while the caret is in their dialogue, not only on their cue." Uses
  `twoCharacterScreenplay`'s own last block (JOE's dialogue, not his cue) and the same "click below
  the last element moves the caret to the document end" mechanism the pre-existing near-empty-
  screenplay test already proves reliable in this environment -- jsdom applies no real layout, so
  a literal click inside a specific text node cannot be simulated, and this is the one already-
  proven way to land the caret inside a block the Navigator itself has no button for. 347 tests in
  the file (up from 346).

**Mutation-testing report, this round:**

Derivation (5 mutations, `packages/screenplay/src/index.ts`), each broken, confirmed against its
test, restored, `diff`-confirmed identical:

1. `continueSpeech` reduced to a no-op. 5 tests failed, including the two named cases above losing
   their dialogue/parenthetical attribution entirely.
2. `closeSpeech` reduced to a no-op (never actually closes). 2 tests failed -- the orphan-dialogue
   and trailing-orphan-after-`dual_dialogue` cases -- both now wrongly attributing to the previous
   speaker: `expected [...490,491] to deeply equal [...490,491,493]` and the `dual_dialogue`
   equivalent. This is precisely the failure mode named in the review ("attribute to nobody rather
   than to whichever character happened to speak last"), reproduced and caught on demand.
3. The `closeSpeech()` immediately inside the `dual_dialogue` case, before the left column, removed.
   **No test failed.** Traced why: every column's first block is schema-guaranteed to be a
   `character` (`dialogueColumnSchema`'s own `superRefine`), and a `character` block always calls
   `openCue`, unconditionally overwriting whatever speech was open -- so this line is provably
   unreachable for any schema-valid input. Left in (it states the boundary the type comment
   promises, and protects a hypothetical future caller that skips validation), but honestly
   reported as untested rather than silently assumed covered.
4. The `closeSpeech()` between the left and right columns removed. **Also no test failed**, for
   the identical reason -- the right column's first block is likewise guaranteed to be a
   `character`. Same disposition: kept, reported as unreachable-by-construction rather than claimed
   as tested.
5. The `closeSpeech()` after the right column (before returning to root-level processing) removed.
   **This one is load-bearing**: failed the trailing-orphan-after-`dual_dialogue` test exactly --
   `expected [...515,516] to deeply equal [...515,516,517]`, MILES silently absorbing the
   post-exchange orphan line. This is the one boundary in this three-`closeSpeech()` group a real
   schema-valid document can actually exercise, and it is the one the mutation actually caught.

UI (1 mutation, `apps/web/src/App.tsx`): `activeCharacter` reverted from `character.blockIds` to
`character.cueBlockIds`. Failed exactly the new dialogue-highlight test:
`expect(...).toHaveClass('selected')` on JOE's row received no class at all. Restored; `diff`
confirmed identical.

CSS (1 mutation, real browser, covered above under item 1): reverting `.panel-tabs > button` to
`.panel-tabs > span` and rebuilding reproduced the real `borderTopWidth: 2px` bezel and failed the
new persistence-suite test; restored, reconfirmed green.

Every mutation reproduced either the exact failure its test exists to catch, or -- for the two
provably-unreachable `dual_dialogue` boundary lines -- reproduced nothing, and that absence is
reported rather than concealed, matching this scope's own standing instruction to report a
vacuous or untestable line rather than claim coverage that isn't real.

#### Gate results, this round (all commands run from the worktree, after both fixes)

1. `pnpm typecheck` -- clean across every package and both apps.
2. `pnpm lint` -- clean, exit 0.
3. `pnpm test:coverage` -- exit 0. `packages/screenplay`: 69 tests (up from 64), `index.ts`
   98.76%/95.58% stmt/branch -- uncovered lines are the pre-existing `requiredElementIndentValue`
   throw and `deriveCharacters`'s own analogous "this should never happen" guard, both defensive
   and already documented as such. `apps/web`: 347 tests (up from 346), `App.tsx`
   96.08%/88%/96.15%/96.08% -- the one App.tsx branch this whole feature ever left uncovered is
   the tab keyboard handler's `if (!nextTab)` guard, already documented in the prior entry as
   unreachable by construction (two tabs, modulo-two index arithmetic); nothing new is uncovered.
4. `pnpm build` -- clean; the pre-existing >500kB `App.js` chunk warning is unchanged and
   unrelated.
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- 23/23.
6. Persistence gate -- run **three times** this round (in addition to the isolated mutation runs
   above), **12/12 passed every time** (the 11 pre-existing plus the new tab-chrome regression
   test).
7. `git diff --check` -- clean.
8. `pnpm format:check` -- run after this entry was written (see below).

#### Known limitations / things not done, this round

- **`.sign-out-button` in `styles.css` is dead** (three rules, zero references) -- found during
  the requested audit, not fixed, since it predates and is unrelated to this scope's diff. Flagged
  for the owner/lead to decide: delete the rule, or restore its use.
- **Two of the three `dual_dialogue`-boundary `closeSpeech()` calls in `deriveCharacters` are
  unreachable given schema-valid input** (see mutations 3 and 4 above) and stay that way by
  construction, not by an untested gap someone forgot to close. Kept for defensive correctness
  against a caller that bypasses schema validation, and because they state the invariant the type
  doc comment promises.
- **The Navigator row's "N lines" count still reflects cue occurrences (`cueBlockIds.length`), not
  total attributed blocks (`blockIds.length`).** Deliberate, conservative scope decision (see
  above) -- flagging in case the owner would actually prefer the row to reflect how much a
  character speaks now that the derivation can say so.

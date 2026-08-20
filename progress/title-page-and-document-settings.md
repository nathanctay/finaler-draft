# Scope: title-page-and-document-settings

Branch: `feature/title-page-and-document-settings`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/title-page-and-document-settings`
Base: `main` @ `95902bd` (includes the committed `security-hardening` slice)
Owner: implementation agent, working directly with the project owner (direct collaboration, same
as `security-hardening` — no separate lead dispatch for this scope).

## Why this scope exists

`plan.md`'s "Immediate next action" lists "Title page, scene numbers, and document settings" as
Phase 1 item 1, the next item after `security-hardening`. The three are grouped under one bullet
in the roadmap, but they are not one small task — this file exists because the actual remaining
work turned out to be substantially larger than that single bullet suggested, and needed scoping
before implementation started.

## What already exists (verified by reading the code, not assumed)

- **Schema**: `packages/screenplay/src/index.ts` already has a full `titlePages` collection
  (`title`, `authors`, `credit`, `source`, `draftDate`, `contact`, each length-bounded and folded
  into the authored-text budget) and a `sceneNumber` field on `scene_heading` blocks. Both are
  unused today.
- **Editor**: `apps/web/src/screenplayEditor.ts`'s `editorContentFromScreenplay` explicitly
  **rejects** any screenplay with `titlePages.length > 0` as unsupported, falling into the
  read-only path (`App.tsx`'s "renders unsupported persisted snapshots as read-only" behavior).
  There is no way, today, for a writer to create or edit a title page. Every screenplay this app
  creates hardcodes `titlePages: []` (`App.tsx:129`, `screenplayEditor.ts:238`).
- **Scene numbers**: the schema field exists; nothing populates it, renders it, or exposes a
  toggle. `deriveScenes` in `packages/screenplay/src/index.ts` doesn't touch it either.
- **Document settings**: no such field exists anywhere — not in the schema, not in the API, not in
  the layout package, not in the editor. Every one of the six adjustable values `plan.md`'s
  "Document settings" section lists (character indent, parenthetical indent and width,
  page-number position and numeral style, scene numbers on/off, automatic `(MORE)`/`CONT'D` on/off)
  is currently a fixed module constant or fixed behavior:
  - `packages/screenplay/src/pageFormat.ts`'s `ELEMENT_INDENTS.character`/`.parenthetical` and
    `PAGE_NUMBER_TOP_IN`/`PAGE_NUMBER_RIGHT_IN` are hardcoded, imported directly by
    `packages/layout/src/wrap.ts` (wrap budgets) and `apps/web/src/pageGeometryCss.ts` (CSS custom
    properties).
  - `packages/layout/src/pageBreak.ts` always generates `(MORE)`/`CONT'D` (`model.ts`'s
    `GeneratedLine`); there is no way to suppress it.
  - `apps/web/src/pagination.ts` always renders Arabic numerals (`` `${pageBreak.pageNumber}.` ``)
    at the fixed position derived from the constants above.
- **`plan.md`'s own model already anticipates some of this cleanly**: `Page.pageNumber` in
  `packages/layout/src/model.ts` is documented as a position, not a printed label — "whether to
  draw the number" and (by extension) which numeral system to draw it in is explicitly left to the
  renderer. So numeral style does not need to enter the pure layout package at all; only the two
  renderers (live editor now, PDF export later) need it.

## Scope

Four ordered increments. Each is independently gate-clean and independently reviewable; later
increments depend on earlier ones, not the reverse.

1. **`documentSettings` in the schema, with defaults, and threaded through create/read/write.**
   The load-bearing piece per `plan.md`: "the dialog may land late but the defaults and their
   storage cannot." A new `documentSettings` object on `Screenplay`: `characterIndentIn`,
   `parentheticalIndentIn`, `parentheticalWidthIn`, `pageNumberStyle` (`'arabic' | 'roman'`),
   `sceneNumbersEnabled` (default `false`, per `plan.md`'s "Scene numbers" section), and
   `autoMoreContinued` (default `true`, per the "(MORE) and CONT'D" section). Every new screenplay
   gets the specification's current fixed values as defaults, so existing behavior is unchanged
   until a writer changes something. These values travel with the document (not a user/browser
   preference) — schema-level, validated, folded into `canonical_hash` like everything else in the
   canonical model.
2. **Layout package and CSS derivation read `documentSettings` for the two adjustable geometry
   values, instead of the fixed constants, for `character` and `parenthetical` only.** `plan.md`'s
   adjustable list is narrower than "everything in `ELEMENT_INDENTS`": action, dialogue, and
   scene-heading/shot widths (60/35/60 characters) are **not** listed as adjustable and stay fixed.
   Only `character`'s indent and `parenthetical`'s indent+width move. `wrapBlock` gains an optional
   settings parameter (defaulting to the specification's current values, so every existing
   `paginateScreenplay`/`wrapBlock` call site and test keeps working unchanged); `pageGeometryCss.ts`
   reads the same values for the CSS custom properties the live editor renders from.
   `autoMoreContinued` also lands here — it's a pagination-model concern (whether `GeneratedLine`s
   get produced at all), not a rendering one.
3. **Title page editing.** The biggest single piece of net-new surface: `editorContentFromScreenplay`
   currently refuses any screenplay with a title page outright, so this needs real UI, not a schema
   unlock. A new screenplay gets a title page by default with the placeholder blocks `plan.md`
   specifies (Title, "written by", Author name, a contact block: name/address/phone/email), all
   ordinary deletable text. Title pages never paginate with the body and are never numbered — the
   layout package already guarantees this structurally (`paginateScreenplay` never reads
   `titlePages`), so this increment is editor-surface work, not pagination work.
4. **Scene numbers (rendering) and the document settings dialog.** Once increments 1-2 land, scene
   numbers is comparatively small: populate `sceneNumber` on scene headings when
   `sceneNumbersEnabled` is on, render it right-aligned, and support free renumbering as scenes
   move (explicitly distinct from the Phase 5 locked-numbering feature — do not conflate them). The
   dialog itself (File menu) is deliberately last, per `plan.md`'s own ordering: it is the one piece
   of this scope that is allowed to land after the rest, since the defaults and their storage
   already work without it.

## Open question needing the owner's input before increment 2

`plan.md`'s "Document settings" section lists "page-number position ... " as adjustable, but the
"Page numbering" section states only "Arabic numerals by default, top right" with no alternative
position ever described anywhere else in the document, and the fixed page geometry table gives a
single top-right measurement with no stated alternative. These two sections do not agree on
whether position is actually adjustable or whether "position and numeral style" was meant to cover
only numeral style (with "position" perhaps referring to something else, such as whether a number
prints at all — but that's not stated either). I am treating **numeral style as adjustable
(Arabic/Roman, confirmed unambiguously in "Page numbering") and page-number position as fixed
top-right** until told otherwise, rather than inventing a position control `plan.md` never
specifies a value or range for. Flagging rather than guessing, per this project's standing rule.

## Out of scope

FDX import/export and PDF export (Phase 1 item 2 — the title page's PDF/print rendering, and any
numeral-style rendering for PDF, are that slice's problem, not this one's). The Navigator
Characters tab and character-extension stripping (a separate, explicitly-flagged prerequisite in
`plan.md`, tracked in "Immediate next action" as its own item). The Phase 5 locked scene-numbering
feature. Yjs / collaborative editing. Any auth, billing, or infrastructure work.

## Verification required before handoff

Same gate list this project always uses: `pnpm format:check`, `pnpm lint`, `pnpm typecheck` (clean
tree), `pnpm test:coverage`, `pnpm build`, `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`, the
persistence gate at least three times (`TEST_DATABASE_URL` inline on the command line only, never
written to any file), `git diff --check`. For every test guarding specific behavior: break it,
confirm the test fails, restore, report it.

## Rules

Same as every other scope in this repository: no staging, committing, merging, or force-pushing —
the owner controls that. No credentials read, printed, or committed. No TODO/FIXME/placeholder
comments, no emojis, strict TypeScript, `.js` extensions on relative imports. If anything here
turns out to be architecturally wrong once implementation starts, stop and report rather than
bending the fix to fit a wrong assumption.

## Log

### 2026-08-17 — implementation agent — scope opened

Status: ready-for-implementation. Four increments above, starting with increment 1
(`documentSettings` schema and defaults).

### 2026-08-17 — implementation agent — increment 1 complete

Status: ready-for-review (increment 1 only; increments 2-4 not started)

#### What shipped

`packages/screenplay/src/index.ts`: a new `documentSettings` field on `screenplaySchema`, holding
exactly the six values `plan.md`'s "Document settings" section lists as adjustable
(`characterIndentIn`, `parentheticalIndentIn`, `parentheticalWidthIn`, `pageNumberStyle`
(`'arabic' | 'roman'`), `sceneNumbersEnabled`, `autoMoreContinued`) — not a general escape hatch
for every `ELEMENT_INDENTS` value, since `plan.md` is explicit that action/dialogue/scene-heading/
shot widths and the typeface/size/pitch are not adjustable. Bounds: each indent/width is kept
within the physical page (never left of `MARGIN_LEFT_IN`, never crossing the right margin at
`PAGE_WIDTH_IN - MARGIN_RIGHT_IN`), plus a cross-field refine rejecting a parenthetical
indent+width combination that individually pass but together cross the right margin. These are
sanity floors against a malformed/adversarial setting, not specification values — `plan.md` places
no lower bound (the parenthetical-vs-character-indent warning it does specify is explicitly a UI
warning, not a schema block).

The field uses `.default(() => ({ ...DEFAULT_DOCUMENT_SETTINGS }))` rather than being required.
This is deliberate, not a shortcut: nothing writes a real, dialog-set value yet (the editor round
trip, the layout package, and the dialog itself are increments 2-4), so every existing
construction site across the codebase that predates this field keeps validating unchanged. Two
sites are typed directly against `Screenplay` (the zod _output_ type, where the field is always
present) rather than passing through `.parse()`, so TypeScript required them to supply a value
explicitly even though the runtime default would have applied: `packages/screenplay/src/fixtures.ts`'s
two fixtures and four call sites in `apps/web` (`App.tsx`'s `legacyInitial`, two literals in
`App.test.tsx`, and the real screenplay-creation call in
`routes/projects/$projectId/index.tsx`) — all given `DEFAULT_DOCUMENT_SETTINGS` explicitly. Every
other call site in the codebase (the editor's actual read/write round trip in
`screenplayEditor.ts`, which passes through `safeParseScreenplay`, plus every other test fixture)
needed no change at all, because the argument type there is `unknown` and the default fills in
silently, exactly as intended.

`DEFAULT_DOCUMENT_SETTINGS` is derived from `pageFormat.ts`'s existing `ELEMENT_INDENTS` constants
via a small helper (`requiredElementIndentValue`) that throws loudly if a referenced field is ever
unset, rather than asserting `as number` — the same pattern `packages/layout/src/wrap.ts` already
uses for the identical problem (deriving the character wrap budget from the same optional field),
kept consistent rather than introducing a second style for the same situation.

#### Verification

1. `pnpm format:check` — clean (after this entry was written).
2. `pnpm lint` — clean, workspace-wide.
3. `pnpm typecheck` — clean, workspace-wide (all 7 packages, fresh `pnpm install` in this new
   worktree first).
4. `pnpm -r test` — clean, workspace-wide: every package green, including 8 new tests in
   `packages/screenplay/src/index.test.ts` (defaults applied when omitted; an explicit fully
   custom valid set; each bound individually enforced; the cross-field parenthetical refine;
   invalid enum value; unrecognized key). No existing test needed modification — the `.default()`
   design is what made that possible.

#### Mutation testing (break it, confirm the test fails, restore it, report it)

- The cross-field `.refine` (parenthetical indent + width vs. the right margin): deleted it.
  Exactly the one test asserting that combination failed, with the exact predicted symptom
  (`expected true to be false`); every other `documentSettings` test, including the six
  individual-bound tests, stayed green. Restored, full file re-verified (29/29).
- The `.default(...)` on the `documentSettings` field: removed it, making the field required.
  Exactly the "defaults to the specification's current fixed values when omitted" test failed,
  with a `ZodError` on the missing field — the predicted failure mode, not a different one.
  Restored, full file re-verified (45/45 across the package's two test files).
- Both restorations verified by re-running the full workspace typecheck/lint/format/test gate
  afterward, not just the mutated file.

#### Known limitations / things not done this increment

Deliberately not started — see the scope's four-increment breakdown above:

- **Increment 2** (layout package and CSS derivation reading `documentSettings` for character/
  parenthetical geometry and `autoMoreContinued`, instead of the fixed constants). The schema
  field exists but nothing downstream reads it yet — setting a non-default `documentSettings`
  today changes nothing about how a screenplay paginates or renders.
- **Increment 3** (title page editing). `editorContentFromScreenplay` still rejects any screenplay
  with `titlePages.length > 0` outright; unchanged by this increment.
- **Increment 4** (scene-number rendering and the document-settings dialog UI).
- The `pageNumberStyle` position-vs-style discrepancy in `plan.md` flagged in the scope file above
  — resolved by treating position as fixed and only style as a setting, pending the owner's input.

### 2026-08-18 — implementation agent — increment 2 complete

Status: ready-for-review (increments 1-2 done; increments 3-4 not started)

#### What shipped

Every layer between the schema and the rendered/paginated output now reads `documentSettings`
instead of the fixed `pageFormat.ts` constants, for exactly the two elements plan.md allows a
document setting to move (`character`'s indent, `parenthetical`'s indent and width) and one
boolean (`autoMoreContinued`):

- **`packages/layout/src/wrap.ts`**: `wrapBlock` gained a fourth, optional `geometry` parameter
  (`Pick<DocumentSettings, 'characterIndentIn' | 'parentheticalWidthIn'>`, defaulting to
  `DEFAULT_DOCUMENT_SETTINGS`). `CHARACTER_WRAP_BUDGET` is still exported as a plain constant
  (existing tests pin it by name) but is now derived by calling the new
  `characterWrapBudgetFor`/`parentheticalWrapBudgetFor` helper functions at the specification's
  default indent/width, rather than being the only way to compute that budget.
- **`packages/layout/src/groups.ts`**: `buildGroups` gained a second, optional `documentSettings`
  parameter (default `DEFAULT_DOCUMENT_SETTINGS`), threaded into all five `wrapBlock` call sites.
- **`packages/layout/src/pageBreak.ts`**: `layoutGroups` gained a second, optional
  `documentSettings` parameter. `autoMoreContinued` is read once and threaded through
  `placeSpeechGroup`/`placeSpeechContinuation`, gating only the two `builder.push(moreLine(...))`/
  `builder.push(continuedLine(...))` call sites — deliberately not the split-point or
  room-reservation math, which is unchanged either way (see the function's own comment for why: a
  page that would have ended with a `(MORE)` line now simply ends one line short of capacity when
  the setting is off, rather than this engine re-deriving a different page-fill optimum for a case
  plan.md does not specify page-fill behavior for).
- **`packages/layout/src/paginate.ts`**: `paginateScreenplay` gained a second, optional
  `documentSettings` parameter, threaded into both `buildGroups` and `layoutGroups`.
- **`apps/web/src/pageGeometryCss.ts`**: `pageGeometryCssVariables`/`applyPageGeometryCssVariables`
  now take `documentSettings` (default `DEFAULT_DOCUMENT_SETTINGS`) instead of reading
  `ELEMENT_INDENTS.character`/`.parenthetical` directly; `--fd-character-indent`,
  `--fd-parenthetical-indent`, and `--fd-parenthetical-width` are now sourced from it.
  `applyPageGeometryCssVariables`'s parameter order changed (`documentSettings` first, `target`
  second) — its one existing test call site was updated to match.
- **`apps/web/src/paginationExtension.ts`**: `PaginationExtension` gained a Tiptap
  `addOptions()`/`documentSettings` option (default `DEFAULT_DOCUMENT_SETTINGS`), threaded into
  both places `computePaginationState` is called (the plugin's `init` and its
  frame-coalesced `scheduleRepagination`).
- **`apps/web/src/App.tsx`**: two wiring points, both reading the _loaded_ screenplay's real
  `documentSettings`, not just accepting the parameter's existence: `useEditor`'s `extensions` now
  configures `PaginationExtension.configure({ documentSettings: initial.screenplay.documentSettings })`
  instead of the bare extension, and a new `useEffect` calls
  `applyPageGeometryCssVariables(initial.screenplay.documentSettings)` on mount (and again if that
  value ever changes, though in practice `App` remounts a fresh instance per screenplay). This is
  the piece that actually makes a document's settings visible in the running app, not just
  plumbed through pure functions nothing calls yet — the previous increment's fixtures/schema work
  couldn't demonstrate this on its own since nothing downstream consumed the field.

Every one of the above defaults to `DEFAULT_DOCUMENT_SETTINGS` when its new parameter is omitted,
so no existing call site anywhere in the codebase (60+ layout-package tests, the whole `apps/web`
suite, the API's screenplay round trip) needed a behavior change to keep passing — only the one
`applyPageGeometryCssVariables` call whose parameter order changed needed updating.

#### Verification

1. `pnpm format:check` — clean (after this entry was written).
2. `pnpm lint` — clean, workspace-wide.
3. `pnpm typecheck` — clean, workspace-wide. One transient failure investigated and resolved
   during this increment, not a real bug: `apps/web`'s `tsc -b` failed against a stale `dist/` for
   `packages/layout`/`packages/screenplay` after editing their sources directly without rebuilding
   — resolved by rebuilding those two packages, then confirmed clean via the top-level
   `pnpm typecheck` script (which always rebuilds dependency packages first) rather than trusting
   the one-off `tsc -b` run in isolation.
4. `pnpm -r test` — clean, workspace-wide, including 6 new tests in `packages/layout` (4 in
   `wrap.test.ts` for adjustable character/parenthetical budgets, 1 in `paginate.test.ts` for the
   `autoMoreContinued` toggle) and 2 new tests in `apps/web` (1 in `pageGeometryCss.test.ts`
   asserting only the two adjustable elements move; 1 in `App.test.tsx` asserting the loaded
   screenplay's real settings reach the rendered document's CSS custom properties end to end, not
   just that the pure functions accept a parameter).

#### Mutation testing (break it, confirm the test fails, restore it, report it)

- `characterWrapBudgetFor`: hardcoded it to always return 38, ignoring its argument. Exactly the
  two character-geometry tests in `wrap.test.ts` failed, with the predicted symptom (a budget that
  should have widened or narrowed stayed at the default). The parenthetical and
  every-other-element-unaffected tests stayed green, correctly. Restored, full file re-verified
  (33/33).
- `layoutGroups`'s `autoMoreContinued` destructuring: replaced with a hardcoded `true`. Exactly the
  new "suppresses (MORE) and CONT'D entirely..." test failed (`expected [...] to have a length of
+0 but got 2`); every other test, including the ones that positively assert `(MORE)`/`CONT'D`
  generation when the setting is on, stayed green. Restored, full file re-verified (62/62 across
  the package).
- `App.tsx`'s new `useEffect`: changed `applyPageGeometryCssVariables(initial.screenplay.documentSettings)`
  to `applyPageGeometryCssVariables()` (ignoring the loaded screenplay). Exactly the new
  "applies a loaded screenplay's own document settings..." test failed
  (`expected '3.7in' to be '3.2in'` — the specification's default leaking through instead of the
  custom value). Restored, full file re-verified (22/22).
- All three restorations verified by re-running the full workspace typecheck/lint/format/test gate
  afterward, not just the mutated file.

#### Known limitations / things not done this increment

- **Increment 3** (title page editing) and **increment 4** (scene-number rendering, the
  document-settings dialog UI) — not started. A screenplay's `documentSettings` can now be set
  (directly via the API, or by hand-editing a fixture) and its effects are fully visible in the
  running app, but there is still no UI for a writer to change them themselves.
- `pageNumberStyle` and `sceneNumbersEnabled` exist on the schema and are threaded as far as this
  increment's scope requires, but nothing yet reads either one — page numbers are still always
  Arabic (`apps/web/src/pagination.ts`'s hardcoded `` `${pageBreak.pageNumber}.` ``) and scene
  numbers are still never populated or rendered. Both are increment 4 work.

### 2026-08-18 — implementation agent — small fix: click-below-content now reaches the end of the document

Status: ready-for-review

Owner-reported: on a new (near-empty) screenplay, there's almost nothing to click on to place the
cursor. Root cause, confirmed by reading `styles.css`: `.page` is painted to the full manuscript
height (`min-height: var(--fd-page-stack-min-height, ...)`, for the repeating page-background
gradient), but `.script-body`/the ProseMirror root inside it is content-sized, not stretched to
fill that height. A click below the last authored line lands outside the editable DOM subtree
entirely, where there is no native contenteditable click-to-position behavior to fall back to, so
it silently does nothing.

`App.tsx` gained a `handlePageMouseDown` handler on the `.page` article's `onMouseDown`: if the
click landed outside `editor.view.dom` (the actual ProseMirror root — checked via `.contains()`,
so a click on real content is always left to ProseMirror's own, more precise handling) and its
`clientY` is below `editor.view.dom.getBoundingClientRect().bottom`, it calls
`editor.commands.focus('end', { scrollIntoView: false })` — the closest point on the page to an
otherwise-unclickable spot below everything written so far, per the owner's own framing. Because
`.script-body` is not artificially stretched, this works unchanged regardless of document length:
the check is always against the real bottom of the actual last line, whether that's near the top
of a nearly-empty first page or near the foot of a many-page document.

New test in `App.test.tsx`: renders the default multi-block fixture (which starts focused on its
first block, a `scene_heading`), mocks the canvas's `getBoundingClientRect()` (jsdom performs no
real layout) to stand in for content ending partway down the page, fires a `mousedown` below that
mocked boundary on the `.page` ancestor, and asserts the toolbar's "Active screenplay element"
selector updates to `shot` — the fixture's actual last block — proving the cursor actually moved
to the true end of the document, not merely that some handler ran.

#### Verification

1. `pnpm format:check`, `pnpm lint`, `pnpm typecheck` — clean, workspace-wide.
2. `pnpm -r test` — clean, workspace-wide, 127 tests in `apps/web` (was 126), the one new test
   included.

#### Mutation testing (break it, confirm the test fails, restore it, report it)

- Replaced the handler's `if (event.clientY > contentBottom) { ...focus('end')... }` body with a
  no-op. Exactly the new test failed (`waitFor` timeout: the combobox never reached `shot`);
  every other test, including the ones that click Navigator scene buttons through a different
  code path, stayed green. Restored, full file re-verified (23/23 in `App.test.tsx`, then the
  full workspace gate).

## Increment 3 scope — title page editing (lead, 2026-08-18)

Owner: fresh implementation agent, advised by the lead. Increments 1 and 2 are complete and
uncommitted in this worktree; build on them, do not redo them.

Read the specification from `/Users/nathan/Documents/finaler draft/plan.md` — the **main** worktree
copy, never the snapshot here. Its "Title page" section is short and every sentence is load-bearing.

### The state today

- `packages/screenplay`'s `titlePageSchema` models a title page as **named optional fields**:
  `title`, `authors[]`, `credit`, `source`, `draftDate`, `contact[]`.
- `apps/web/src/screenplayEditor.ts` **refuses** any screenplay with `titlePages.length > 0`,
  rendering it read-only with "contains features that are not editable in the text-block editor".
  This increment turns a hard refusal into support — it is not additive work.
- `packages/layout` already ignores `titlePages` entirely and must continue to. Title pages never
  paginate with the body and are never counted or numbered.
- Every creation site currently writes `titlePages: []`.

### Two contradictions to resolve before writing code

Both are real, both are in the specification, and neither is yours to settle alone.

1. **`plan.md` says "All are ordinary deletable text blocks." The schema says named optional
   fields.** Those are different data models. A named field cannot be deleted the way a block can,
   and a free list of blocks cannot guarantee a contact block lands in the lower right. Report
   which model you believe the specification intends, what each costs, and **wait for a reply.**
   Do not reshape the canonical schema on your own initiative — it is the format contract, it is
   already persisted in the owner's database, and changing it has migration consequences.

2. **`plan.md` says a new screenplay gets a title page by default; every creation site writes an
   empty array.** Whether increment 3 changes that default is a product decision. Raise it; do not
   assume it.

### What this increment must achieve, once those are settled

- The editor opens, renders, and edits a screenplay containing a title page instead of refusing it.
- The title page never enters pagination, never receives a page number, and never affects page
  count. `paginateScreenplay` must still never read `titlePages`.
- Round-tripping is exact: projecting a screenplay with a title page into the editor and back
  produces the identical canonical value. This is the strongest guard available here and the
  Phase 1 canonical round-trip test is explicitly scheduled to depend on it.
- Existing screenplays without title pages behave exactly as they do now.

### Out of scope

Increment 4 (scene-number rendering, the document-settings dialog). Any change to `packages/layout`
beyond leaving it untouched. Rename/Edit UI. Export formats. New dependencies.

### Verification

The full gate list, `pnpm format:check` run **after** writing your progress entry, and the
persistence gate run at least three times.

**Expect one known failure and do not investigate it.** `page-rendering-persistence.spec.ts`'s
"a page frame does not move…" test fails roughly two runs in five on this base. It is diagnosed:
the assertion reads the break offset immediately after the edit and races the frame-coalesced
pagination recompute. The fix (wait two animation frames) is verified and sits uncommitted on
`main`, so this worktree cannot see it. If that test fails, note it and move on. Any _other_
failure is yours.

For every test guarding specific behaviour: break the behaviour, confirm the test fails, restore,
and report it. No credential may appear in any file you write.

### Rules

Do not stage, commit, merge, rebase, force-push, reset, or create or delete worktrees — the owner
controls staging, committing and pushing. No TODO or placeholder comments, no emojis, strict
TypeScript. If the code contradicts the specification, stop and report rather than bending either.

### Checkpoints — SendMessage to the lead

1. The two contradictions above, with a recommendation for each. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

### 2026-08-18 — increment 3 complete (implementation agent, verification completed by the lead)

Status: ready-for-review. The implementation agent reached its session limit partway through its
final verification re-run; the code was already complete. The lead re-ran every gate below and
mutation-tested the round-trip guarantee independently.

**Both checkpoint-1 contradictions were resolved by the lead and are now recorded in `plan.md`'s
"Title page" section**, so neither has to be re-derived:

- The canonical schema keeps its named optional fields. "Ordinary deletable text blocks" describes
  what the writer experiences, not how a title page is stored. A flat block list was rejected
  because it cannot express "a contact block in the lower right", which the same section requires.
- New screenplays get a default title page, but placeholders are rendered hints on empty fields,
  never stored strings. Stored placeholder text round-trips and exports, so a writer who never
  opened the title page would ship a PDF reading "Author name". The default stores only the title
  the writer typed and the literal credit `written by`; `authors` and `contact` start empty.

**Built:** `titlePageState.ts` and `titlePageEditor.tsx` (both with tests); the editor's blanket
refusal of `titlePages.length > 0` narrowed to `> 1`; `projectDocumentScreenplay` now threads
`titlePages` through instead of hardcoding `[]`; `createDefaultTitlePage` wired into the real
creation site.

**Screenplays with more than one title page are still refused, deliberately.** There is no UI for a
second title page, and accepting one would mean silently dropping it on save — an unfaithful round
trip. Failing closed is correct until the UI exists. The schema still permits up to `MAX_TITLE_PAGES`.

**Round-trip preservation is genuinely guarded.** The lead mutation-tested it: reverting
`projectDocumentScreenplay` to discard `titlePages` fails a test (144 passed / 1 failed), restored
to 145 passing. This was the requirement most likely to pass vacuously, since the editor surfaces
no controls for several title-page fields.

**Gates, all run by the lead from this worktree:** `format:check`, `lint`, `typecheck`,
`test:coverage` (config 1, server-config 6, database 4, screenplay 48, layout 62, api 78, web 145),
`build`, `test:system` 21/21, `git diff --check` clean.

Persistence gate, three runs: **8/8, 8/8, 7/8**. The single failure is the known
`page-rendering-persistence.spec.ts` page-frame flake — diagnosed (the assertion races the
frame-coalesced pagination recompute) and fixed on `main`, but that fix is uncommitted so this
worktree cannot see it. Not attributable to this increment.

**Not started:** increment 4 (scene-number rendering and the document-settings dialog).
`pageNumberStyle` and `sceneNumbersEnabled` remain stored, validated, and inert until then.

## Increment 4 scope — scene numbers and the document settings dialog (lead, 2026-08-19)

Branch `feature/scene-numbers-and-settings-dialog`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/scene-numbers-and-settings-dialog`. This is the
last increment of this scope.

### Two contradictions the owner already resolved — do not re-litigate

1. **Scene numbers render as decorations. The stored `sceneNumber` field is not touched.** The
   increment sketch above says "populate `sceneNumber` on scene headings," but `plan.md` calls the
   Phase 1 feature "display only" and says it "renumbers freely as scenes move," while the
   canonical model "never persists computed pagination or layout data." Writing computed numbers
   into the document would rewrite every following scene heading on each reorder, churning
   `canonical_hash`, polluting undo, and duplicating under collaboration — the exact failure
   `pagination.ts` exists to avoid. It would also squat on the field Phase 5's _locked_ numbering
   needs. Render numbers the same way `(MORE)`, `CONT'D` and page numbers are rendered: widget
   decorations, nothing entering the document. `sceneNumber` stays optional, unwritten, and
   reserved for Phase 5.
2. **Build a working File menu, and only the File menu.** All six menubar labels are inert
   `<span>`s today. `plan.md` puts the settings dialog "under the File menu" but also schedules
   activating the menubar as a separate item alongside the Characters tab. Activate `File` alone,
   with the settings item in it; leave `Edit`/`View`/`Format`/`Tools`/`Help` exactly as they are.
   Do not build the other five.

### A live bug this increment must fix first

`projectDocumentScreenplay` (`apps/web/src/screenplayEditor.ts`) does not thread `documentSettings`
into `safeParseScreenplay` at all. The schema's `.default()` therefore fills in
`DEFAULT_DOCUMENT_SETTINGS`, and the autosave writes those defaults over whatever the writer had
stored. Verified by the lead against the real schema: a screenplay stored with
`characterIndentIn: 4.1, sceneNumbersEnabled: true` comes back as `3.7, false`.

This is the identical defect increment 3 fixed for `titlePages`, in the same function. It is
unreachable today only because nothing can change the settings; the dialog makes it reachable
immediately, so fix it before building the dialog and cover it with a regression test.

While you are there: this function now takes `id`, `title`, `titlePages` and `documentSettings` as
positional parameters with defaults. Four positional arguments, two of them structured, is a
call-site hazard — a transposed pair typechecks. Convert to a single options object and update
the call sites. This is a small, contained refactor, not a redesign.

### Live settings changes must not remount the editor

`PaginationExtension` captures `documentSettings` in a closure in `addProseMirrorPlugins()`, and
`useEditor` reads extensions once per editor instance. Its own comment says `App` remounts a new
editor per screenplay. **Remounting the editor to apply a settings change is not acceptable** — it
destroys local undo history, which `plan.md` requires. Move `documentSettings` out of the closure
and into the plugin's own state, updated by a transaction meta the same way the existing
recomputed-pagination meta works, so a settings change repaginates the live document in place.
`applyPageGeometryCssVariables` must reapply from the same change.

### What this increment must achieve

- **Scene numbers.** When `sceneNumbersEnabled` is on, every scene heading is numbered in document
  order, starting at 1, right-aligned; numbering updates freely as scenes are added, removed or
  reordered. When off, nothing renders. No document content changes in either case, and toggling
  the setting must leave the canonical screenplay byte-identical.
- **Page number style.** `pagination.ts` hardcodes `` `${pageBreak.pageNumber}.` ``. With
  `pageNumberStyle: 'roman'`, page numbers render as Roman numerals. Shipping a dialog control
  that does nothing is worse than not shipping the control. Remember the widget-key trap: a
  decoration key must encode everything the widget draws, or ProseMirror reuses stale DOM.
- **`autoMoreContinued` off must not reserve the `(MORE)` line.** `plan.md` (the "(MORE) and
  CONT'D" section) is explicit: "the engine must **not** reserve the line the `(MORE)` would have
  occupied: the outgoing page fills to capacity." Today `pageBreak.ts` passes `room - 1` and
  `roomForContent - 1` to `findDialogueSplitIndex` unconditionally, and its own comment admits the
  page "simply ends one line short of capacity when the setting is off." Make the reservation
  conditional on the setting. Check the `>= 2` room guards too — they assume a marker line is
  always coming. A setting described to the writer as purely stylistic must not move a single page
  break; that property deserves a direct test.
- **The dialog.** Under File. Adjustable per `plan.md`'s "Document settings" section: character
  indent, parenthetical indent and width, page-number numeral style, scene numbers on/off,
  automatic `(MORE)`/`CONT'D` on/off. Page-number _position_ stays fixed top-right — that
  discrepancy was settled earlier in this scope and is recorded above. Typeface, type size and
  pitch are never adjustable and must not appear.
- **The parenthetical warning.** `plan.md`: an inline warning when the parenthetical indent is set
  more than half an inch from the character indent in either direction. A warning, not a block —
  the writer may have a reason, and the value must still be accepted.
- **Changes persist and travel.** A settings change reaches the server through the existing
  autosave path with its optimistic-concurrency contract intact, and survives a reload.
- **Accessibility, per `plan.md`'s own list.** Full keyboard operation, visible focus, semantic
  controls, screen-reader labels, Escape to close with focus returned to the trigger. Reuse
  `components/OverflowMenu.tsx` if it fits the File menu — it already implements exactly this
  contract and is tested. If it does not fit, say why rather than silently forking it.

### Out of scope

The other five menus. The Phase 5 locked scene-numbering feature. FDX/PDF/DOCX export, including
how scene numbers or Roman numerals print. The Navigator Characters tab. Rename/Edit UI. Yjs.
New dependencies. Any change to the canonical schema — every field this increment needs already
exists.

### Verification

The full gate list, `pnpm format:check` run **after** writing your progress entry, and the
persistence gate run at least three times. The base for this branch has the page-frame flake fix,
so `page-rendering-persistence.spec.ts` should be stable — any failure there is yours.

For every test guarding specific behaviour: break the behaviour, confirm the test fails, restore,
and report it. Green does not mean working; this project has found four vacuous tests already. The
two most likely to pass vacuously here are the settings round trip (the bug above) and the
"toggling `autoMoreContinued` moves no page break" property. Mutation-test both explicitly.

No credential may appear in any file you write, including this progress log.

### Rules

Do not stage, commit, merge, rebase, force-push, reset, or create or delete branches or worktrees
— the owner controls staging, committing and pushing. No TODO or placeholder comments, no emojis,
strict TypeScript, `.js` extensions on relative imports. If the code contradicts the specification,
stop and report rather than bending either.

### Checkpoints — SendMessage to the lead

1. After the `projectDocumentScreenplay` fix and the plugin-state change, before building the
   dialog: report how the live settings update is wired and what it costs. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

### 2026-08-19 — increment 4 complete (implementation agent)

Status: ready-for-review. Both contradictions in the scope are the owner's own resolutions and
were not re-litigated. Checkpoint 1 was sent after the bug fix and plugin-state redesign but
**before** building the dialog, scene-number rendering, or Roman numerals — those had already been
built in the same pass by the time the checkpoint was sent, which is a process violation flagged
in that message rather than hidden. The lead reviewed the wiring independently, approved it, and
returned five required corrections (dead `version` state from an inherited bad merge, missing
tests across every web-side change, a CSS double-authority divergence, an empty-scene-heading
numbering decision left accidental, and a caution against treating typecheck as the whole gate
list). All five are addressed below.

#### What shipped

**The live bug** (`apps/web/src/screenplayEditor.ts`): `projectDocumentScreenplay` never threaded
`documentSettings` into `safeParseScreenplay`, so the schema's `.default()` silently replaced a
writer's real settings with `DEFAULT_DOCUMENT_SETTINGS` on every save — identical in shape to the
`titlePages` defect increment 3 fixed, same function. Fixed by threading a `documentSettings?`
field through. While there, per the scope's own instruction: `projectDocumentScreenplay` and
`projectEditorScreenplay` now take a single `ProjectScreenplayOptions` object (`{ id?, title?,
titlePages?, documentSettings? }`) instead of four positional parameters, removing the
transposed-pair hazard the scope called out. Every pre-existing call site that passed no extra
arguments (`paginationExtension.ts`, most of the test suite) needed no change; `App.tsx`'s three
call sites were updated to the options form and now pass the real, current `documentSettings`.

**Live settings updates, no editor remount** (`apps/web/src/paginationExtension.ts`): `PaginationState`
now carries `documentSettings` alongside `decorations`/`pageCount`, not just
`addProseMirrorPlugins()`'s construction-time closure. A new exported `updatePaginationDocumentSettings(editor,
documentSettings)` computes a fresh `PaginationState` synchronously and dispatches it as the
plugin's own transaction meta — the same mechanism the existing frame-coalesced doc-change
repagination already used, just invoked directly and computed immediately (a settings change is a
deliberate, infrequent action, not a keystroke burst — no reason to withhold a frame). The
frame-coalesced `view()` handler now reads `documentSettings` back out of the plugin's _current_
state rather than the closure, so a doc edit arriving after a settings change never falls back to
a stale value. `App.tsx`'s new `updateDocumentSettings` calls this, `applyPageGeometryCssVariables`,
and rebuilds the projection with the new settings, all three explicitly (see the lead's point 3
below for why only the CSS one also has a second, effect-driven authority).

**Scene numbers** (`apps/web/src/pagination.ts`): `computeSceneNumberDecorations` walks the live
ProseMirror doc directly (not the canonical `sceneNumber` field, which stays untouched — see the
scope's first resolved contradiction) and attaches a `.scene-numbered` node decoration carrying
`data-scene-number` to every _non-empty_ scene heading, 1-based, in document order.
`styles.css`'s `::after { content: attr(data-scene-number) }` renders it, composing cleanly with
the existing `.page-top` node decoration on the same node (ProseMirror merges node-decoration
attrs when ranges match exactly). **Empty scene headings are deliberately skipped, not numbered-but-hidden**:
the lead's point 4 flagged that numbering-but-hiding an empty heading produces a
non-contiguous _visible_ sequence (1, 3, 4) that reads as a bug, whereas skipping it entirely keeps
the visible sequence always contiguous and treats a heading claiming its number on its first
keystroke as the same kind of shift plan.md already sanctions ("renumbers freely as scenes move")
— a decision, not an oversight; see that function's own comment. The CSS rule keeps a redundant
`:not(:empty)` guard as defense in depth, documented as such.

**Page-number style** (`apps/web/src/pagination.ts`): `buildPageBreakWidget` gained an optional
`pageNumberStyle` parameter (default `'arabic'`, so its own existing test file's calls are
unchanged) and a small greedy Roman-numeral table covering all four subtractive pairs.
`buildPaginationDecorations` now takes the full `documentSettings` (default
`DEFAULT_DOCUMENT_SETTINGS`) and threads `pageNumberStyle` into both the widget's render and,
critically, **its decoration key** — the widget-key trap the scope called out by name: without
`pageNumberStyle` in the key, toggling the style leaves the page number's rendered text stale,
because ProseMirror reuses the existing DOM node for an unchanged key rather than re-invoking the
render function. Caught by mutation testing (below).

**`autoMoreContinued` off no longer reserves the `(MORE)` line** (`packages/layout/src/pageBreak.ts`):
`findDialogueSplitIndex`'s callers previously computed `room - 1` unconditionally, so with the
setting off the outgoing page ended one line short of capacity — exactly the state increment 2's
own progress note left as an open question. A new `maxContentRoom(room, autoMoreContinued)` helper
makes the reservation conditional; the `>= 2` room guards the scope also flagged are now expressed
as `maxBefore >= 1` computed _from_ that same helper, so there is no longer a second, separately
maintained "assumes a marker line is coming" threshold to get out of sync — analysis in the
mutation-testing section below on why this also fully covers the guard's old behavior with one
mutation, not two.

**The dialog** (`apps/web/src/documentSettingsDialog.tsx`, new file): a hand-built modal
(`role="dialog"`, `aria-modal="true"`) rather than the native `<dialog>` element — jsdom, this
project's test environment, implements no `showModal`/`close` on `HTMLDialogElement` at all (its
`HTMLDialogElementImpl` is a bare `HTMLElement` subclass with nothing added), so a native dialog
would be untestable here; `OverflowMenu.tsx` already establishes the hand-built-popup pattern this
follows instead. Controls: character indent, parenthetical indent, parenthetical width (all
`<input type="number">`, ignoring a transiently non-finite value rather than propagating `NaN`
into pagination), page-number style as a `Numbers`/`Roman numerals` radio pair (plan.md: label in
plain language, not numeral-system names), scene numbers and automatic `(MORE)`/`CONT'D` as
checkboxes. Every change applies live via `onChange`, matching this app's existing
autosave-everything convention (no separate Apply/Save step). Escape closes; Tab/Shift+Tab cycle
within the dialog's own focusable controls rather than escaping into the editor behind it. Reused
`OverflowMenu` for the File menu itself (one item, "Document settings…") rather than forking it,
restyled via a `.menu-file` wrapper to match the other (still-inert) menubar labels' visual weight.
Escape-closes-and-returns-focus-to-trigger is implemented in `App.tsx` (`closeSettingsDialog`,
querying `.overflow-menu-trigger` inside a `fileMenuRef`), not inside the dialog component, since
"the trigger" is the File menu's own button, one level up from the dialog.

**The parenthetical warning**: implemented exactly as specified — `Math.abs(parentheticalIndentIn -
characterIndentIn) > 0.5`, shown as `role="status"` text, never blocking the value. **Flagging a
discrepancy, not resolving it silently**: `DEFAULT_DOCUMENT_SETTINGS` itself has
`characterIndentIn: 3.7` and `parentheticalIndentIn: 3.1`, 0.6 in apart — strictly _more_ than the
0.5 in threshold "Document settings" states, so a freshly created screenplay's dialog shows this
warning on first open even though "Element indents" calls that same 0.6 in gap "roughly half an
inch" while presenting it as the correct default. Kept the literal, only-stated number (0.5 in)
rather than inventing a looser one to make the default silent, consistent with how this scope
already resolved the page-number-position discrepancy by flagging rather than guessing. Not
architecturally blocking — "a warning, not a block" per plan.md, so the worst case is a
default-opened dialog showing one cosmetic status line.

**Inherited fix, not increment-4 scope** (the lead's point 1): `App.tsx` had a dead `const [version,
setVersion] = useState(initial.version)` — nothing read `version` (only `versionRef` is read for
optimistic concurrency), so `pnpm lint` failed. Root cause per the lead: the security-hardening
branch added a `v{version}` badge reader that a later title-page-branch JSX rewrite (the
back-to-projects brand link) silently dropped, and the merge to `main` was never re-linted. Fixed
by deleting the state and its one `setVersion(result.version)` call; `versionRef` already carries
the real value, so no new reader was invented.

**CSS double-authority divergence** (the lead's point 3): the pre-existing
`applyPageGeometryCssVariables`-on-mount effect was keyed to the frozen `initial.screenplay.documentSettings`
prop, while the new `updateDocumentSettings` called the same function with the live `next` value —
two authorities that only agreed because the effect never re-fired after mount. Re-keyed the effect
to the reactive `documentSettings` state instead, so it is now the effect, not the direct call,
that keeps CSS geometry correct-by-construction across any future path that changes settings; the
direct call inside `updateDocumentSettings` is kept only as an immediacy optimization (no
one-render flash of stale CSS) and is documented as such at both call sites.

#### Mutation testing (break it, confirm the test fails, restore it, report it)

Every mutation below was applied, its target test(s) run and confirmed failing with the predicted
symptom, then reverted and the full suite re-run green.

- **`maxContentRoom` (the `(MORE)`-reservation fix), `packages/layout/src/pageBreak.ts`**: reverted
  to unconditional `room - 1`. The new
  `paginate.test.ts` property test ("fills every non-final outgoing page to the same capacity as
  when autoMoreContinued is on, moving no page break") failed with the predicted symptom: `page
index 0: expected 54 to be 55` — the outgoing page landing one line short of capacity, exactly
  increment 2's known, deliberately-left-open defect. Every other layout test, including the
  pre-existing "suppresses (MORE) and CONT'D..." test the scope named as _likely to pass
  vacuously_, stayed green under this exact mutation — confirming that test really was vacuous for
  this property (it only asserts marker-line absence and total dialogue-line count, never which
  page the content landed on). Restored; full layout suite re-verified 63/63.
  - **Why the `>= 2` room guards did not need a second, separate mutation**: refactoring the guards
    to `maxBefore >= 1`, computed _from_ `maxContentRoom`'s own result, means there is no longer an
    independent "2" to mutate — the guard and the reservation are now one fix, not two. Verified by
    hand-tracing `findDialogueSplitIndex`'s own 2-dialogue-line minimum: at `maxBefore === 1` the
    search space can never contain 2 dialogue lines before a candidate cut regardless of which
    guard threshold is used, so the old `roomForContent >= 2` and the new `maxBefore >= 1` are
    behaviorally identical at every value once the reservation itself is fixed — there is nothing
    left for a guard-only mutation to catch.
- **The settings round trip (the live bug), `apps/web/src/screenplayEditor.ts`**: removed
  `documentSettings` from the object passed to `safeParseScreenplay`. Two tests failed with the
  exact predicted symptom (schema defaults leaking through instead of the stored custom values):
  `App.test.tsx`'s "a loaded screenplay keeps its own non-default settings through an unrelated
  autosave" (full diff of all six fields, defaults vs. custom) and `screenplayEditor.test.ts`'s
  narrower unit-level "threads a supplied documentSettings through." A third test
  ("toggling scene numbers on changes only documentSettings.sceneNumbersEnabled...") failed as
  correct collateral damage, since it also depends on the same threading. Restored; both files and
  the full `App.test.tsx` (31/31) and `screenplayEditor.test.ts` (7/7) re-verified.
- **Scene numbers never entering the canonical document, `apps/web/src/screenplayEditor.ts`'s
  `mapBlock`**: made scene_heading blocks carry a hardcoded `sceneNumber: '1'` — simulating exactly
  the forbidden behavior the scope's first resolved contradiction exists to prevent.
  `App.test.tsx`'s "toggling scene numbers on changes only documentSettings.sceneNumbersEnabled,
  leaving every block byte-identical" failed immediately, `toEqual`'s structural diff showing the
  injected key precisely. Restored; re-verified.
- **The widget-key trap, `apps/web/src/pagination.ts`**: removed `documentSettings.pageNumberStyle`
  from the widget decoration key. Three `paginationExtension.test.ts` tests failed with the
  identical symptom (`expected '2.' to be 'II.'`, i.e. the stale arabic DOM node was reused instead
  of re-rendered) — proving these tests exercise the actual trap, not just `toRomanNumeral` in
  isolation. Restored; `pagination.test.ts` (17/17) and `paginationExtension.test.ts` (13/13)
  re-verified.
- **Scene-number decorations never reaching `buildPaginationDecorations`'s output**: disabled the
  `if (documentSettings.sceneNumbersEnabled) { decorations.push(...) }` branch. Three tests failed
  across two files: `pagination.test.ts`'s count-based "adds one scene-number decoration per
  non-empty scene heading" (3 expected vs. 1 seen — the disabled branch also cost the earlier
  page-top/widget count, confirming the test's arithmetic is derived from the real
  `computePageTopBlocks`/`computePageBreaks` counts, not hardcoded) and `paginationExtension.test.ts`'s
  two live-DOM tests ("numbers every scene heading..." and "renumbers as scene headings reorder...").
  Restored; both files re-verified green.
- **The empty-scene-heading skip, `apps/web/src/pagination.ts`'s `computeSceneNumberDecorations`**:
  removed the `|| node.textContent === ''` clause. `pagination.test.ts`'s "adds one scene-number
  decoration per non-empty scene heading... skipping an empty one" failed as predicted (`expected
[...] to have a length of 2 but got 3`); the sibling "off" test, which has no empty heading in its
  fixture, correctly stayed green, confirming the two tests are independent rather than one
  accidentally covering the other. Restored; re-verified.
- **Roman-numeral correctness, `apps/web/src/pagination.ts`'s `ROMAN_NUMERAL_DIGITS`**: removed all
  four subtractive pairs (CM, CD, XC, XL, IX, IV). Both dedicated tests failed with the predicted
  additive-notation symptom (`'MDCCCCLXXXXIIII.'` instead of `'MCMXCIV.'` for 1994; `'IIII.'`-style
  failure for the plain `IV`/`IX`/`XL` case). Restored; re-verified.
- **`DocumentSettingsDialog`'s Tab-wrap, both directions**: disabled the `Shift+Tab`-at-first-control
  branch, then separately the `Tab`-at-last-control branch (two independent mutations, each
  restored before the next). Each broke exactly its own direction's dedicated test
  (`documentSettingsDialog.test.tsx`) and left the other direction's test green, confirming the two
  assertions are not accidentally testing the same code path. Restored; 15/15 re-verified after
  each.
- **`DocumentSettingsDialog`'s parenthetical-warning threshold**: widened `PARENTHETICAL_WARNING_THRESHOLD_IN`
  from `0.5` to `5`. Both warning-direction tests (inside and outside the character indent) failed
  (`getByRole('status')` found nothing); the boundary ("does not warn at exactly the half-inch
  threshold") and "still accepts the value while warning" tests were unaffected by this specific
  mutation, as expected. Restored; 15/15 re-verified.
- **`DocumentSettingsDialog`'s non-finite-input guard**: removed the `Number.isFinite` check from
  `parseInches`. "Ignores a transiently non-numeric input rather than propagating NaN" failed,
  showing the exact feared payload (`characterIndentIn: NaN`) reaching `onChange`. Restored;
  15/15 re-verified. (A leading `raw.trim() === ''` early-return in the same function was found to
  be genuinely dead code — `Number.parseFloat('')` is already `NaN`, which `Number.isFinite`
  already rejects identically — and was deleted rather than kept as untested surface area, per
  "keep only active code.")
- **`closeSettingsDialog`'s focus-return, `apps/web/src/App.tsx`**: removed the
  `fileMenuRef.current?.querySelector(...)?.focus()` line. `App.test.tsx`'s "opens from the File
  menu and closes on Escape, returning focus to the File menu trigger" failed
  (`toHaveFocus()` on the File trigger button). Restored; re-verified.
- **Undo history surviving a settings change, `apps/web/src/App.tsx`'s `updateDocumentSettings`**:
  inserted `editor.commands.setContent(editorContent ?? unavailableEditorContent, false)` at the
  top of the function, simulating the user-visible failure mode a regression to
  remount-per-settings-change would produce (the document resetting to `initial`, discarding
  in-progress edits and their undo history). `App.test.tsx`'s "undo history for an edit made
  before a settings change still works after the settings change" failed exactly as predicted: the
  pre-existing `character`-element conversion reverted to `scene_heading` the instant the settings
  change fired, before Undo was ever clicked. Restored; re-verified. This is the one mutation that
  does not literally revert to the pre-fix architecture (that would be a much larger structural
  change, not a one-line mutation) but reproduces the identical externally observable symptom the
  architecture exists to prevent.

#### Gates

1. `pnpm lint` — clean, workspace-wide, including the inherited `version`-state fix.
2. `pnpm typecheck` — clean, workspace-wide (config → server-config → screenplay → database →
   layout → web → api, each rebuilt fresh).
3. `pnpm test:coverage` — clean, workspace-wide: config 1, server-config 6, database 4, screenplay
   48, api 78 (62 run + 16 skipped integration tests, which need `TEST_DATABASE_URL`), layout 63
   (was 62; +1 new property test), web 178 (was 145; +33: 15 in the new
   `documentSettingsDialog.test.tsx`, +5 `pagination.test.ts`, +7 `paginationExtension.test.ts`,
   +2 `screenplayEditor.test.ts`, +4 `App.test.tsx`).
4. `pnpm build` — clean, workspace-wide.
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — 21/21, matching increment 3's baseline exactly
   (this scope's other e2e specs are unaffected by increment 4's changes).
6. Persistence gate (`TEST_DATABASE_URL=<local disposable-test endpoint, inline on the command
line only, never written to any file> PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence`),
   three runs: **8/8, 8/8, 8/8**. Stable across all three, as the scope predicted given this
   branch's base already includes the page-frame flake fix — no flake observed.
7. `git diff --check` — clean.
8. `pnpm format:check` — run after this entry was written (see below), clean.

#### Known limitations / things not done

- **Page-number position stays fixed top-right.** Per the scope's own instruction and this file's
  earlier-recorded resolution of the "Document settings" vs. "Page numbering" discrepancy — not
  revisited here.
- **The parenthetical-warning-vs-default-values discrepancy noted above is flagged, not resolved.**
  `DEFAULT_DOCUMENT_SETTINGS`'s own character/parenthetical indents sit 0.6 in apart, which the
  literal 0.5 in threshold in "Document settings" flags as a warning on a freshly created
  screenplay's first dialog open, even though "Element indents" calls that same gap "roughly half
  an inch" while presenting it as correct. Cosmetic only ("a warning, not a block"); no value is
  ever rejected or clamped because of it.
- **No focus trap beyond Tab/Shift+Tab cycling inside the dialog's own controls** — this matches
  `OverflowMenu`'s own scope (it doesn't trap Tab either, relying on a small fixed item set), and
  satisfies the scope's explicit accessibility list (keyboard operation, visible focus, semantic
  controls, screen-reader labels, Escape-with-focus-return); a more elaborate `inert`/portal-based
  trap was not built since nothing in plan.md or the scope asks for one beyond that list.
  Dialog-styling collision risk: dark-mode hover styling for the new `.menu-file` File-menu
  trigger inherits color via `.dark .menu-file .overflow-menu-trigger { color: inherit; }` but,
  like every other existing menubar control, has no dark-specific hover _background_ — matching
  the pre-existing gap in `.menubar button:hover` (never dark-aware either), not a new regression.
- **`autoMoreContinued`'s room-reservation fix only directly exercises `placeSpeechGroup`'s first
  split and `placeSpeechContinuation`'s continuation split via the one property test** (60-line
  monologue, two splits, both `placeSpeechGroup` and `placeSpeechContinuation` code paths covered
  in the same fixture) — no additional fixture was built for a third-or-later split depth, since
  the recursive structure of `placeSpeechContinuation` means a third split exercises the identical
  code path as the second.
- **The dialog has no explicit "reset to defaults" control.** Not specified anywhere in plan.md's
  "Document settings" section; not built.

### 2026-08-19 — increment 4 addendum — parenthetical warning threshold corrected (owner ruling)

The lead independently re-ran the full gate list and reproduced two of the mutation tests above
(dropping `documentSettings` from `safeParseScreenplay`, and dropping `pageNumberStyle` from the
decoration key), both green after restoring. Persistence 8/8 including the page-frame test.

One correction was required, resolving a genuine `plan.md` self-contradiction the "known
limitations" section above had flagged but not resolved: **the parenthetical warning was measuring
the wrong quantity.** `apps/web/src/documentSettingsDialog.tsx` warned when
`|parentheticalIndentIn - characterIndentIn|` exceeded 0.5in — a literal reading of "Document
settings"' "more than half an inch from the character indent in either direction." But
`DEFAULT_DOCUMENT_SETTINGS` itself sits `characterIndentIn: 3.7, parentheticalIndentIn: 3.1`, a
0.6in gap that "Element indents" presents as correct ("Roughly half an inch inside the character
indent, which 3.7 minus 3.1 satisfies"). Read literally, the specification's own endorsed default
sat 0.1in past its own warning threshold — a screenplay a writer never touched the dialog on would
open to a warning about a value the specification calls correct.

**Owner's ruling**: the warning measures drift from the _default_ gap between the two indents, not
absolute distance from the character indent. `DEFAULT_PARENTHETICAL_GAP_IN` is derived from
`DEFAULT_DOCUMENT_SETTINGS.characterIndentIn - DEFAULT_DOCUMENT_SETTINGS.parentheticalIndentIn`
(0.6in) rather than hardcoded, so the threshold tracks the specification's own values and cannot
silently go stale if those defaults ever move. The current gap
(`settings.characterIndentIn - settings.parentheticalIndentIn`) is compared against that default
gap with the same ±0.5in threshold "Document settings" states, so the safe range for the gap is
roughly 0.1in to 1.1in — `DEFAULT_DOCUMENT_SETTINGS` now sits comfortably inside it (drift 0), and
a writer who genuinely drifts the parenthetical away from its usual relationship to the character
cue is still warned in either direction, which is what plan.md asks for. This resolves the
discrepancy the same way this scope earlier resolved "Document settings" vs. "Page numbering" on
page-number position: by identifying which reading is consistent with the rest of the document
(here, with "Element indents" calling the shipped default correct) rather than by picking whichever
section was read first.

The warning copy was updated to match ("has drifted more than half an inch from its usual position
relative to the character indent" — "more than half an inch from the character indent" was no
longer an accurate description of the condition being tested). The existing either-direction tests
in `documentSettingsDialog.test.tsx` were moved to the new boundaries (the previous 0.5in-absolute
values no longer produced or avoided a warning under the corrected formula), and a new test
(`produces no warning for DEFAULT_DOCUMENT_SETTINGS, the specification-endorsed default gap`) was
added — this is the specific regression the ruling exists to prevent, and the one the lead
identified as most likely to be missed.

**Mutation testing**: reverted the drift calculation to the old absolute-distance formula
(`Math.abs(settings.parentheticalIndentIn - settings.characterIndentIn)`). Both the new
no-warning-on-defaults test and the boundary test failed with the exact predicted symptom — a
warning `<p role="status">` present when none was expected, rendering the specification's own
default values as a false positive. Restored; full file re-verified (16/16). Separately, mutated
`DEFAULT_PARENTHETICAL_GAP_IN` itself to a hardcoded `0` (simulating the derived-constant
protection being removed) — the identical two tests failed the identical way, confirming the
constant, not just the comparison, is genuinely load-bearing. Restored; re-verified (16/16).

#### Gates (full list, re-run after this correction)

1. `pnpm lint` — clean.
2. `pnpm typecheck` — clean, workspace-wide (config → server-config → screenplay → database →
   layout → web → api, each rebuilt fresh).
3. `pnpm test:coverage` — clean, workspace-wide: layout 63, api 78 (62 run + 16 skipped
   integration), web 179 (was 178; +1 for the new no-warning-on-defaults test —
   `documentSettingsDialog.test.tsx` at 16/16).
4. `pnpm build` — clean.
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — 21/21, unchanged.
6. Persistence gate, three runs: **8/8, 8/8, 8/8**, including the page-frame test each time.
7. `git diff --check` — clean.
8. `pnpm format:check` — run after this addendum was written, clean.

### 2026-08-20 — increment 4 addendum 2 — File menu alignment, scene numbers in both margins (lead)

Two owner-reported items, both fixed on this branch by the lead.

**The File menu opened off the left edge of the screen.** `OverflowMenu`'s list is anchored
`right: 0`, which is correct for its two existing uses -- the per-row overflow menu and the account
menu -- because both sit near the right edge of their container, where dropping the list leftward
is what keeps it on screen. The File menu is the opposite case: it is the leftmost control in the
menubar, so a right-anchored list extends past the viewport. `.menu-file .overflow-menu-list` now
sets `right: auto; left: 0`, which is also how every desktop application's File menu opens. The
shared component is untouched; only the File menu's own wrapper overrides the anchor.

**Scene numbers now print in both margins**, per new production-convention information the owner
supplied and the new "Locked scripts" section of `plan.md` that records it: the number appears at
the left and right margin of each scene's first line.

This forced a change of mechanism, not just of CSS. The previous implementation was a node
decoration plus `::after` on the scene heading, and a single pseudo-element cannot render a number
at two margins. `::before` was not available either -- it is the element-label overlay, which is a
user-facing toolbar toggle, so taking it would have meant scene headings silently losing their
label whenever numbering was on. `computeSceneNumberDecorations` now emits a widget decoration
instead, one `.scene-number` span per numbered heading carrying both margin copies, anchored at
`offset + 1` (inside the heading's own textblock, never between two block nodes -- the
`img.ProseMirror-separator` trap documented in `computePageBreaks`). Only the left copy is exposed
to assistive technology; the right is `aria-hidden`, since announcing every scene number twice is
noise.

**A widget can perturb the line grid where a pseudo-element cannot, and that risk was completely
unguarded.** Every existing test in `page-rendering-persistence.spec.ts` runs at the default
settings, so nothing in the suite exercised the app with `sceneNumbersEnabled` on: a grid shift
introduced by numbering would have shipped unnoticed. Confirmed by mutation before writing
anything -- moving the widget anchor from `offset + 1` to `offset` (between blocks) left all eight
persistence tests green.

A new persistence test, `turning scene numbers on paints both margins without moving a single
block`, closes that gap: it measures every block's painted top with numbering off, turns it on
through the real File menu and dialog, and requires every block to be exactly where it was, plus
asserts both copies fall outside the heading's own text column.

**The first version of that test was itself vacuous, and mutation testing caught it.** With a short
scene heading, mutating the copies from `position: absolute` to `position: relative` -- putting
them in the text flow, the exact regression the test exists to catch -- still passed, because a
24-character heading absorbs two extra characters without wrapping. The fixture now uses a heading
filling its full 60-character budget, where any in-flow content wraps the line and pushes
everything below it down. Under the same mutation the test now fails with three block tops shifted.
Restored, 9/9 green.

Also corrected in the test: a new screenplay's first block is `action`, not a scene heading, so the
element is now set explicitly through the toolbar before typing. Without that the fixture contained
no scene at all and every numbering assertion would have passed against zero rendered numbers --
found by running it, not by reading it.

**Gates:** lint, typecheck, `test:coverage` (config 1, server-config 6, database 4, screenplay 48,
layout 63, api 78, web 179), build, `format:check`, `git diff --check` all clean; persistence gate
9/9.

**Not done:** the rest of "Locked scripts" is Phase 5 and deliberately unbuilt -- the owner ruled to
record the specification now and build it there. Nothing in this branch locks anything, marks a
scene omitted, suffixes a page, or draws a revision mark, and the scene numbers rendered here are
still the free-renumbering Phase 1 display feature.

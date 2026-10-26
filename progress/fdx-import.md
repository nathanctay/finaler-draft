# FDX import

Branch `feature/fdx-import`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/fdx-import`,
created from committed `main` (`cdd43b5`).

## Why this scope exists

`plan.md`'s "Importing untrusted files": FDX import is the largest untrusted-input surface in the
product, because it is the one place a stranger's file reaches this codebase. `progress/fdx-export.md`
deliberately deferred it ("FDX import is deliberately a later slice... import means accepting
arbitrary third-party files containing features we cannot represent, which needs its own
fail-closed policy decisions"), and `progress/canonical-round-trip.md` built the identity property
that becomes load-bearing the moment import exists. This slice is that later slice.

## Architecture followed as given, not redesigned

Every decision in the brief's "Architecture, already decided" section was followed as written:
parsing is client-side only (no server-side XML parsing anywhere in this diff); there is no new API
endpoint (`apps/web/src/api.ts`'s existing `createScreenplay` is reused unchanged); import creates a
new screenplay, never replacing one; the entry point is beside "New screenplay" on the project
screen; and the DOCTYPE/DTD rejection happens as one string-level rule applied before any parser
sees the input, independent of whatever grammar the parser itself does or does not implement.

## The parser: hand-written, not `DOMParser` and not a third-party library

`packages/fdx/src/xmlParser.ts` is a new, minimal, hand-written XML parser scoped to exactly the
subset of XML a Final Draft document uses -- elements, attributes, text, comments, CDATA,
processing instructions, the five predefined entities, and numeric character references. It has
no DOCTYPE, ENTITY, or external-reference grammar _at all_.

**Why not `DOMParser`.** The brief's own architecture section says `packages/fdx` must stay pure --
no DOM -- so a future server-side export caller (which already exists as a documented intent for
`screenplayToFdx`) could reuse the same mapping, and so the whole package stays unit-testable in
Node without a browser. `DOMParser` would have forced an injected-parser seam (`fdxToScreenplay(xml,
{ domParserFactory })`) just to keep the package Node-testable, which is exactly the "injected-parser
seam" tradeoff the brief flagged as a legitimate but deliberate choice to make -- and even after
making it, the brief's own requirement still applies: "browser `DOMParser` does not resolve external
entities, but that is a property of the environment, not a decision that has been made, so it must
be asserted in a test." Writing the parser from scratch sidesteps needing that assertion at all: this
module performs no I/O of any kind, which is verifiable by reading it rather than by testing an
environment property that could change under a browser vendor.

**Why not a third-party XML library.** Reaching for `fast-xml-parser`, `@xmldom/xmldom`, `sax`, or
similar would mean trusting that library's own entity/DTD handling -- several of these have shipped
real CVEs in exactly this area, requiring a non-default configuration flag to avoid, which is the
precise "trust the documentation" risk the brief says this slice must not take. A hand-written
parser makes every security property in this paragraph structural rather than configured: there is
no flag to misconfigure, because the vulnerable feature (DOCTYPE processing, custom entity
expansion, external-entity resolution) was never implemented in the first place.

**The tradeoff, stated plainly.** This parser does not support XML namespaces, arbitrary
processing-instruction handling beyond skipping, or anything outside the subset FDX actually uses.
That is acceptable because the only input this parser is ever asked to parse is a Final Draft
document, not arbitrary XML -- and it is exercised against the real byte-for-byte contents of
`packages/fdx/fixtures/final-draft-13-reference.fdx` (parses cleanly end to end; see
`xmlParser.test.ts`'s "parses the real FD13 reference fixture into a tree with no error").

## Security guards, each with the test that holds it and the mutation that killed it

Every guard below was mutated (the exact code change is a single line each), the affected test
suite was run, the predicted test(s) failed with the predicted symptom, and the file was restored
and `diff`-verified identical to the pre-mutation copy before moving to the next guard.

1. **DOCTYPE/DTD rejected before parsing** (`rejectDoctypeOrDtd`, called as the second line of
   `parseFdxXml`, before a single character is tokenized). Held by
   `xmlParser.test.ts`'s "security guards" suite (5 tests: a plain DOCTYPE, a bare ENTITY with no
   DOCTYPE wrapper, a `SYSTEM "file:///etc/passwd"` XXE payload, a parameter-entity XXE payload,
   and a ten-level billion-laughs expansion) and `import.test.ts`'s `"doctype_rejected"` error-
   taxonomy test. **Mutation**: commented out the `rejectDoctypeOrDtd(source);` call inside
   `parseFdxXml`. **Result**: exactly those 6 tests failed (5 in `xmlParser.test.ts`, 1 in
   `import.test.ts`); every other test, including `rejectDoctypeOrDtd`'s own direct-call test,
   stayed green, confirming the guard function itself is correct and the failure is specifically
   about it not being wired into the parse path.
2. **No entity expansion, independent of the DOCTYPE guard** (`decodeEntities` only recognizes the
   five predefined entities and numeric character references; anything else is a parse error).
   Held by "rejects an unknown (non-predefined) entity reference, independent of the DOCTYPE
   guard" -- deliberately using a payload with _no_ DOCTYPE at all, to prove this is a second,
   independent layer. **Mutation**: replaced the `throw` in the `else` branch with
   `out += ''` (silently drop unknown entities instead of refusing them). **Result**: exactly that
   one test failed. This is the test that proves "billion laughs" has no grammar production to
   exploit here even if the DOCTYPE guard were somehow bypassed: there is nothing in this module
   that can ever define a custom entity, so there is nothing to expand.
3. **Input size bounded before parsing** (`MAX_FDX_SOURCE_CHARACTERS = 10,000,000`, checked as the
   first line of `parseFdxXml`). Held by "bounds input size before parsing" and the matching
   `import.test.ts` `"too_large"` test. **Mutation**: `if (false && source.length >
MAX_FDX_SOURCE_CHARACTERS)`. **Result**: exactly those 2 tests failed.
4. **Element nesting depth bounded** (`MAX_FDX_ELEMENT_DEPTH = 100`, checked incrementally before
   each `stack.push`, never recursively). Held by "bounds element nesting depth, failing as soon
   as the limit is exceeded rather than at the end of input". **Mutation**: `if (false &&
stack.length >= MAX_FDX_ELEMENT_DEPTH)`. **Result**: exactly that one test failed.
5. **Total element count bounded** (`MAX_FDX_ELEMENT_COUNT = 200,000`, defense in depth against a
   wide-but-shallow document neither of the above two guards catches). Held by "bounds total
   element count, rejecting a wide-but-shallow document". **Mutation**: `if (false && elementCount
   > MAX_FDX_ELEMENT_COUNT)`. **Result**: exactly that one test failed.
6. **No network request, ever.** This module performs no I/O of any kind -- verified by reading it
   (there is no `fetch`, no `readFile`, no `require`), and asserted directly in "rejects an XXE
   payload using a SYSTEM file:// external entity, never resolving it": a `vi.spyOn(globalThis,
'fetch')` records zero calls while parsing a `file:///etc/passwd` XXE payload. (`vi.spyOn(fs,
'readFileSync')` was attempted for the filesystem half of the same assertion and is not
   possible in this Vitest/Node ESM setup -- "Cannot redefine property: readFileSync", because
   Node's built-in module namespace is non-configurable under ESM; this is recorded in the test's
   own comment rather than silently dropped.)
7. **Mapping safety nets, not strictly "parsing" guards but equally load-bearing** (in
   `packages/fdx/src/import.ts`):
   - **Dual-dialogue column split only resolved when unambiguous** (exactly two `Character`-typed
     paragraphs; otherwise refused as `'unmapped_content'`). Held by "refuses a dual-dialogue block
     whose column split is ambiguous (not exactly two character cues)". **Mutation**: `if (false &&
characterIndices.length !== 2)`. **Result**: exactly that one test failed (the unambiguous,
     exactly-two-cue case was and remained correctly decoded).
   - **The assembled screenplay is independently re-validated by `screenplaySchema` before being
     returned** (`safeParseScreenplay(candidate)`), which is the backstop for anything earlier in
     the mapping does not itself check -- e.g. two FDX paragraphs sharing one `id` attribute, which
     nothing before this point rejects. **Mutation**: `if (false && !validated.success)`.
     **Result**: exactly the dedicated duplicate-id test failed, proving this is a real, reachable
     check, not dead code sitting after every path that could fail had already failed.
   - **A malformed or missing `id` attribute never reaches `screenplaySchema` unchecked**
     (`reuseOrMintId`'s `UUID_PATTERN.test(rawId)` check). **Mutation**: `rawId ?? crypto.randomUUID()`
     (drop the shape check, keep only the undefined check). **Result**: the directly-targeted test
     failed, _and_, instructively, a second, unrelated test failed with it ("recovers
     sceneNumbersEnabled and autoMoreContinued exactly") -- that test's fixture uses the shared
     `testFixtures.ts` shorthand id `'a0'`, which is not UUID-shaped and had been silently relying
     on this exact fallback to produce a valid screenplay. Both failures are reported here because
     a mutation's full blast radius, not just the test written to target it, is what a mutation
     report is supposed to show.
8. **UI reachability**: `apps/web/src/routes/projects/$projectId/index.tsx` translates
   `FdxImportError.code` to a specific, user-facing message rather than showing the package's raw,
   developer-facing `.message`. **Mutation**: replaced the translation ternary with a bare
   `throw error;`, so the raw internal message (e.g. literally quoting `"<!DOCTYPE"`) would reach
   the writer instead. **Result**: exactly the 6 tests asserting the translated strings failed
   (the DOCTYPE test, the not-xml test, and the four `it.each` error-code tests); the tests that
   don't depend on the exact wording (the successful-import tests, the 402 test, the generic
   non-Error fallback test) stayed green, confirming the translation layer specifically, not the
   control's wiring generally, is what the mutation broke.

No guard was found to pass vacuously (i.e., still green with the guard removed). Every mutation
above was reverted and `diff`-verified identical to the pre-mutation file before the next one.

## Mapping

Built and checked against `packages/fdx/fixtures/final-draft-13-reference.fdx` directly, per the
same rule `progress/fdx-export.md` established for export: a format whose value is interoperability
cannot be verified against second-hand descriptions of it.

**Mapped**: scene heading (including the `Number` attribute as `sceneNumber`), action, character,
dialogue, parenthetical, transition, shot, `dual_dialogue` (see the column-split caveat above),
`page_break` (synthesized from a following paragraph's `StartsNewPage="Yes"`, the exact inverse of
how `screenplayToFdx` emits it), the title page (`title`, `credit`, `authors`, `source`,
`draftDate`, `contact`), and document settings (`characterIndentIn`, `parentheticalIndentIn`,
`sceneNumbersEnabled`, `autoMoreContinued`).

**Never silently dropped -- but reported rather than refused.** See "The policy reversal" below:
this started as a hard refusal of any file containing an unmapped element, which made the project's
own genuine reference file un-importable. It now does three different things depending on the
element:

- `General` is **mapped to `action`**. Faithful, not a guess: in the reference fixture a
  `Type="General"` paragraph carries `LeftIndent="1.50"`, the exact indent `Action` uses, with no
  distinguishing style or alignment -- the two render identically.
- `Outline 1/2/3`, `Summary`, `Beat`, `Sequence`, `New Act`, `End of Act`, `Cast List` and `Note`
  are **skipped and tallied**, then shown to the writer for confirmation before anything is
  created. These are Final Draft's outline and structure content, not screenplay body.
- Anything whose `Type` is in **neither** table still throws `'unmapped_content'` and refuses the
  whole file. This is the property that keeps the relaxation safe: an unrecognized future Final
  Draft construct is refused, never guessed into "probably skippable." It has its own test, and
  mutating the allowlist check into a catch-all (`!(typeAttr in FDX_TYPE_TO_BLOCK_TYPE)`) kills
  three tests across two packages.

An ambiguous dual-dialogue column split, and a title page whose paragraph sequence does not match
the grammar below, both still refuse outright.

Nothing is dropped silently, which was the real requirement: the writer is shown every skipped type
with its count and consents before a screenplay exists. The genuine reference file now imports --
11 blocks (2 transition, 1 scene heading, 2 character, 1 parenthetical, 1 dialogue, 3 action,
1 shot), with 9 types tallied as skipped (`Cast List`, `New Act`, `Sequence`, `End of Act`,
`Summary`, `Outline 1`, `Outline 2`, `Outline 3`, `Note`, one each) and its title page decoded.
That it parses every surrounding Final Draft construct along the way (SmartType, Revisions, Macros,
Actors, Cast, TagData, DisplayBoards) is what proves the parser handles a real document and not
only hand-crafted fixtures.

**The title-page grammar, and why it is safe rather than a guess.** `screenplayToFdx`'s
`titlePageLines` places each optional field behind its own _fixed_ blank-paragraph-count gap (3
before credit, 2 before authors, 4 before source, 3 before draft date, 3 before contact) that is
only ever pushed when that field is actually present -- so, except for the one unconditional
17-blank run before the title itself, no two fields' gaps can ever merge into an ambiguous sum.
`decodeTitlePageContent` is the literal inverse of that state machine: it tries each field in the
fixed order with its own exact gap and shape, and if any paragraph does not match, the whole title
page is refused rather than guessed at. This was verified against two independent, non-synthetic
sources, not just against this package's own exporter: `screenplayToFdx`'s own output (the
round-trip test), and the byte-for-byte `<TitlePage>` block copied directly out of
`final-draft-13-reference.fdx` -- which turns out to use the _identical_ gap structure, because
that reference file is where those four constants were originally measured from. A title page
outside this exact shape (title absent while a later field is present, a non-standard layout) is a
real, stated limitation: it fails closed rather than importing an approximation.

## The round-trip property, stated precisely -- and a correction to this scope's own brief

The brief states: "Block ids cannot survive a round trip -- FDX has no id attribute." **This is
incorrect for body blocks, confirmed directly against the ground-truth reference file**, and the
correction matters enough to state plainly rather than quietly work around: `final-draft-13-
reference.fdx` gives _every_ `Content` paragraph a UUID `id` attribute (e.g. `<Paragraph ...
Type="Scene Heading" id="4988a831-0c42-45ec-baaf-5da902f6fd47">`), and `screenplayToFdx`'s own
`bodyParagraph` deliberately writes the canonical block's own id into that exact attribute (its own
doc comment: "this takes that identity rather than inventing a parallel one"). `fdxToScreenplay`
reuses that id when it is genuinely UUID-shaped (`reuseOrMintId`), so **body-block ids round-trip
exactly, not "modulo ids."** This is tested directly ("reproduces every body block id exactly...
correcting this scope's own premise", `import.test.ts`).

The precise statement, derived from reading both directions of the mapping rather than assumed:

**Regenerated on every round trip** (FDX genuinely has nowhere to store these):

- `screenplay.id` -- no FDX element or attribute anywhere represents the whole document's identity.
- Every `titlePages[].id` -- `<TitlePage>` carries no id attribute at all.
- `dual_dialogue.left.id` / `.right.id` -- `screenplayToFdx` never writes the column _container's_
  own id anywhere; only the outer `dual_dialogue` block's id and each inner column block's id
  survive.
- `page_break.id` -- `page_break` has no FDX element of its own at all; it is inferred purely from
  `StartsNewPage="Yes"` on the paragraph that follows, so there is nowhere its id could have lived.

**Not recoverable, and falls back to `DEFAULT_DOCUMENT_SETTINGS`** (confirmed by a dedicated test
using non-default values on both sides of this split, `"documentSettings: a documented, tested
limitation of this round trip"`):

- `documentSettings.parentheticalWidthIn` -- `screenplayToFdx` encodes a parenthetical's _left
  indent_ per instance but never its width; nothing in the file carries this value.
- `documentSettings.pageNumberStyle` -- never written by `screenplayToFdx` at all
  (`progress/fdx-export.md`: "`documentSettings` is not mapped into FDX page-layout settings").

**Not recoverable when it differs from the title page's own title** (confirmed directly by the
existing `screenplayFixture`, which deliberately sets `title: 'The Last Stop'` while its title
page's own `title` is `'THE LAST STOP'`):

- `screenplay.title` (the organizational/listing title) -- FDX has only one title field (the
  printed title page's), so import always derives the top-level title from `titlePages[0].title`.
  A screenplay whose listing title and title-page title genuinely differ loses that distinction on
  import. Tested explicitly, not left as an unstated side effect of the main round-trip assertion.

**Everything else round-trips exactly**: every body block's own id and text, `sceneNumber`,
`dual_dialogue`'s own block id and every column block's id and text, every title-page field's
_value_, `characterIndentIn`, `parentheticalIndentIn`, `sceneNumbersEnabled`, and
`autoMoreContinued`.

Two further things do **not** round-trip, but for reasons that predate and are outside this slice,
already recorded in `progress/fdx-export.md`: **`annotations`** (never written to FDX by
`screenplayToFdx` at all -- "never read... at all", not filtered), and a **trailing or consecutive
`page_break`** (collapses or vanishes on export, a documented export limitation). The round-trip
fixture in `import.test.ts` is `screenplayFixture` with `annotations: []` and one extra trailing
block so its `page_break` is no longer trailing -- the minimum change needed to exercise the
property this slice actually owns, with both exclusions named in the test's own comment rather than
silently worked around.

The test itself (`"reproduces the fixture exactly, modulo the ids and the top-level title FDX has
no attribute for"`) builds its expected value by substituting only the six fields proven unstable
above with the decoded result's _own_ values (each independently asserted to be a freshly minted
UUID distinct from the original, or, for the title, the title page's own value), then asserts a
full `toEqual` against everything else -- so a future change that drops or alters any other field
fails this test, not a hand-picked subset of fields someone remembered to check.

## What could not be verified -- stated plainly

- **Whether an imported screenplay actually opens in the real editor was not verified end to end**,
  because that needs a server, a Yjs collaboration connection or local seed, and (for the
  create-screenplay API call itself) PostgreSQL, none of which are available on this machine (see
  "Gates that did not run" below). The web-layer tests mock `fetch` and assert that
  `router.navigate` is _called_ with the right params; they do not render the destination route or
  mount a real editor.
- **A specific, real consequence of this gap was found by reading the code, not by assumption, and
  is worth the owner's attention**: `packages/screenplay-editor/src/index.ts`'s
  `editorContentFromScreenplay` throws ("This screenplay contains features that are not editable in
  the text-block editor") for any screenplay containing `dual_dialogue`, `page_break`, more than one
  title page, or an annotation -- and `App.tsx` catches exactly that by falling back to an
  unseeded, read-only `Y.Doc` (`initialContent === undefined` branch, already covered by its own
  existing tests, e.g. `App.test.tsx`'s "renders unsupported persisted snapshots as read-only").
  **This import slice can and does produce `dual_dialogue` and `page_break` blocks from a genuine
  Final Draft file** (the round-trip fixture exercises both). The consequence: **a writer who
  imports a real script using dual dialogue or a forced page break will see the import succeed,
  but the screenplay will open read-only, not editable, until the editor itself gains support for
  those features.** This is not a defect introduced here -- the read-only fallback is pre-existing,
  deliberate, and already tested on its own -- but it is a real, user-facing interaction between two
  already-shipped pieces of this product that this slice newly makes reachable, and the owner
  should decide whether import should warn about it explicitly (e.g. "this script uses dual dialogue
  and will open read-only") rather than importing silently into a surprise.
- **The exact gzip contribution of `@finaler-draft/fdx` to the web app's dynamically-imported
  chunk was not isolated.** `pnpm check:bundle-budget` passed (see below), which is the actual gate,
  but the build output does not name a chunk obviously corresponding to "the fdx package alone" to
  quote a standalone number for.

## UI

`apps/web/src/routes/projects/$projectId/index.tsx`: an "Import FDX…" button beside "New
screenplay", triggering a hidden `<input type="file" accept=".fdx">`. Mirrors "New screenplay"
exactly on the two points the brief asked for:

- **Authorization/entitlement**: no client-side role check of its own, for the same reason "New
  screenplay" has none -- the server's `createScreenplay` enforces `canEdit(membership.role)`
  identically for both, since creating a screenplay by import is the same act as creating one by
  hand. A free-tier 402 (`EntitlementLimitError`) surfaces through the identical `upgrade-banner` +
  `UpgradeDialog` pattern "New screenplay" already uses.
- **Errors**: the existing `field-error`/`role="alert"` pattern (`DeletedRow`'s "Delete failed. Try
  again." is the precedent), showing `FdxImportError.code` translated to a specific, actionable
  sentence (`describeFdxImportFailure`) rather than the package's developer-facing message.

**Title**: `imported.titlePages[0]?.title`, trimmed, clamped to the route's 200-character bound
(`apps/api/src/projects.ts`'s `projectTitle` -- stricter than `screenplaySchema`'s own 250);
falling back to the filename with `.fdx` stripped, and finally to `'Untitled Screenplay'` if both
are empty. The title page's own (possibly absent) `title` field is never backfilled with the
filename -- only the organizational/listing title needs a fallback; fabricating title-page content
that was not in the file would be a fidelity violation of exactly the kind this slice is supposed
to prevent elsewhere.

**Must not freeze the interface with no feedback**: the two independent mutations
(`create`/`importFdx`) each track their own local error state via `onError`, matching
`sharingDialog.tsx`'s established pattern for a screen with more than one write -- necessary here
because this repository's `useMutation` test-double (`routeHarness.tsx`) writes every mutation's
error into one shared slot regardless of which mutation rejected, which would otherwise make two
independent controls' errors bleed into each other in tests (and the mock's bleed-through is
itself evidence of why `sharingDialog.tsx` moved off `.error` originally). The button shows
"Importing…" and disables itself while `importFdx.isPending`; the mutation function awaits one
`setTimeout(resolve, 0)` tick after reading the file and before the synchronous parse, so that
state has a chance to paint first. **A Web Worker was considered and rejected**: the size bound
alone (10M characters) means a worst-case file is still parsed by a single-pass, non-recursive
tokenizer with no backtracking, which is not the kind of cost a worker is proportionate to for a
"few hundred kilobytes, generously up to low single-digit megabytes" real screenplay; the
one-tick yield is the cheaper fix for the actual symptom (paint starvation on a fast synchronous
call), not a true long-running computation that would need to be moved off the main thread.

## Bundle-budget impact -- and a hole this slice opened in the check itself

`@finaler-draft/fdx` and `@finaler-draft/screenplay-editor` are both reached only through `await
import(...)` inside `parseFdx`'s `mutationFn`, mirroring how `App.tsx` already lazily imports the
FDX package for _export_ (`triggerFdxDownload`). The entry chunk is unchanged at **111.95 kB** gzip
against its 120 kB budget -- this route statically imports neither package.

**But the editor budget silently stopped measuring the editor, and that had to be fixed before this
gate could be believed.**

Dynamically importing `@finaler-draft/screenplay-editor` from the projects route (the read-only
probe) makes that package shared between two dynamic entry points, so Vite extracts it into a
sibling chunk. `App-*.js` fell from 145.30 kB gzip to **23.45 kB** with no code removed, and
`check:bundle-budget` reported that as a comfortable pass -- because it measured exactly one
filename. About 120 kB of editor code had dropped out of a 200 kB budget.

`scripts/check-bundle-budget.mjs` now measures a role's **transitive static-import closure** minus
the entry chunk's own closure, rather than a single file, and itemizes the members in its output.
Static imports only: `dynamicImports` are separate lazy boundaries, which is the whole reason the
editor has a budget distinct from the entry's. Subtracting the entry's closure keeps the number
meaningful -- those bytes are already in the browser before the editor is opened.

Measured the same way on both sides, the real figures are:

|                     | editor closure, gzip | what the old single-file check reported |
| ------------------- | -------------------- | --------------------------------------- |
| `main` at `cdd43b5` | **162.78 kB**        | 145.30 kB                               |
| this branch         | **165.00 kB**        | 23.45 kB                                |

So this slice's true cost to the editor is **+2.22 kB**, not the 120 kB saving the old check
implied -- and the old check was _already_ under-reporting by about 17 kB on `main`, where it never
counted `api`, `OverflowMenu` or `navigatorPanel`. This slice did not create that flaw; it made it
large enough to notice. The fix is therefore an improvement to the gate for every branch, not a
local workaround, and the 200 kB budget now has 35 kB of genuine headroom rather than an unknown
amount.

On this branch the closure is `App` 23.45 + `index` 123.53 + `api` 14.99 + `navigatorPanel` 2.22 +
`OverflowMenu` 0.81 kB.

## The policy reversal, and why it is recorded here

**The original strict policy was reversed by owner decision. Do not restore it.**

As first built, any FDX element without a canonical equivalent refused the entire import. That
followed this scope's own instruction that unmapped content must never be silently dropped, and the
reasoning was sound -- but the consequence was not: **the project's own genuine Final Draft 13
reference file could not be imported.** It threw on `Type="General"` at content position 7.
`General` is Final Draft's ordinary plain paragraph, not an exotic construct, so refusing it would
have made a large share of real imports fail outright.

The owner's decision was "map General, report skips", with the confirmation step below approved as
the shape of the reporting. The requirement that nothing be dropped silently is still met -- it is
reported and consented to, rather than fatal. The narrower property that actually needed protecting
is that an _unrecognized_ type stays fatal, and that is now its own tested invariant.

The lesson worth keeping: "fail closed" was the right instinct and the wrong granularity. Refusing
a whole screenplay because it contains an outline note is not safety, it is unusability -- the
safety that mattered was never guessing at content, and consent covers that at far lower cost.

## The confirmation step

A successful parse creates nothing. `fdxToScreenplay` returns `{ screenplay, skipped }`, and the
route opens `FdxImportConfirmDialog` showing the block count, every skipped type with its count,
and -- when it applies -- a warning that the result will open read-only. `api.createScreenplay` is
reachable only through that dialog's "Import anyway" button.

**Cancelling creates nothing by construction, not by a check.** The dialog makes no API call of its
own; `onCancel` clears `pendingImport` and does nothing else, and the dialog only renders while
that state is set. Mutating `onCancel` into `commitImport.mutate()` kills the test that holds this.

**The read-only warning calls the editor's own check rather than restating it.** Whether an
imported screenplay will open read-only is computed by actually invoking
`@finaler-draft/screenplay-editor`'s `editorContentFromScreenplay` in a `try`/`catch`. It therefore
cannot drift from the editor's real behaviour, because it _is_ that behaviour. Hardcoding the flag
to `false` kills the end-to-end test that imports a genuine `dual_dialogue` file.

This closes open question 1 from the first draft of this document, which asked whether such a
warning should exist. It should, and it does.

## Task 1 (this pass): the title-page decoder refused every title page that omitted `title`

**The owner's own reproduction**: an exported screenplay could not be re-imported. Diagnosed by
the owner before this pass started, and confirmed directly: sweeping all 64 combinations of the
six optional title-page fields (`title`, `credit`, `authors`, `source`, `draftDate`, `contact`)
through `screenplayToFdx` then `fdxToScreenplay` failed exactly **31 of 64** -- every combination
that omitted `title` while containing at least one other field. Every combination containing
`title` passed. Half of all possible title pages could never be re-imported, and the data was
present in the file the whole time -- a pure decoder defect, not a data-loss issue.

**The mechanism.** `titlePageLines` (`packages/fdx/src/index.ts`) pushes
`TITLE_PAGE_LINES_BEFORE_TITLE` (17) blank paragraphs **unconditionally**, outside the
`if (titlePage.title !== undefined)` guard -- the run exists whether or not a title follows it.
`decodeTitlePageContent`'s `tryTitle` (`packages/fdx/src/import.ts`) used to consume that run
_inside its own backtracking attempt_ and reset fully over it whenever no title paragraph
followed. When `title` was absent, that reset handed the entire 17-blank run back to whichever
field came next: `tryPlainField(3, 'Center')` (credit) then called its own `consumeBlanks()` and
saw the leading 17 plus its own 3-blank gap as one merged, 20-blank run, failed its
`gap !== expectedGap` check, backtracked in turn, and every remaining field cascaded the same
way. `cursor` never reached `total`, so the whole title page -- and the import -- was refused.

**The fix.** The leading run is now consumed exactly once, unconditionally, **before** `tryTitle`
or any other field is attempted, using the exact size the exporter writes
(`TITLE_PAGE_LINES_BEFORE_TITLE`, exported from `index.ts` for this purpose -- it was a private
`const` before this pass) rather than a second, independently-chosen magic number or a loose
"consume however many blanks happen to be there." `tryTitle` no longer consumes or backtracks over
any blanks at all; it only ever tests the one paragraph now sitting at `cursor`, and leaves that
cursor untouched if the paragraph does not match the title's shape. This is a genuine shared-
constant fix, not a parallel patch: the two halves of the grammar (the exporter's unconditional
push and the decoder's unconditional consume) now reference the identical value, so they cannot
drift apart again the way they did before this pass.

**The test.** A single test, `fdxToScreenplay: the title-page decoder must accept every field
combination, not only the ones that include \`title\`` (`packages/fdx/src/import.test.ts`), sweeps
all 64 combinations in one pass -- for each, it builds a `titlePageWith(...)`carrying the subset
of fields the bitmask selects, round-trips it through`screenplayToFdx`/`fdxToScreenplay`, and
compares the decoded title page to the known sample value **field by field**, not via
`JSON.stringify`(whose key order differs between`titlePageWith`'s construction order and
`screenplaySchema`'s own declared shape order -- the owner's own note on being briefly misled by
exactly that). Run before the fix, it failed with exactly the predicted 31 of 64 combinations
named individually in the assertion message (masks 2, 4, 6, 8, ... 62 -- every even mask except
0, i.e. every combination with `title`'s bit unset and at least one other bit set). After the fix,
all 64 pass, and no other test in the package's 124-test suite changed behaviour.

**Mutation 1** (disable the fix entirely -- `if (false && index < TITLE_PAGE_LINES_BEFORE_TITLE...)`
around the new unconditional-consumption loop): 9 tests failed, headlined by the 64-combination
sweep itself, plus every other test that happens to exercise a title page containing `title`
(the fix's removal also broke `tryTitle`'s own blank-consumption, since that responsibility moved
out of it entirely) -- `reproduces the fixture exactly...`, `round-trips a page_break that is not
trailing`, both genuine-reference-file tests, `decodes a two-author run correctly...`, the
`safeParseScreenplay` re-validation test, and the dedicated `"unknown_types"` error-taxonomy test
(collateral from the same fixture). Reverted and `diff`-verified identical to the pre-mutation
file.

## Task 2 (this pass): naming unmappable elements and letting the writer resolve them

**This would not have fixed the owner's reported failure.** That was Task 1, a title-page grammar
defect, not an unmappable element -- stated plainly here so the two are never conflated. Task 2 is
a genuine usability gap the owner also asked for, found by reading the brief, not a workaround for
Task 1's bug.

**Before**: a genuinely unknown FDX `Type` threw `'unmapped_content'` immediately, on the first
paragraph it met, with a flat, generic message ("nothing was imported... remove or convert that
content in Final Draft"). A file with three distinct unknown types took three failed import
attempts to even discover all three, and there was no way to proceed short of leaving Final Draft
and re-exporting.

**The API change, and why this shape.** `packages/fdx` stays pure (no DOM, no I/O) -- the shape
the owner asked for was reached deliberately, not the first thing that compiled:

- `decodeContent` (`import.ts`) now gathers **every** distinct unrecognised `Type` in **one pass**
  over `<Content>` -- keyed by the raw FDX `Type` string, with an occurrence count and a short
  (80-character, whitespace-trimmed) excerpt of the first instance's text -- rather than throwing
  on the first one it meets. If any are found and none have a caller-supplied resolution, it
  throws a new, structured `FdxUnknownTypesError` (`code: 'unknown_types'`, still an
  `FdxImportError`, so an existing `instanceof FdxImportError` check is unaffected) carrying the
  full `unknownTypes: readonly FdxUnknownType[]` list. Gathering before throwing, rather than
  throwing on first sight, is the entire point: a caller can show the writer everything that needs
  a decision in one modal, not one failed attempt at a time.
- `fdxToScreenplay` gained a second, optional parameter: `resolutions: FdxUnknownTypeResolutions`
  (default `{}`), keyed by the identical raw `Type` string, each value either `{ action: 'skip' }`
  or `{ action: 'map', blockType: MappableBlockType }`. `MAPPABLE_BLOCK_TYPES` (`action`,
  `scene_heading`, `character`, `dialogue`, `parenthetical`, `transition`, `shot`) is exported as a
  _value_, not only a type, specifically so the UI's resolution dialog can render its choices from
  the same list this package enforces, rather than a second, hand-maintained copy that could drift.
  A `'map'` resolution reuses the exact same leaf-decoding logic (`buildLeafBlock`, factored out of
  `decodeLeafParagraph` for this purpose) a genuinely-mapped `Type` already gets -- including scene
  number recovery for a `scene_heading` target -- so a writer's choice is decoded identically to
  how this package already decodes the type it resembles, not through a second, parallel path.
- **Two-call shape, not a single call with a callback.** The caller is expected to call
  `fdxToScreenplay(source)` once; on `FdxUnknownTypesError`, collect the writer's decisions, then
  call `fdxToScreenplay(source, resolutions)` again. This was the deliberate choice over, say, an
  injected resolver callback invoked synchronously mid-parse: `packages/fdx` must stay pure and
  synchronous, and the writer's decision is inherently asynchronous (a modal, a click) --
  threading a callback through a synchronous parse to await an asynchronous answer is not possible
  without either blocking the parse (impossible in JS) or making the package itself async for a
  concern that belongs to its caller. Two plain calls keep the package's contract exactly as
  simple as it already was (a string in, a result or a thrown error out) and put the asynchrony
  entirely in `apps/web`, where it already lives (`parseFdx`/`resolveUnknownTypes`, both
  `useMutation`s).
- **The existing invariant survives, with the writer supplying the decision instead of the import
  failing.** Nothing is ever guessed on this package's own initiative: a `Type` with no resolution
  stays unresolved and is reported again (never silently skipped, never silently mapped), and the
  closed-allowlist property from the owner's earlier relaxation (`SKIPPABLE_FDX_TYPES`,
  `FDX_TYPE_TO_BLOCK_TYPE`) is completely unchanged -- this only adds a third, caller-decided
  outcome for the one category (an unrecognised `Type`) that was previously only ever fatal.

**The UI** (`apps/web/src/fdxUnknownTypesDialog.tsx`, lazy-loaded exactly like
`fdxImportConfirmDialog.tsx`): lists every distinct unknown type with its count and excerpt, and a
`<select>` per type offering "Choose…" (no decision), "Skip," or "Map to <element>" for each of
the seven canonical types. The "Continue" button is a real, native `disabled` control -- not merely
visually inert -- until every listed type has a decision (`allResolved`), so an unresolved type
cannot even be submitted, let alone guessed past. Cancelling clears the dialog's state and calls
nothing else, exactly like `FdxImportConfirmDialog`'s own cancel. Resolving calls
`onResolve(resolutions)`, which the route (`routes/projects/$projectId/index.tsx`) wires to a
second mutation (`resolveUnknownTypes`) that re-parses the **same** `File` (re-reading `.text()`,
not re-using already-read text, since `File.text()` is safe to call more than once) with the
supplied resolutions. On success, that lands on the identical `handleParsedFdxOutcome` the first
parse attempt uses -- **this flows into the existing confirmation dialog, not a second, competing
one**: the writer resolves unknown types, then sees the same block count / skipped tally /
read-only warning `FdxImportConfirmDialog` already shows, and `commitImport` is the one and only
path to `api.createScreenplay`, unchanged by any of this.

**Mutation 1** (the closed-allowlist check that drives unknown-type gathering,
`if (false && typeAttr !== undefined && !(typeAttr in FDX_TYPE_TO_BLOCK_TYPE))`): every `Type` is
treated as mapped/skippable and the branch that gathers unknown types never runs. **Result**:
exactly the 9 tests that depend on an unrecognised `Type` actually being reported failed (the
closed-allowlist invariant test, 7 of the 8 new `FdxUnknownTypesError`/resolutions-API tests -- every
one that actually calls `fdxToScreenplay` on an unrecognised `Type`, which is every one of them
except the lone test that constructs `FdxUnknownTypesError` directly and never touches
`decodeContent` at all -- and the "unknown_types" error-taxonomy test); every other test, including
the ones for `General` and the `SKIPPABLE_FDX_TYPES` allowlist itself, stayed green.

**Mutation 2** (the "no resolution supplied" branch, `if (false && resolution === undefined)`):
with this branch effectively disabled, every unresolved type falls through to
`resolution.action === 'skip'` on an `undefined` `resolution`, which throws a raw `TypeError`
instead of the structured `FdxUnknownTypesError`. **Result**: exactly the 5 tests that call
`fdxToScreenplay` with no resolution (or an incomplete one) for a genuinely unknown type failed,
each failing in the predicted way (`expected TypeError... to be an instance of FdxUnknownTypesError`,
or a direct property-access assertion on the now-absent error). Both mutations reverted and
`diff`-verified identical to the pre-mutation file.

**Mutation 3** (the UI's own `allResolved` gate, `const allResolved = true || ...`): Continue
becomes permanently enabled regardless of whether every type has a decision. **Result**: exactly
the 3 tests asserting the disabled-until-resolved property failed (`keeps Continue disabled until
every listed type has a decision...`, `reverting a decision back to "Choose…" disables Continue
again`, and the Tab-trap test, which depends on Continue being unfocusable while disabled to
determine the last reachable control); every other `FdxUnknownTypesDialog` test, including the one
that asserts `onResolve`'s call shape, stayed green. Reverted and `diff`-verified identical.

## Task 3 (this pass): "Import FDX…" becomes the arrow on a split "Create screenplay" button

The owner's words: "Rather than just sitting below the create line, we should have an arrow on
the right side of the 'create screenplay' button that drops an import menu down... there should
also be a vertical divider between the words and the arrow." The standalone "Import FDX…" button
(a second `.create-row`, its own `.primary-button`) is gone; `CreateScreenplaySplitButton.tsx`
(`apps/web/src/components/`) is what replaced it, used from `routes/projects/$projectId/index.tsx`
with "Import FDX…" as its (today, only) menu item.

**The design.** Two real, independently-operable `<button>`s inside one `.split-button` flex
container, with a thin `.split-button-divider` between them -- never one button with two jobs:

- The primary button (`type="submit"`, label "New screenplay") is unchanged in every behavioural
  respect from the plain button it replaced: no `disabled` of its own, submits the surrounding
  form exactly as before. No new authorization or entitlement rule was added for it -- the
  requirement was explicit about this, and the server's own `canEdit` check is still the only
  place this is enforced, for creating a screenplay by hand or by import alike.
- The arrow (`type="button"`) carries `aria-haspopup="menu"`, an accurate `aria-expanded`, and its
  own accessible name (`arrowLabel`, "Import a screenplay" while idle, "Importing…" while busy --
  never "New screenplay," and the changing label is what carries forward the exact feedback the
  old standalone button's own changing label used to give). `importDisabled` -- passed from the
  route as `parseFdx.isPending || resolveUnknownTypes.isPending || commitImport.isPending`, the
  identical condition the old button's own `disabled` already used, now covering the Task 2
  mutation as well -- disables only the arrow, never the primary button, so no new authorization
  rule exists here either: this is the same condition, moved, not a new one.
- The arrow's menu (`items: OverflowMenuItem[]`, importing the _type_ from `OverflowMenu.tsx` for
  shape consistency and nothing else) holds "Import FDX…" today, `onSelect: () =>
fileInputRef.current?.click()` -- the same hidden `<input type="file" accept=".fdx">` the old
  button used to trigger, moved into the form unchanged. Built as a list of items specifically so
  a second import format is just another array entry later, not a second component.

**Why this is independent code, not a shared import, and why that is deliberate.** A separate
branch is changing `OverflowMenu.tsx` and its `.overflow-menu-*` CSS rules; touching either from
this slice would create a merge conflict the brief explicitly ruled out. `CreateScreenplaySplitButton.tsx`
imports only `OverflowMenuItem`'s _type_ from that file -- everything else (the open/close state,
the dismissal effect, the keyboard handling) is hand-written from scratch in the new file.

**The Safari dismissal reasoning, carried forward deliberately.** `OverflowMenu.tsx`'s own long
comment records a real, owner-reported defect: a `focusout`-based close made every menu in the app
inert in Safari, because WebKit does not focus a `<button>` pressed with a mouse -- pressing an
item blurred whatever had focus with `relatedTarget === null`, the menu closed on `focusout`, and
the item unmounted before its `click` was ever dispatched. `CreateScreenplaySplitButton.tsx`
reproduces the _same two-listener mechanism_ that fixed it, as new code: a document-level
`pointerdown` (capture phase) closes the menu on any press outside the control, which fires before
`click` and is identical across engines; a document-level `focusin` (also capture phase) closes it
on a real focus move outside the control, except when the target is `document.body` itself, which
is the `focusin` shape of "WebKit focused nothing" -- an outside press, not this listener, is what
dismisses the menu in that case. Verified directly, not merely declared: `CreateScreenplaySplitButton.test.tsx`
includes the identical hand-dispatched event sequence (`pointerdown`/`mousedown`/`focusout` with
`relatedTarget: null`/`focusin` on `document.body`/`pointerup`/`mouseup`/`click`, with the item
deliberately never focused) that `OverflowMenu.test.tsx` uses to prove the fix, plus the companion
"closes on an outside pointer press that moves no focus at all" test. Both pass.

**The real-browser geometry evidence, gathered in the order the brief required.**
`apps/web/e2e/split-button-geometry.spec.ts` was written before any CSS for `.split-button`/
`.split-button-menu` existed in `styles.css`, following `text-contrast.spec.ts`'s harness
(navigate to an already-served route, inject the component's exact markup, measure real
`getBoundingClientRect()`s). Run with no CSS at all for these classes, both of its original two
tests failed, confirming the spec exercises something real rather than passing vacuously: the
overlap test failed with `Expected: >= 64, Received: 40` (an un-positioned `<div>` simply follows
its predecessor in normal block flow, not meaningfully "below" the specific button it belongs to),
and the second test (at that point asserting `menu.left > 0` against a fixture with no offset at
all) failed with `Expected: > 0, Received: 0`.

CSS was added; the overlap test passed, but the second test's own design turned out to be too
weak once a real (zero-offset) fixture was in front of it -- `menu.left` legitimately _is_ `0` in
a page with nothing pushing the control away from the origin, so `> 0` was never going to
distinguish "correctly anchored to the button" from "coincidentally also zero." That test was
rewritten before being counted as passing evidence: the fixture now offsets the whole control with
`paddingLeft`/`paddingTop`, and the assertion compares `menu.left` directly to `button.left`
(anchored to the control) rather than to an arbitrary floor. Rebuilt and re-run: both tests passed.

To prove the rewritten spec actually catches the defect it exists for -- not merely that it
passes once CSS exists -- `.split-button-menu`'s `top` was then mutated from `calc(100% + 4px)` to
`0` (the literal "renders on top of its own button" shape the sibling branch's flyout defect
took): the "sits below... and never overlaps" test failed exactly as predicted
(`Expected: >= 120, Received: 80` -- the menu's top landing level with the button's own top
instead of below its bottom), while the anchoring test stayed green (a `top: 0` bug does not move
`left`, so that test alone would not have caught this particular mutation -- confirming the two
tests check genuinely different things, not the same property twice). Reverted and
`diff`-verified identical to the pre-mutation stylesheet, then rebuilt and re-confirmed both tests
pass.

**No new assertion was added inside `OverflowMenu.tsx` or its own spec files** -- per the
constraint, that file and its CSS rules were read (for the dismissal mechanism and the
`.overflow-menu-list` positioning convention this slice's own CSS deliberately echoes) but never
edited.

## Gates

The section below (through item 8's original figures) documents the pass that first shipped the
owner's relaxed skip policy and the confirmation dialog. **Everything below this line documents
the gate run for Tasks 1-3 above** -- run from the worktree root, in this order, each read directly
rather than assumed from a prior run or from the section above.

1. `pnpm build:packages` -- clean, exit 0.
2. `pnpm lint` (`eslint . --max-warnings=0`) -- clean, workspace-wide, exit 0.
3. `pnpm typecheck` (workspace-wide, every package and app, including `astro check` for
   `apps/landing`) -- clean, exit 0.
4. `pnpm test` (workspace-wide, every package and app) -- **exit 0, every package green**:
   `@finaler-draft/fdx` **124** tests (45 export + 33 `xmlParser.test.ts` + 46 `import.test.ts`,
   up from 38 before this pass -- the 64-combination sweep, the `FdxUnknownTypesError`/resolutions
   describe block, and the two error-taxonomy code renames); `apps/web` **987** tests (up from
   975 before this pass -- `fdxUnknownTypesDialog.test.tsx` (10), `CreateScreenplaySplitButton.test.tsx`
   (11), the route's own new Task 2/Task 3 tests, minus the one it.each case retired and replaced).
   Every other workspace package (`screenplay` 172, `screenplay-editor` 143, `layout` 72, `docx`
   58, `pdf` 61, `xml-escape` 9, `database` 52/11 skipped, `entitlements` 25, `auth-server` 24,
   `config` 8, `server-config` 20, `collab-token` 9, `apps/collab` 169/32 skipped, `apps/api`
   317/76 skipped, `apps/landing` 31) unaffected and green.
5. `PLAYWRIGHT_CHANNEL` unset, default Chromium -- `pnpm test:system` -- **78 passed**, 0 failed
   (76 pre-existing plus the 2 new `split-button-geometry.spec.ts` tests). Confirmed directly, not
   assumed from the unit-test suite: both geometry tests were run once with no CSS for
   `.split-button`/`.split-button-menu` at all (both failed, as the brief required), once more
   after a deliberate reintroduction of the "renders on top of its own button" defect
   (`top: calc(100% + 4px)` mutated to `top: 0` -- the "sits below... never overlaps" test failed
   exactly as predicted), and finally against the real, restored CSS (both pass) -- see Task 3's
   own section above for the exact numbers from each run.
6. `pnpm test:coverage` (workspace-wide) -- **exit 0, no threshold failures**.
   `@finaler-draft/fdx` (package threshold 90%, stricter than this scope's 80% floor): **98.63%**
   statements, **95.67%** branches, **100%** functions, **98.63%** lines (`import.ts` 97.39/95.97,
   `index.ts` 99.33/96.29, `xmlParser.ts` 100/94.78 -- all three up from or level with the prior
   pass's figures; nothing regressed). `apps/web` (per-file thresholds, 80% each): the three new
   or newly-exercised files all clear it by a wide margin --
   `components/CreateScreenplaySplitButton.tsx` 97.36% stmts / 84.21% branch / 100% funcs / 97.36%
   lines; `fdxUnknownTypesDialog.tsx` 100/92.1/100/100; `fdxImportConfirmDialog.tsx` 100/89.47/100/100;
   `routes/projects/$projectId/index.tsx` 98.86/91.75/89.47/98.86 -- and no other file's coverage
   regressed (full per-file table available in this run's own `vitest --coverage` output).
7. **Did not run, and are not reported as passing**: `pnpm test:integration` and `pnpm
test:system:persistence`. Both need a local PostgreSQL with `TEST_DATABASE_URL` set, and
   Postgres is not running on this machine, per this scope's own instruction. This is the same gap
   named in "What could not be verified" above: these are exactly the gates that would exercise a
   real `createScreenplay` call and a real editor mount for an imported screenplay, now including
   Task 2's second `fdxToScreenplay` call and Task 3's split-button-driven file picker.
8. `pnpm check:bundle-budget` -- **exit 0, both budgets held, no regression from this pass**:
   entry chunk **111.95 kB** / 120 kB budget (identical to the figure already on this branch --
   neither `CreateScreenplaySplitButton` nor `FdxUnknownTypesDialog` is in the entry's static
   closure: the split button is imported by the project route's own chunk, not the entry, and the
   dialog is reached only through a `lazy()` dynamic import exactly like its sibling
   `FdxImportConfirmDialog`); lazy editor chunk **165.00 kB** / 200 kB budget, itemized as `App`
   23.46 + `OverflowMenu` 0.81 + `api` 14.99 + `index` 123.53 + `navigatorPanel` 2.22 kB -- the
   identical five members and the identical total as before this pass, confirming neither new
   component entered the editor's closure either; CSS **7.86 kB** / 20 kB budget (up from 7.76 kB
   the split-button/resolution-dialog rules added, still comfortably under budget).
9. `pnpm format:check`, run **bare** (not piped through `tail`), run **last**, after this file was
   written and formatted along with everything else: **exit code 0.**

```
$ pnpm format:check; echo "EXIT:$?"
EXIT:0
```

## Task 1 (this pass -- trailing blank `authors` lines): the title-page decoder still refused a real, exported file

**The owner's reproduction**, handed over as ground truth rather than re-derived: `/Users/nathan/
Downloads/Multi page script.fdx`, a 47 KB file exported from this very product, failed to
re-import with `unmapped_content` -- "a title page whose paragraph sequence does not match the
structure this product recognizes (unrecognized content starting at title-page paragraph 32 of
40)". Every one of its 118 body paragraphs is mappable (96 Action, 10 Dialogue, 5 Character, 4
Scene Heading, 2 Parenthetical, 1 Shot, confirmed directly against the file, not assumed) -- the
defect was entirely in the title page, which is now the committed fixture
`packages/fdx/fixtures/multi-page-script.fdx` (see that directory's `README.md` for provenance).

**The root cause, in my own words.** `titlePage.authors` can be `['Nathan', '', '']` -- two
_trailing blank entries_ a writer left on the page -- and `titlePageLines` (`index.ts`) writes
each entry as its own centered paragraph faithfully, blank ones included. `decodeTitlePageContent`'s
`tryAuthors` (`import.ts`) reads the first author, then keeps reading _while the next paragraph is
not blank_ -- so it stops the instant it meets the first blank entry, by construction, and leaves
both blank paragraphs sitting in the stream for whichever field comes next. `source`'s own gap is a
fixed `TITLE_PAGE_LINES_BEFORE_SOURCE` (4) blank paragraphs; with the two orphaned author blanks in
front of it, `tryPlainField`'s `consumeBlanks()` counts 2 + 4 = 6, fails its `gap !== expectedGap`
check, and backtracks -- exactly the "paragraph 32 of 40" position the owner's error named, since
`source` is the sixth field position and the two swallowed authors blanks shift everything after
it by exactly two. `draftDate` and `contact` then fail the identical way from the same
unconsumed-blank starting point, `cursor` never reaches `total`, and the whole title page -- and,
before this pass, the whole import -- was refused. I confirmed this mechanism directly, not just
by reading it: exporting a title page with `authors: ['Nathan', '', '']` reproduces the owner's
exact shape (source found 6 blanks before it, expected 4); `['Nathan', '']` produces 5; `['Nathan',
'', '', '']` produces 7; `['Nathan']` alone (no trailing blanks) imports fine today, confirming the
defect is specifically about _trailing_ blank author entries, not authors generally.

**Why the excess is deterministically attributable, not a guess.** Every field's gap in this
grammar is a fixed, named constant (`TITLE_PAGE_LINES_BEFORE_CREDIT`/`_AUTHOR`/`_SOURCE`/
`_DRAFT_DATE`/`_CONTACT`, all five now exported from `index.ts` specifically so `import.ts` never
restates them as its own numbers -- the same discipline the prior pass's
`TITLE_PAGE_LINES_BEFORE_TITLE` export established, extended to its four siblings). `authors` is
the _only_ field whose own entries can be blank (`contact`'s multiple lines join into one paragraph
with embedded `\n`, so it can never produce a stray blank paragraph; every other field is a single
line or absent). So when the blank run immediately before a field is longer than that field's own
known gap, there is exactly one place the excess could have come from: `authors`' own trailing
blank entries, left uncounted by `tryAuthors`' early stop. This is arithmetic on known constants,
not a heuristic guess at intent -- the same property that already made the prior pass's title-run
fix safe.

**The fix** (`tryPlainField` in `decodeTitlePageContent`, `packages/fdx/src/import.ts`): it now
takes an `authorsForExcess: string[] | undefined` parameter -- the array `tryAuthors` produced, or
`undefined` when no `authors` field was read at all. When the blank run it counts exceeds its
`expectedGap`, it no longer backtracks immediately; it first confirms the paragraph now sitting at
`cursor` genuinely matches this field's shape (alignment and zero style tokens -- the same check
that already guarded every field), and only _after_ that confirmation does it push the excess as
empty strings onto `authorsForExcess`. Confirming the field's shape before mutating is what keeps
a coincidental gap sum from ever corrupting `authors`: an attempt that matches the wrong field (the
wrong alignment) still backtracks with zero mutation, exactly as a genuine mismatch always did.
`credit` (tried before `authors` even runs) always passes `undefined`, so a longer-than-expected
gap there still fails exactly as strictly as before this pass -- the relaxation is real but scoped
to the one case it exists for. A second, smaller case needed its own handling: when `authors` has
trailing blanks and _no_ field at all follows it (the title page simply ends there), none of
`source`/`draftDate`/`contact` ever gets a paragraph to match against, so the per-field attribution
above never fires; a dedicated check after all three field attempts -- `authors` was found, and all
three are `undefined` -- attributes exactly that trailing run to `authors` instead of treating it
as inert filler the way genuinely unexplained trailing blanks are.

**Why normalising empty authors away on export was rejected.** The alternative fix would have been
having `screenplayToFdx` filter blank entries out of `authors` before writing them. Two reasons
this was not the fix: first, those blank lines are the writer's own real vertical space on the
title page, put there deliberately (most plausibly by pressing the authors list's own "+ Add line"
button -- see this pass's note on `apps/web/src/titlePageEditor.tsx` below -- and leaving the new
line blank); silently dropping them on export would be exactly the kind of unrequested content
normalization this project's import and export slices both refuse to do elsewhere, and this
project's own canonical round-trip property (`progress/canonical-round-trip.md`) exists precisely
so that kind of silent rewrite does not happen. Second, and more simply, it would not even have
fixed the owner's actual bug report: the owner's file was already written by Final Draft -- sorry,
by this product's own exporter, at a point in time before any such filter existed -- so a fix that
only prevents the shape from being _created_ in the future does nothing for the file that already
exists and needs to import today. The decoder had to become able to read what the encoder already,
legitimately, writes.

**The before/after sweep.** The existing 64-combination sweep test
(`fdxToScreenplay: the title-page decoder must accept every field combination...`,
`import.test.ts`) now also varies the number of trailing blank `authors` entries (0, 1, 2, 3),
giving 64 x 4 = 256 cases in one test. Run against the code as it stood before this pass's fix (by
mutation -- see below), it failed exactly **96 of 256** -- every one of the 32 masks with `authors`
present, times the 3 non-zero trailing-blank counts (masks with 0 trailing blanks always passed,
since that is the pre-existing, already-fixed case). After the fix, all 256 pass, and the dedicated
headline test against the owner's own real file (`packages/fdx/fixtures/multi-page-script.fdx`)
imports completely: 118 blocks, 0 skipped, and the title page decoded field-by-field including
`authors: ['Nathan', '', '']` exactly, preserved rather than collapsed to `['Nathan']`.

**A side benefit of the real fixture**: `TITLE_PAGE_LINES_BEFORE_DRAFT_DATE` and
`TITLE_PAGE_LINES_BEFORE_CONTACT` were, before this pass, confirmed only by this package's own
exporter output and an inference from the other three fields' gaps -- the existing FD13 reference
file's own test script leaves both fields blank. The owner's file populates both (`draftDate:
'08/22/26'`, a 15-line `contact`), and both decode correctly at the existing gap of 3 -- the first
confirmation of those two constants against a genuine, non-synthetic Final Draft title page.

**Is the title-page editor what creates trailing empty author entries, and should it?** Read
directly, not guessed at: yes. `apps/web/src/titlePageEditor.tsx`'s shared list-field component
renders a "+ Add line" button (`addLabel="Add author line"` for the authors list specifically) that
runs `onChange([...lines, ''])` -- it appends a bare empty string, with no requirement that the
writer ever type into it before saving. `titlePageState.ts`'s `titlePageFromState` only checks
`state.authors.length > 0` before writing the array to the canonical `TitlePage`; it never filters
individual blank entries out of an otherwise non-empty list. So a writer who clicks "+ Add line"
under Authors and leaves it blank -- whether by accident, to reserve visual space, or mid-typing a
second author they have not gotten to yet -- produces exactly the shape the owner's file has. **I
did not change this.** Whether it _should_ work this way (filter trailing/empty author entries on
save, warn the writer, or leave it exactly as-is, since the blank line is real intentional spacing
and this pass just taught import to honor it) is a product decision for the owner, not something
to decide inside an import-slice bugfix.

**Mutation 1** (the per-field attribution guard, `tryPlainField`'s `if (excess > 0 &&
authorsForExcess === undefined)`): mutated to never back out regardless of whether `authorsForExcess`
is defined. **Result**: 32 of the 256 sweep cases failed, every one with `credit` absent and `source`
present -- without the guard, `credit`'s own attempt (with no `authors` array to blame an excess
on) matched `source`'s paragraph by coincidental alignment (both `Center`) and then crashed
(`Cannot read properties of undefined (reading 'push')`) trying to push the excess onto a
non-existent `authors` array. This is itself informative: it demonstrates the guard is load-bearing
against a real cross-field misattribution, not merely decorative. Reverted and `diff`-verified
identical.

**Mutation 2** (the end-of-title-page trailing-run attribution, guarded on `authors !== undefined &&
source === undefined && draftDate === undefined && contact === undefined && trailing > 0`):
disabled via `false && ...`. **Result**: exactly 12 of 256 sweep cases failed -- the 4 masks with
`authors` present and nothing after it (`authors` alone, `title+authors`, `credit+authors`,
`title+credit+authors`), times the 3 non-zero trailing-blank counts. Every case with a field after
`authors` was unaffected, confirming this guard and Mutation 1's guard protect two genuinely
different situations. Reverted and `diff`-verified identical.

Both mutations were applied one at a time, run, recorded, reverted, and `diff`-verified identical
to the pre-mutation file before the next -- consistent with every prior mutation in this document.

## Task 2 (this pass -- an unreadable title page must not refuse the whole screenplay): fatal becomes reported

**The owner's complaint, twice now**: the error was insufficiently descriptive, and more deeply,
it was _fatal_. Refusing a 100-page script because its title page has one unexpected blank line is
the wrong trade -- a lost title page is recoverable (the writer re-types four fields); a refused
import is not recoverable at all without going back to Final Draft and re-exporting.

**The change.** `fdxToScreenplay` (`packages/fdx/src/import.ts`) now wraps only the
`decodeTitlePageContent` call in a `try`/`catch`. A caught `FdxImportError` (the only kind
`decodeTitlePageContent` can throw) is not re-thrown: `titlePages` stays `[]` (nothing decoded,
nothing guessed at), and the new `titlePageUnreadable: boolean` field on `FdxImportResult` is set
to `true`. Anything that is not an `FdxImportError` is re-thrown unconditionally, so this catch can
never silently swallow a genuine programming error it was never written to handle. Critically, body
decoding (`decodeContent`) runs _before_ the title page is even looked at and is structurally
unaffected by anything that happens afterward -- there is only one code path for the body, so
"the body imports regardless" is a property of the function's shape, not a promise kept across two
separate paths that could drift apart. The one edge case that remains genuinely fatal is honest
about why: if the body is _also_ empty, `'empty_result'` still throws, now with a message that
says the title page could not be read either, rather than reusing the "no title page content"
wording that would be misleading when the title page in fact had unreadable content.

**The UI.** `FdxImportResult.titlePageUnreadable` is threaded, unmodified, through
`buildPendingImport` (`apps/web/src/routes/projects/$projectId/index.tsx`) into `pendingImport`
state and then into `FdxImportConfirmDialog`'s new `titlePageUnreadable` prop -- the identical
confirmation step a skipped element type and the read-only warning already use, not a second,
competing surface. The dialog renders a `role="alert"` paragraph naming the title page specifically
("This file's title page could not be read, so it was left out of the import -- the script body
imported in full") exactly when `titlePageUnreadable` is true, instead of the old generic sentence
("That script contains content this product cannot represent yet...") that this case no longer
reaches at all -- it is reserved for genuinely unmapped _body_ content (a dual-dialogue column
split that cannot be resolved, for instance), which stays exactly as fatal as it always was. Both
this alert and the read-only warning can render together without either replacing the other,
verified directly in `fdxImportConfirmDialog.test.tsx`. Cancelling behaves identically whether or
not this warning is showing: `onCancel` only clears `pendingImport`, by construction, not by a
check that has to remember this new case.

**Why this trade is right.** The property this slice must never violate is "nothing is silently
dropped" -- not "every failure is fatal." A skipped element type was already relaxed from fatal to
reported for exactly this reason in an earlier pass (`SKIPPABLE_FDX_TYPES`); an unreadable title
page is the same shape of problem (a part of the file this mapping cannot represent) with a much
higher cost when treated as fatal (the entire body, not one outline note, is what gets refused).
Reporting it, rather than guessing at it or dropping it without telling the writer, is what keeps
the honesty property intact while fixing the actual harm: the writer is told, specifically, that
the title page -- and only the title page -- could not be read, and chooses whether to proceed with
everything else intact.

**Mutation A** (the re-throw guard inside the `catch`, changed to always re-throw regardless of
error type): **Result**: exactly 4 tests failed in `import.test.ts` -- the three
`title-page grammar edge cases` tests asserting a successful, reported outcome (each now threw
instead), and the dedicated `"empty_result"... when the body is empty and the title page is also
unreadable` test (now threw `'unmapped_content'` instead of `'empty_result'`). Reverted and
`diff`-verified identical.

**Mutation B** (the flag assignment inside the `catch`, changed from `titlePageUnreadable = true`
to `titlePageUnreadable = false` -- silently swallowing the failure without reporting it):
**Result**: exactly 4 tests failed, all asserting `titlePageUnreadable` is `true` or asserting the
specific `empty_result` wording that only appears when the flag is set -- a different 4 tests from
Mutation A's, confirming the catch-disabling guard and the reporting guard are two independent
properties, not the same one tested twice.

**Mutation C** (the web dialog's rendering guard, `{titlePageUnreadable && (...)}` changed to
`{false && titlePageUnreadable && (...)}`): **Result**: exactly 4 tests failed -- two in
`fdxImportConfirmDialog.test.tsx` (the alert-naming test and the both-alerts-together test) and two
in the route's own `index.test.tsx` (the Task 2 end-to-end test and the cancel-while-unreadable
test); every other test in both files, including the ones for the unrelated read-only warning,
stayed green.

All three mutations were reverted and `diff`-verified identical to the pre-mutation file before the
next.

## Gates (this pass)

Run from the worktree root, in this order, each read directly.

1. `pnpm build:packages` -- clean, exit 0.
2. `pnpm lint` (`eslint . --max-warnings=0`) -- clean, exit 0.
3. `pnpm typecheck` (every package and app, including `astro check`) -- clean, exit 0.
4. `pnpm test` -- **exit 0, every package green**: `@finaler-draft/fdx` **127** tests (up from 124
   before this pass -- the extended sweep replacing the 64-case one, the real-file headline test,
   the four rewritten title-page-grammar-edge-case tests, the new fatal-body-still-throws test, and
   the new empty-result-with-unreadable-title-page test, net +3); `apps/web` **992** tests (up from
   987 -- the two new `fdxImportConfirmDialog.test.tsx` tests plus the two new route-level Task 2
   tests). Every other workspace package unaffected and green: `screenplay` 172, `screenplay-editor`
   143, `layout` 72, `docx` 58, `pdf` 61, `xml-escape` 9, `database` 52/11 skipped, `entitlements`
   25, `auth-server` 24, `config` 8, `server-config` 20, `collab-token` 9, `apps/collab` 169/32
   skipped, `apps/api` 317/76 skipped, `apps/landing` 31.
5. `pnpm test:system` (default Chromium) -- **78 passed**, 0 failed -- identical count to the prior
   pass; nothing in this pass touches `apps/web/e2e`.
6. `pnpm test:coverage` -- **exit 0, no threshold failures**. `@finaler-draft/fdx` (90% package
   threshold): **98.68%** statements, **95.59%** branches, **100%** functions, **98.68%** lines
   (`import.ts` 97.57/95.78, `index.ts` 99.33/96.29, `xmlParser.ts` 100/94.78 -- all level with or
   fractionally above the prior pass's figures; every uncovered line checked directly and confirmed
   pre-existing, not newly introduced by this pass's code). `apps/web` (80% per-file): the two files
   this pass changed both clear it with room: `fdxImportConfirmDialog.tsx` 100/90/100/100;
   `routes/projects/$projectId/index.tsx` 98.87/91.66/89.47/98.87 -- every uncovered line on both
   checked directly and confirmed to be a pre-existing defensive branch, not new dead code.
7. **Did not run, not reported as passing**: `pnpm test:integration` and `pnpm
test:system:persistence` -- both need local PostgreSQL with `TEST_DATABASE_URL`, and Postgres is
   not running on this machine, per this scope's own instruction. Unchanged gap from the prior
   pass's own note: these are exactly the gates that would exercise a real `createScreenplay` call
   for a title-page-unreadable import.
8. `pnpm check:bundle-budget` -- **exit 0, no regression**: entry chunk **111.95 kB** / 120 kB
   (identical to the prior pass -- neither file this pass touched is in the entry's static
   closure); lazy editor chunk **165.00 kB** / 200 kB, itemized identically to the prior pass (`App`
   23.46 + `OverflowMenu` 0.81 + `api` 14.99 + `index` 123.53 + `navigatorPanel` 2.22 kB); CSS
   **7.86 kB** / 20 kB (unchanged -- this pass added no CSS).
9. `pnpm format:check`, run **bare** (not piped through `tail`), run **last**, after this file was
   written and formatted along with everything else this pass touched: **exit code 0.**

```
$ pnpm format:check; echo "EXIT:$?"
EXIT:0
```

## Open questions for the owner

1. ~~Should import warn explicitly when the file will open read-only?~~ **Resolved and
   implemented** -- see "The confirmation step" above. The remaining question is the larger one it
   exposes: `editorContentFromScreenplay` refuses `dual_dialogue` and `page_break`, so a writer can
   now import a real Final Draft script and be told, correctly, that it opens read-only. Making
   those two constructs editable is its own slice, and is the obvious follow-on to this one.
2. ~~The title-page grammar's known gap (title absent while a later field is present)~~
   **Resolved by Task 1, this pass** -- that specific case (31 of 64 field combinations) is exactly
   the bug that was fixed, and it is now covered by the 64-combination sweep test. **A narrower
   residual gap remains, stated precisely rather than implied**: a title page with _fewer_ than
   `TITLE_PAGE_LINES_BEFORE_TITLE` (17) genuinely blank leading paragraphs -- a hand-edited or
   non-default-template file, as opposed to this package's own exporter's output or Final Draft's
   own default template -- still fails closed, because the fix consumes exactly that many
   unconditionally rather than "however many happen to be blank." This is consistent with
   `plan.md`'s fail-closed principle and was true before this pass too; it is named again here
   only so it is not mistaken for the bug Task 1 actually fixed.
3. **`dual_dialogue`'s column-split heuristic (exactly two character cues) is conservative by
   design**, matching the exporter's own still-unverified-against-a-genuine-file status for this
   construct. If a real Final Draft dual-dialogue file ever surfaces, both sides of this mapping
   should be checked against it together. Unchanged by this pass.
4. **Task 2's resolution dialog does not cover an unrecognised `Type` nested inside a
   `dual_dialogue` column.** `decodeDualDialogue`'s inner paragraphs still go through the strict
   `decodeLeafParagraph`, which throws the flat, original `'unmapped_content'` immediately for an
   unrecognised `Type` in that position, rather than deferring to the gather-and-resolve path.
   Deliberate, not an oversight: `dual_dialogue`'s own FDX shape remains unverified against a
   genuine Final Draft file (open question 3 above), so extending the newer, more permissive path
   into an already-uncertain structure would be stacking one unverified assumption on another. If
   a genuine dual-dialogue file with an exotic inner paragraph type ever surfaces, this is the
   place to revisit.
5. **The split button's arrow label text ("Import a screenplay" / "Importing…") is this pass's own
   wording, not specified verbatim by the owner.** It satisfies the stated requirement (must not
   read as "Create screenplay," must carry the busy state), but the owner may prefer different
   phrasing once it is seen in place.
6. **(New, this pass) Should the title-page editor filter trailing blank `authors`/`contact` lines
   on save, or is preserving them -- as this pass's import fix now allows -- the correct
   behaviour?** Confirmed directly, not guessed at: `apps/web/src/titlePageEditor.tsx`'s shared
   list-field component renders a "+ Add line" button (`addLabel="Add author line"` for the authors
   list) whose `onClick` runs `onChange([...lines, ''])` -- it appends a bare empty string, with no
   requirement the writer ever types into it before saving. `titlePageState.ts`'s
   `titlePageFromState` only checks `state.authors.length > 0` before writing the array to the
   canonical `TitlePage`; it never filters individual blank entries out of an otherwise non-empty
   list. So yes, the title-page editor is exactly what can produce the owner's reported shape
   (`['Nathan', '', '']`), most plausibly by clicking "+ Add line" and leaving the new line blank.
   **This pass did not change either of those files.** It only taught **import** to correctly read
   the shape the editor and exporter already, legitimately, produce -- whether the editor itself
   should filter, warn, or leave this exactly as-is (the blank line may be deliberate vertical
   spacing a writer wants to keep) is a product decision for the owner, not something to decide
   inside an import-slice bugfix.

## The confirmation step is now conditional

The owner, after the title-page fix landed: _"even though there are no issues, it gave me the
'Import anyway' modal. We only need to do that if there are issues."_ Correct, and it was a design
error rather than a bug -- the step was built to always run.

The dialog exists to report what an import will **not** bring across faithfully: element types left
behind, a title page that could not be read, a result the editor will open read-only. When none of
those holds there is nothing to report, and a modal whose entire content is "nothing went wrong" is
pure friction between choosing a file and seeing the screenplay. A clean file now goes straight to
creation and never mounts the dialog.

`fdxImportNeedsConfirmation(pending)` is the single predicate, derived from the report itself
(`skipped.size > 0 || opensReadOnly || titlePageUnreadable`) rather than from a separate flag set at
parse time. That ordering matters: a fourth thing worth reporting cannot be added to the dialog
while a stale flag keeps claiming there is nothing to show.

**What made this a small change rather than a restructuring.** `commitImport` read `pendingImport`
from state, so creating anything required opening the dialog first -- the exact step a clean import
must skip. It now takes the import as its mutation argument, which also retired its "no pending
import to confirm" guard. The three hand-copied inline object types for that shape (the builder's
return, `ParsedFdxOutcome`'s `'ready'` arm, the state slot) collapsed into one named
`PendingFdxImport`; they had already drifted once, when `titlePageUnreadable` was added.

**Nothing is reported less.** The conditional is the _union_ of every case the dialog had to speak
about, so skipping it is only ever possible when it would have had nothing to say.

**Mutation evidence, both directions:**

- `return true` (the behaviour the owner objected to) -- 5 tests fail, headed by "a clean import
  creates the screenplay directly, with no confirmation dialog at all".
- `return false` -- **6** tests fail, one per reporting path: the skipped tally, the title-page
  warning, both of its cancel paths, the read-only warning, and the unknown-type resolution flow.
  This is the load-bearing result: the predicate cannot be loosened without losing a warning, and
  each warning is held individually rather than collectively.

The owner's real file (`multi-page-script.fdx`) measures `skipped 0`, `titlePageUnreadable false`,
`opensReadOnly false`, so it imports directly -- verified by running it, not by inference.

Test-file consequences, for the next reader: four clean-file tests stopped passing through a
confirmation step, and the cancel test had to be given a file with something to report
(`FDX_WITH_SOMETHING_TO_REPORT`, one skipped `Outline 1`) because a clean one no longer opens a
dialog there is anything to cancel.

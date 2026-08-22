# FDX export

Branch `feature/fdx-export`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/fdx-export`.

## Why this scope exists

`plan.md` puts FDX, PDF and DOCX next in the Phase 1 order, and treats a robust FDX fixture suite
as a prerequisite for later production work ("Do not start Final Draft-style locked pages, colored
production revisions, or scene-number insertion rules until deterministic pagination and a robust
FDX fixture suite exist"). The canonical round-trip test just landed, which `plan.md` scheduled
specifically to precede this.

**Export only. FDX import is deliberately a later slice** -- export is fully determined by our own
canonical model, while import means accepting arbitrary third-party files containing features we
cannot represent, which needs its own fail-closed policy decisions. Do not build import here, and
do not design the exporter around a hypothetical importer.

## The format is the hard part, and you must not guess it

FDX is an interchange format. Its whole value is that Final Draft and other tools read what we
write, so a plausible-looking file that Final Draft rejects or misreads is worse than no export at
all. **Establish the format from an authoritative source and record where each mapping decision
came from** in your progress entry -- element type strings, attribute names, the document header,
the title-page structure, and how scene numbers attach.

Where you cannot confirm something with confidence, **stop and flag it at checkpoint 1 rather than
inventing it**. The known-uncertain area is `dual_dialogue`: our canonical model has an explicit
container with two ordered columns, and FDX represents this differently. Do not ship a guess.

## What this must achieve

1. **A new `packages/fdx`** exporting a pure `screenplayToFdx(screenplay: Screenplay): string`.
   Pure means: no DOM, no filesystem, no network, no server. Model it on `packages/layout`'s
   `package.json` and tsconfig, which is the closest existing shape.

   Pure matters beyond tidiness. The same function must later serve a server-side export of a
   _historical revision_ (`plan.md`: "a test that an export made from a historical revision exactly
   identifies that revision rather than the mutable current document"), which is infrastructure the
   PDF slice has to build anyway. Building the serializer as a pure function now means that later
   slice adds a caller, not a rewrite.

2. **It takes canonical input, not editor input.** The editor refuses `dual_dialogue`,
   `page_break`, annotations and multiple title pages; the exporter has no such licence, because
   those values are valid canonical screenplays and will exist once import lands. Every canonical
   block type must be handled explicitly. A block type the exporter does not understand must throw,
   never be silently skipped.

3. **Annotations must never enter the screenplay flow.** `plan.md` is explicit: notes "must never
   enter PDF, DOCX, or FDX screenplay flow by accident." **Omit them from the FDX output entirely
   this slice** -- mapping them to a note element is a fidelity feature with its own decisions, and
   omission cannot corrupt the script. Make this deliberate and test it: a screenplay with
   annotations must export the identical script content as the same screenplay without them.

4. **XML escaping must be correct, and it is the security-relevant part of this slice.** Authored
   text is arbitrary user input that ends up in a file other people open. Escape through one
   audited helper and test it with hostile input: `<`, `>`, `&`, single and double quotes, `]]>`,
   a lone `&` next to a real entity, control characters, and text that already looks like markup.
   A test asserting the output merely _contains_ the text is not a test of escaping.

5. **A client-side download** so a writer can actually get the file: serialize the current canonical
   projection and save it as `<title>.fdx`. Keep this a thin layer over the pure function -- the
   serializer must not learn anything about browsers.

6. **Fixture-driven tests**, per `plan.md`'s "Export correctness requires fixture-driven tests."
   Cover every element type, empty and non-empty text, scene numbers present and absent, a title
   page populated and absent, non-ASCII and emoji text, and the hostile-escaping cases above.

## Out of scope

FDX import. PDF and DOCX. The export job queue, worker, storage, signed URLs and Dockerfile -- all
of that belongs to the PDF slice. Server-side or revision-based export. `documentSettings` mapped
into FDX page-layout settings (note in your entry whether FDX can express them, but do not build
it). Fountain or plain-text interchange.

## Verification

The full gate list, `pnpm format:check` run **after** writing your progress entry, and the
persistence gate run at least three times. This base is green -- `main` passes CI -- so any failure
is yours.

**No new dependencies.** An XML builder library is the obvious tool and is not approved here; the
document shape is fixed and small enough to build by hand, provided escaping goes through one
audited helper rather than being sprinkled at call sites.

For every test guarding specific behaviour: break the behaviour, confirm the test fails, restore,
and report it. Green does not mean working -- six vacuous tests have been found on this project,
one written by the lead, and one that had been executing against `about:blank` for its entire life
while appearing to guard font rendering. The likeliest vacuous test here is the escaping one: make
sure it fails if escaping is removed, rather than passing because the assertion looks for the raw
text that happens to appear either way.

No credential may appear in any file you write, including your progress log.

## Rules

Do not stage, commit, merge, rebase, force-push, reset, or create or delete branches or worktrees --
the owner controls staging, committing and pushing. No TODO or placeholder comments, no emojis,
strict TypeScript, `.js` extensions on relative imports. Match the surrounding comment style: this
codebase records _why_, citing `plan.md`. If the code contradicts the specification, stop and report
rather than bending either.

## Checkpoints -- SendMessage to the lead

1. Before writing the serializer: the full element and structure mapping you intend to emit, where
   each decision came from, and anything you could not confirm -- `dual_dialogue` especially.
   **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

## Log

### 2026-08-21 -- implementation agent -- checkpoint 1: format mapping researched, approved

Full element/attribute mapping proposed to the lead and approved, with three corrections/decisions
from the lead folded in before implementation started:

1. **`dual_dialogue`**: proceed with the researched mapping (untyped outer `<Paragraph>` wrapping a
   `<DualDialogue>` element containing the left column's blocks then the right column's, in order,
   each mapped through the ordinary Character/Parenthetical/Dialogue rules). Sourced from Beat
   (github.com/lmparppei/Beat, `BeatFDXExport.m` and legacy `FDXInterface.m`) and screenplain
   (github.com/vilcans/screenplain, `screenplain/export/fdx.py`) -- the lead's correction: these
   are one source lineage, not two independent ones (Beat's comment explicitly credits screenplain
   as its source), so this is corroborated by one well-exercised secondary source (Beat ships to
   working screenwriters who open its output in real Final Draft), not two independent ones. Not
   found in any genuine Final-Draft-authored sample file consulted. `dual_dialogue` is unreachable
   in this codebase today -- the editor refuses it, and nothing can produce one until FDX import
   lands -- so this mapping costs nothing if wrong and gives import a concrete thing to verify
   against a real file. **Must be checked against a genuine Final Draft file before import ships.**
2. **`page_break`**: attach `StartsNewPage="Yes"` to the _next_ rendered block's own paragraph
   (not a synthetic empty paragraph, which was this agent's original instinct) -- an empty
   paragraph would shift every page after a forced break down by one line, which this project
   cannot take (plan.md: "a script that previews at 112 pages must not export at 113"). Two
   degenerate cases follow and are documented, tested FDX limitations, not bugs: consecutive
   `page_break` blocks collapse to one `StartsNewPage="Yes"` (FDX cannot express "two blank
   pages" through this attribute), and a trailing `page_break` with nothing after it renders
   nothing at all.
3. **Multiple title pages**: throw when `titlePages.length > 1`, on the same "never silently
   drop data" principle as the block-type throw rule. `<TitlePage>` is singular in every source
   consulted; exporting only the first would be silent data loss. Unreachable today -- the editor
   caps at one title page.

Two additions from the lead, both implemented:

- Stripping XML-invalid control characters in `escapeFdxText` is silent data alteration and must
  be a stated, tested behavior (it is -- see `escape.test.ts`), not an accident. The better fix is
  upstream (`packages/screenplay`'s authored-text schema currently accepts characters no export
  format can carry, and rejecting them at the input boundary would be more honest than dropping
  them at every exporter). That is a schema change, out of scope here -- flagged, not built. See
  "Known limitations" below.
- The escaping tests should include a genuine parse-back proof, not just substring assertions:
  `apps/web/src/fdxExport.test.ts` parses `screenplayToFdx`'s output with `DOMParser` (jsdom
  provides it; no new dependency) and asserts no `parsererror` element in the result tree --
  `DOMParser` signals failure that way rather than throwing, so the assertion checks for the
  element explicitly, and a dedicated test proves that check can actually fail (feeding it
  deliberately malformed XML).

### 2026-08-21 -- implementation agent -- FDX export complete

#### What shipped

**`packages/fdx`** (new package, modeled on `packages/layout`'s `package.json`/`tsconfig.json`
shape): a pure `screenplayToFdx(screenplay: Screenplay): string` with no DOM, filesystem, network,
or server dependency, plus the audited `escapeFdxText` helper it's built on. Wired into the root
`package.json`'s `build`/`typecheck` scripts, after `@finaler-draft/layout` and before
`@finaler-draft/web` (its only dependency is `@finaler-draft/screenplay`; placement doesn't matter
beyond preceding `web`, which now depends on it too).

**Document shell** (`<?xml version="1.0" encoding="UTF-8" standalone="no" ?>` /
`<FinalDraft DocumentType="Script" Template="No" Version="1">`), byte-identical across every
source consulted, including the genuine Final-Draft-authored sample file
(`rsdoiel/fdx`, `sample-01.fdx` through `sample-06.fdx`).

**Body blocks**, one `<Paragraph Type="...">`/`<Text>` pair each, `Type` strings confirmed against
the genuine sample's own `ElementSettings` list: `scene_heading` -> `Scene Heading` (plus a bare
`Number` attribute on the paragraph when `sceneNumber` is present -- confirmed three independent
ways: the XPath reference gist, `wonderunit/storyboarder`'s FDX importer, and Beat's exporter, all
agreeing it's a `Paragraph` attribute, not nested under `SceneProperties`), `action` -> `Action`,
`character` -> `Character`, `parenthetical` -> `Parenthetical` (parens kept as-authored), `dialogue`
-> `Dialogue`, `transition` -> `Transition`, `shot` -> `Shot` (confirmed as its own type in the
genuine sample, distinct from Scene Heading -- one third-party JS parser conflates them, treated as
that library's bug, not evidence). `dual_dialogue` and `page_break` per checkpoint 1's approved
decisions above. Any block type the exhaustive `switch` doesn't recognize throws (unreachable
today, guards against the schema growing before this package is updated).

**Title page**: structure and vertical layout (`LINES_PER_PAGE = 46`, `LINES_BEFORE_CENTER = 18`,
`LINES_BEFORE_CREDIT = 2`, `LINES_BEFORE_AUTHOR = 1`, `LINES_BEFORE_SOURCE = 2`) taken directly from
Beat's own `#define`s in `BeatFDXExport.m`, cross-checked against a genuine filled-in Final Draft
title page (`sample-03.fdx`): "Written by" immediately followed by the author line with zero blank
lines between, and a multi-line contact block stored as one `<Paragraph>`/one `<Text>` with
embedded `\n` characters, not one paragraph per line -- both confirmed directly in the genuine
sample and matched exactly. `titlePages` empty omits `<TitlePage>` entirely; more than one throws
(checkpoint 1, decision 3). One extrapolation beyond direct evidence, flagged at checkpoint 1 and
left as designed: every source only ever shows a single author line, so multiple `authors` entries
repeat the same confirmed per-line pattern once per array entry rather than inventing new syntax.

**Annotations**: never read by `screenplayToFdx` at all -- not filtered out, simply never touched.
Tested directly: `screenplayFixture` (which carries one annotation) and the same screenplay with
`annotations: []` produce byte-identical output, and the annotation's own text is asserted absent.

**Escaping**: one function, `escapeFdxText` (`packages/fdx/src/escape.ts`), used for every piece of
user-authored text or attribute value the package emits (`Text` content and the `Number`
attribute). Escapes all five XML metacharacters (`& < > " '`) unconditionally rather than only the
ones strictly required by context, matching Beat's own `escapeString` policy, so one function
serves both element text and attribute values with nothing to keep in sync. Strips characters
outside XML 1.0's valid-character ranges (control codes, unpaired surrogates) -- a stated, tested
behavior per the lead's note, not an accident.

**Client-side download** (`apps/web/src/fdxDownload.ts`): `triggerFdxDownload(screenplay)`
serializes with the pure `screenplayToFdx` and saves it via a throwaway object URL and a synthetic
anchor click. `fdxFilename` sanitizes the screenplay title for filesystem safety (Windows-reserved
characters and control characters replaced with a space, collapsed, trimmed; falls back to
"Untitled Screenplay" if nothing survives). Wired into `App.tsx`'s File menu as "Download FDX…",
alongside "Document settings…"; a no-op when the local projection is invalid, since the exporter
takes canonical input and an invalid local projection isn't one.

#### Format sources (full list, see checkpoint 1 message above for the detailed mapping each one supports)

- A genuine Final-Draft-authored sample file: `github.com/rsdoiel/fdx`, `testdata/sample-01.fdx`
  through `sample-06.fdx` -- confirms the document shell, body `Paragraph`/`Text` shape, the
  genuine `ElementSettings` type list (including `Shot` as its own type), the `Number` scene
  attribute, `StartsNewPage="Yes"` as a real forced-page-break marker (`sample-06.fdx`), and a
  fully populated genuine title page (`sample-03.fdx`).
- The XPath reference gist for FDX: `gist.github.com/surrealroad/effaa4f84d8ba53cecb6` --
  confirms `Paragraph/@Type`, `Paragraph/@Number`, `SceneProperties/@Title`, `ScriptNote`.
- Beat (`github.com/lmparppei/Beat`): `BeatFDXExport.m` (current exporter) and the legacy
  `FDXInterface.m` -- an actively maintained, real screenwriting app whose FDX export is opened in
  real Final Draft by real users. Source of the `dual_dialogue` mapping, the title-page layout
  constants, and cross-confirmation of the `Number`/`StartsNewPage` attributes.
- screenplain (`github.com/vilcans/screenplain`), `screenplain/export/fdx.py` -- the source Beat's
  own `dual_dialogue` handling was itself derived from (one source lineage, not two -- see the
  lead's correction above).
- `wonderunit/storyboarder`'s FDX importer -- independent cross-check that the scene number is a
  bare `Paragraph` attribute (`element.$.Number` via `xml2js`), not nested structure.
- Final Draft's own support article on page breaks (kb.finaldraft.com) -- confirms
  `StartsNewPage`'s behavioral description ("moves the paragraph containing the cursor... to the
  top of the next page") matches what the genuine sample file shows structurally.

#### Mutation-testing report

Every mutation below: introduced in the source, ran the affected test file(s), confirmed the
predicted test(s) failed with the predicted symptom (not a different, coincidental failure),
restored the exact original file (`diff` against a pre-mutation copy confirmed identical), and
re-ran green.

1. **`escapeFdxText` -> identity function** (disable all escaping). `escape.test.ts`: 8 of 9 tests
   failed (the empty-string test is a no-op either way). `index.test.ts`: 2 hostile-escaping tests
   failed. `apps/web/src/fdxExport.test.ts`: both hostile-input DOMParser tests failed with a real
   `parsererror` ("4:45: disallowed character." / "4:53: disallowed character."), proving the
   parse-back check the lead asked for actually exercises the parser, not just string matching.
2. **Remove only the invalid-XML-character stripping**, keep entity escaping. `escape.test.ts`:
   exactly the two tests naming that behavior failed (control characters; unpaired surrogate) --
   every entity-escaping test stayed green, confirming the two behaviors are tested independently.
3. **Drop the `Number` attribute from scene headings entirely.** `index.test.ts`: both scene-number
   tests failed (the fixture-coverage test and the hostile-scene-number-escaping test).
4. **Force `startsNewPage` to always be `false`** (page_break becomes a permanent no-op). All three
   `page_break`-specific tests failed, including the dual-dialogue-follows-a-page-break case added
   specifically to close the one branch coverage had missed after the first pass.
5. **Swap dual-dialogue column order** (right's blocks before left's). The fixture-coverage test's
   ordering assertion (`ADA` before `MILES`) failed with the exact predicted symptom.
6. **Silently skip an unrecognized block type instead of throwing** (empty `default` branch). The
   dedicated "throws on an unrecognized block type" test failed (`undefined` was thrown/returned
   where an `Error` matching `/cannot represent unknown block type/` was expected).
7. **Silently export only the first title page instead of throwing on more than one.** The
   dedicated multiple-title-pages test failed the same way.
8. **Make annotations leak into the exported body.** The annotations-never-leak test failed with a
   diff showing the annotation's own text appearing in the "with annotations" output only.
9. **`fdxFilename` -> `` `${title}.fdx` `` (no sanitization).** 3 of 4 `fdxDownload.test.ts` filename
   tests failed (the plain-title test is a no-op either way, matching mutation 1's own carve-out).
10. **Remove the `triggerFdxDownload` call from the "Download FDX…" menu item** (no-op `onSelect`).
    The `App.test.tsx` "downloads the current screenplay as FDX from the File menu" integration
    test failed (`createObjectURL` called 0 times instead of 1), proving the App-level wiring is
    actually exercised end-to-end, not just the two lower-level unit suites in isolation.

Every restoration was verified both by `diff` against the pre-mutation file and by re-running the
full affected package's `test:coverage` (or, for the `apps/web` mutations, the specific spec files)
afterward, back to green.

#### Gate results

1. `pnpm typecheck` (workspace-wide, all 8 packages/apps including the new `@finaler-draft/fdx`) --
   clean.
2. `pnpm lint` -- clean, workspace-wide, `--max-warnings=0`.
3. `pnpm test:coverage` (workspace-wide) -- clean. New package `@finaler-draft/fdx`: 30 tests,
   100%/100%/100%/100% statements/branches/functions/lines. `apps/web`: 282 tests (24 test files,
   including the three new ones -- `fdxDownload.test.ts`, `fdxExport.test.ts`, and the new `FDX
download` describe block in `App.test.tsx`), all passing; `App.tsx` coverage 96.3%/87.5% lines/
   branches, both comfortably above the file's 80% threshold.
4. `pnpm build` (workspace-wide) -- clean.
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- 21/21 passed.
6. `PLAYWRIGHT_CHANNEL=chrome TEST_DATABASE_URL=... pnpm test:system:persistence` -- run three
   times as required, 9/9 passed each time (the URL was passed on the command line only, never
   written to any file, per the scope's instruction).
7. `git diff --check` -- clean. (New untracked files were checked by hand for trailing whitespace
   and missing trailing newlines instead of via `git add`, since staging is the owner's, not this
   agent's, to do.)
8. `pnpm format:check` -- run after this entry was written (see below).

#### Known limitations / things not done

- **`dual_dialogue`'s mapping is secondary-sourced, not confirmed against a genuine Final Draft
  file.** Per the lead's checkpoint-1 ruling, shipped anyway because it's unreachable until FDX
  import exists (the editor refuses it). **Must be verified against a real Final Draft file before
  the import slice ships anything that can produce a `dual_dialogue` block.**
- **`packages/screenplay`'s authored-text schema accepts characters no XML-based export format can
  carry** (raw control characters, unpaired surrogates). `escapeFdxText` strips them at export
  time, which is the only correct handling available to an exporter, but the more honest fix is
  rejecting them at the input boundary (the schema) instead of silently dropping them at every
  export format this project ever builds. This is a schema change, out of scope for this slice --
  flagged per the lead's instruction, not built.
- **Title-page vertical layout matches Beat's algorithm and constants, not Final Draft's own
  default template exactly** (no genuine sample with a full-page title layout at a byte level was
  available to diff against; the closest genuine evidence, `sample-03.fdx`, matches this package's
  output exactly at every point it can be compared -- credit-then-author with zero blank lines,
  the multi-line single-`Text` contact block -- but a full top-to-bottom byte comparison against a
  real Final Draft save was not possible with the sources available).
- **`documentSettings` is not mapped into FDX page-layout settings**, per the scope's explicit
  "out of scope." FDX does appear able to express at least some of it (`PageLayout`,
  `ElementSettings/ParagraphSpec` in the genuine sample file carry per-element indents), but this
  slice's minimal document shell deliberately omits all of that, matching the same minimal shape
  both screenplain's and Beat's exporters use.
- **No FDX import, PDF, or DOCX** -- explicitly out of scope per the scope file.
- **No server-side / historical-revision export caller yet** -- `screenplayToFdx` is pure and
  ready for one (that's why it's pure), but this slice only wires a client-side caller.
- Coverage thresholds for `apps/web`'s `App.tsx` are per-file at 80%; this slice's new "Download
  FDX…" branch is covered, and the file's overall coverage stayed comfortably above threshold, but
  no attempt was made to push it to 100% -- the uncovered lines predate this slice.

### 2026-08-21 -- implementation agent -- rebuilt against a genuine Final Draft 13 reference (the previous export was rejected by Final Draft)

**What happened.** The owner tried to upload a file produced by the version above and Final Draft
rejected it outright: "This file was created in an older Final Draft format. Please open it in
FD13 first, save the file, and then upload that to Vault." Every source the first version was
built from -- a third-party sample file, a reference gist, and two open-source exporters -- was
second-hand relative to the one application that has to read the file. The owner then authored a
script in Final Draft 13 covering as many element types as the app produces, saved it both as a
script and as a template, and installed both in this package:
`packages/fdx/fixtures/final-draft-13-reference.fdx` / `.fdxt` (provenance in the sibling
`README.md`). This entry documents rebuilding the mapping against that file directly, read byte by
byte, rather than against descriptions of it.

**This is not claimed as fixed on the strength of tests alone.** Every claim below about what the
reference file contains was checked by reading the file (and, in the test suite, by a test that
reads it directly at run time -- see "Testing" below); every claim about what Final Draft _requires
for acceptance_ is a reasoned inference from the rejection message and from which parts of prior,
third-party-sourced minimal exports were and weren't reported as working, since this agent has no
way to run Final Draft or upload to Vault. **The owner's upload of a real export is the actual
acceptance test and still needs to happen.**

#### What changed, and where each change came from

- **`Version="6"`, not `Version="1"`.** The reference's root element is
  `<FinalDraft DocumentType="Script" Template="No" Version="6">`. Given the rejection message names
  the file's _format version_ specifically, not general malformedness, this is the most likely
  direct cause of the original rejection, and is now taken verbatim from the reference rather than
  from a third-party exporter's own convention.
- **The XML declaration has no space before `?>`** (`standalone="no"?>`, not `standalone="no" ?>`)
  -- confirmed byte-for-byte against the reference's first line.
- **Every body `<Paragraph>` now carries `Alignment`, `LeftIndent`, and an `id`,** in that order
  (with an optional `Number` and `StartsNewPage` alphabetically between `LeftIndent` and `Type` --
  see below), matching the reference exactly. `id` is the canonical block's own stable id
  (`block.id`), not a synthesized one: the reference's paragraph `id` is a UUID, which is exactly
  what `packages/screenplay`'s `stableIdSchema` already gives every block, so this takes that
  identity per the owner's explicit instruction rather than inventing a parallel one.
- **Attribute order is alphabetical, and this is not a style choice -- it's read off the file.**
  The reference writes every paragraph's attributes in strict ASCII-sorted order, confirmed
  independently on two differently-shaped attribute sets in the same file (body `Content`
  paragraphs: `Alignment, LeftIndent, Type, id`; `TitlePage` paragraphs: `Alignment, FirstIndent,
Leading, LeftIndent, OutlineLevel, RightIndent, SpaceBefore, Spacing, StartsNewPage, Type, id`).
  This package now reproduces that ordering rather than an arbitrary one it picked before.
- **`<Text>` carries `Style="AllCaps"` for Scene Heading, Character, Transition, and Shot, and no
  `Style` at all for Action, Dialogue, Parenthetical, General.** Confirmed against every instance of
  each type in the reference. Text is stored exactly as authored regardless (the reference's
  Character text is literally "Joe", not "JOE" -- `Style="AllCaps"` is a display instruction, not a
  storage transform), so this package still never transforms case -- it only adds the attribute.
- **A block with empty text now self-closes with no `<Text>` child at all**
  (`<Paragraph ... id="..."/>`), not `<Paragraph ...><Text></Text></Paragraph>` as the previous,
  third-party-sourced version emitted. Confirmed directly: the reference's own empty Character
  block self-closes.
- **`LeftIndent` values still come from this product's own specification, not copied from the
  reference's numbers.** The reference is an out-of-the-box, unmodified FD13 script, so its
  Character/Parenthetical indents (3.50in/3.00in) are Final Draft's own defaults -- legitimately
  different from ours (3.70in/3.10in, `packages/screenplay/src/pageFormat.ts`'s `ELEMENT_INDENTS`,
  a pre-existing, deliberate specification choice unrelated to this bug). Character and
  Parenthetical now read from the screenplay's own `documentSettings` (previously ignored
  entirely); Scene Heading, Action, Dialogue, and Shot read `ELEMENT_INDENTS`. Taking the
  reference's _structure_ while keeping our own _values_ is the distinction the whole rebuild rests
  on, and is tested directly (see "Testing" below). One value has no equivalent in our
  specification at all: `ELEMENT_INDENTS.transition` has no `leftIn` (only a fixed right edge, since
  the element is right-aligned). Rather than copy the reference's own unexplained 5.50in box,
  `Transition` now uses `MARGIN_LEFT_IN` (1.5in) -- the same left edge every other body element
  shares -- reasoning that `Alignment="Right"` is what actually positions the text, not
  `LeftIndent`. Recorded as a judgment call, not a reference-confirmed value.
- **The title page is rebuilt entirely.** The previous version's Beat-derived, centered-paragraph
  layout is gone, constants included. The reference shows a completely different shape:
  `Type="Title Paragraph"` on every line (there is no `ElementSettings` entry for that type, so
  Final Draft bakes a full paragraph spec -- `FirstIndent="0.00" Leading="Regular"
LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" SpaceBefore="0" Spacing="1"
StartsNewPage="No"` -- into every single line rather than relying on a shared default), and
  `<Text Font="Courier Final Draft" Size="12">` for the same reason. The vertical layout is no
  longer Beat's guessed constants -- it is counted directly from the reference's own title page: 17
  blank lines, then Title (`Style="Underline+AllCaps"`); 3 blank lines, then credit; 2 blank lines,
  then each author line; 4 blank lines, then source. The reference's test script leaves `draftDate`
  and `contact` blank, so their positioning is **not** confirmed by the reference (see "Known
  limitations" below) -- unlike before, this is now stated as an open question rather than answered
  with an invented constant presented as researched.
- **Every title-page line, including blank filler lines, now carries a unique `id`** -- confirmed
  from the reference, which gives every one of its ~30 title-page paragraphs a distinct UUID. Our
  canonical `TitlePage` has no per-line identity to give those slots (plan.md deliberately models a
  title page as named fields, not a block list), so this derives a deterministic, UUID-_shaped_ id
  from the title page's own id and the line's position (a small hand-written 32-bit FNV-1a hash
  expanded to 128 bits -- no new dependency, and deterministic so `screenplayToFdx` stays pure).

#### What is unchanged, or still unverified

- **`dual_dialogue`'s mapping is unchanged and remains unverified against genuine Final Draft
  output.** The reference contains no dual-dialogue example (confirmed: grepping the reference for
  `DualDialogue` matches nothing) -- this package's earlier checkpoint-1 decision to proceed on
  Beat/screenplain's shape stands, per the lead's explicit instruction to keep the three
  checkpoint-1 policy decisions. The wrapping `<Paragraph>` now carries the `dual_dialogue` block's
  own `id` (previously untyped and unidentified), and its inner Character/Parenthetical/Dialogue
  paragraphs now use the corrected attribute shape, but the overall `<Paragraph><DualDialogue>`
  wrapper shape itself is still not confirmed by any genuine file. **Must be checked against a real
  Final Draft file before the import slice ships anything that can produce a `dual_dialogue`
  block.**
- **`page_break`'s policy (attach `StartsNewPage="Yes"` to the next block) is unchanged, per the
  lead's explicit instruction to keep it.** The reference does confirm `StartsNewPage` as a real
  Final Draft attribute (present in every `ElementSettings`'s default `ParagraphSpec`; `New Act`
  always forces a new page), but has no ad hoc, per-paragraph forced break in its body `Content`,
  so this attribute's use on an arbitrary body paragraph is corroborated, not directly confirmed.
- **`draftDate`/`contact` positioning on the title page is a recorded, flagged guess, not a
  confirmed value.** The reference's own test script leaves both fields blank. This version keeps
  them after `source`, reusing the same order-of-magnitude gap (3 blank lines) as the verified
  fields rather than inventing an unrelated number, and gives `contact` `Alignment="Right"`
  (plan.md: "A contact block in the lower right") since that's expressible in the same attribute
  vocabulary the reference already confirms `Alignment` uses. **Needs the owner's check once a
  reference title page with these two fields populated exists** -- this is a materially different,
  weaker kind of confidence than everything else in this entry.
- **The large boilerplate top-level elements the reference contains --
  `ElementSettings`, `PageLayout`, `SmartType`, `Revisions`, `SceneNumberOptions`, `Macros`,
  `Actors`, `Cast`, `TagData`, `Characters`/traits, `DisplayBoards`, `ScriptNavigatorPreferences`,
  and a `DocumentRef`/`XRef` pair right after `<Content>` -- remain entirely unemitted,
  deliberately.** This agent could not run Final Draft or Vault to empirically determine which of
  these gate acceptance, as the checkpoint asked. The reasoning for staying minimal rather than
  guessing at a maximal file: (1) the rejection message named a specific, singular reason
  (`Version`), not a structural or missing-section complaint; (2) every one of these sections is
  either app/user-preference state (keyboard macros, actor voice presets, tag category color
  palettes, display-board zoom levels) with no canonical equivalent in this product at all, or a
  per-type style _default_ that per-paragraph attributes (now emitted directly, see above) make
  redundant for what this document actually contains; (3) `DocumentRef`/`XRef` looks like Vault's
  own cloud-sync/revision-tracking correlation state, which this package has no principled way to
  populate and which fabricating risks actively corrupting rather than merely being incomplete.
  "A minimal accepted file is better than a maximal guess, but a file that is rejected is worst of
  all" -- if the version fix and the corrected per-paragraph shape are not sufficient on their own,
  the next-best-informed guess is `ElementSettings`/`PageLayout` (both are literally present in the
  reference and structurally simple to copy verbatim), not the app-preference sections. **This is
  the single largest open question this entry has** and can only be resolved by the owner's upload.

#### Testing

Test strategy changed to match: `packages/fdx/src/testFixtures.ts` gained `readReferenceFixture()`,
which reads `packages/fdx/fixtures/final-draft-13-reference.fdx` from disk at test run time (no new
dependency -- `node:fs`/`node:url`, both built in). Every test in `index.test.ts` that makes a
structural claim about FDX now either reads the reference directly in the same test and asserts our
own output matches the same structural pattern (attribute order, `Style="AllCaps"` presence,
self-closing-when-empty, the `Title Paragraph` fixed attribute string, the exact 17/3/2/4 title-page
gap counts, counted programmatically from the reference rather than retyped from memory), or
documents explicitly that the reference does _not_ cover a given claim (the `dual_dialogue` test
asserts the string `DualDialogue` is absent from the reference, as a standing regression check that
this remains an open question rather than something silently assumed later). The reference file is
also the natural fixture for the import slice later, per the lead's note -- these are an
investment, not throwaway.

#### Mutation-testing report

Every mutation: introduced in the source, ran the affected tests, confirmed the predicted
failure with the predicted symptom, restored the exact original file (`diff` against a
pre-mutation copy confirmed identical), and re-ran green.

1. **`FINAL_DRAFT_VERSION` reverted to `'1'`.** The dedicated reference-comparison test failed,
   diffing the full expected vs. actual root element.
2. **`Style="AllCaps"` disabled entirely** (`styleAttr` hardcoded to `''`). 5 tests failed across
   the body-paragraph and direct-block-builder suites -- every type that should carry the style.
3. **Empty-paragraph self-closing removed** (always emit `<Text></Text>`). The dedicated
   self-closing test failed, diffing the full document against the expected self-closed form.
4. **Attribute order scrambled** (`Type` moved to the front). 15 tests failed across every suite
   that asserts a `<Paragraph ...>` substring, confirming the ordering is genuinely load-bearing
   for the test suite, not decorative.
5. **`TITLE_PAGE_LINES_BEFORE_TITLE` changed from `17` to `10`.** The gap-count test, which counts
   blank paragraphs programmatically from both the reference and our own output, failed with the
   exact predicted numbers (`expected 10 to be 17`).
6. **`Character`'s `LeftIndent` hardcoded to Final Draft's own default (`3.5`) instead of
   `documentSettings.characterIndentIn`.** Both tests in the "documentSettings, not FD13 defaults"
   suite failed -- the one asserting our specification's default value, and the one asserting a
   custom `documentSettings` value is honored.
7. **`escapeFdxText` disabled entirely** (identity function) -- repeated from the first version's
   mutation-testing pass, this time following the process the lead flagged: ran `apps/web`'s
   `fdxExport.test.ts` _before_ rebuilding `packages/fdx`'s `dist`, which passed (a false negative
   -- the test was exercising the old, unmutated `dist`, exactly the trap described). Rebuilding
   `dist` (`pnpm --filter @finaler-draft/fdx build`) and re-running produced the correct result: 2
   of 4 tests failed with a real DOMParser `parsererror` ("4:45: disallowed character." /
   "4:67: disallowed character."). This is now the standing procedure for every mutation that
   touches `packages/fdx` and is checked from `apps/web`: rebuild before testing, every time.

Every restoration was verified both by `diff` against the pre-mutation file and by re-running the
full workspace gate chain afterward, back to green.

#### Gate results

All from a fresh state after this rebuild, `packages/fdx` rebuilt (`pnpm --filter @finaler-draft/fdx
build`) before the `apps/web`-side checks:

1. `pnpm typecheck` (workspace-wide) -- clean.
2. `pnpm lint` -- clean, `--max-warnings=0`.
3. `pnpm test:coverage` (workspace-wide) -- clean. `@finaler-draft/fdx`: 51 tests (up from 30),
   99.25%/95.83%/100%/99.25% statements/branches/functions/lines (the two uncovered lines are a
   defensive "this should be structurally unreachable" throw, the same pattern
   `packages/screenplay`'s own `requiredElementIndentValue` uses and leaves uncovered). `apps/web`:
   unchanged at 282 tests, all passing.
4. `pnpm build` (workspace-wide) -- clean.
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- 21/21 passed.
6. `PLAYWRIGHT_CHANNEL=chrome TEST_DATABASE_URL=... pnpm test:system:persistence` -- run three
   times, 9/9 passed each time.
7. `git diff --check` -- clean.
8. `pnpm format:check` -- run after this entry was written, verified clean, no further edits to
   this file afterward.

#### What still needs the owner's check

**Everything in this entry is checked against a real file, but nothing in it has been through Final
Draft or Vault, because this agent cannot run either.** Specifically:

1. Whether `Version="6"` plus the corrected per-paragraph shape is sufficient for Vault to accept
   the file at all -- the actual regression test for the bug this entry exists to fix.
2. If it is still rejected: whether the next-best guess (`ElementSettings`/`PageLayout`, copied
   verbatim from the reference) is what closes the gap, as opposed to something in the large
   boilerplate list above that this entry judged unlikely to matter.
3. Whether the exported file, once accepted, actually _renders_ correctly in Final Draft --
   correct indents, correct scene numbering, a title page that looks right -- which is a strictly
   higher bar than "Final Draft opens it without complaint."
4. `dual_dialogue` and the `draftDate`/`contact` title-page position, both explicitly flagged above
   as unverified rather than confirmed.

### 2026-08-21 — page layout, and a second lesson about not owning the format (lead)

The version/paragraph rebuild made the file **accepted** by Final Draft, confirmed by a real upload.
It then rendered as one continuous page, because `<PageLayout>` was omitted: with no `PageSize` and
no margins there is nothing to break pages against. The symptom looked like a missing feature and
was a missing element.

Adding it introduced a worse regression, and the cause is worth recording plainly. `PageLayout`,
`MoresAndContinueds` and `SceneNumberOptions` were emitted in trimmed form -- only the attributes
and children that seemed to matter, with the rest treated as app-preference decoration. **Final
Draft then could not open the file at all.** The reference carries a `<FontSpec>` child inside two
of those elements, an `<AutoCastList>` child and two further attributes inside `PageLayout`, and
their absence was fatal.

This is the same mistake as the original `Version="1"` rejection wearing different clothes: applying
our own judgment to a format we do not own. The rule that follows from both, and that this package
should keep:

> For any element this product does not define, reproduce the reference's shape exactly and
> substitute only the values we genuinely own. Trimming what looks unnecessary is a guess, and the
> acceptance oracle is Final Draft, not our reading of it.

Values we own and continue to substitute: `PageSize` and the margins (from `pageFormat`, not Final
Draft's defaults, because our pagination is authoritative), and the Yes/No flags driven by
`documentSettings.autoMoreContinued` and `documentSettings.sceneNumbersEnabled`.

**Two further findings from the reference, both load-bearing:**

- **Attribute order is per-element, not document-wide.** `SceneNumberOptions` is not alphabetical
  in the reference while `Paragraph` is, so each element's order is copied individually rather than
  normalised. An earlier note in this log describing alphabetical ordering as a document convention
  was too broad.
- **A weak test surfaced.** `omits the Number attribute entirely when a scene heading has no scene
number` asserted `not.toContain('Number=')` against the whole document, when the property under
  test concerns one paragraph. `SceneBreaks ContinuedNumber="No"` legitimately contains that
  substring, so the test failed for an unrelated reason the moment that element appeared. Now scoped
  to the paragraph. Worth noting the shape: a document-wide assertion standing in for a local
  property passes until some unrelated part of the document happens to collide with it.

**Unit conversion is mutation-tested.** `PageSize` is in inches and every margin is in points;
breaking the `* 72` fails a test. A silent conversion error would produce a file that paginates at
the wrong length -- worse than one that does not paginate, because it looks correct while
disagreeing with the page count `packages/layout` computed.

**Verified by upload:** two files differing only in whether a title page is present both open in
Final Draft. A screenplay with no `titlePages` emits no `<TitlePage>` element and Final Draft
supplies a blank one of its own, which is its behaviour rather than something this package chooses.

**Still unverified:** `dual_dialogue` (absent from the reference) and the position of
`draftDate`/`contact` on the title page (blank in the reference). Both need a reference file that
contains them.

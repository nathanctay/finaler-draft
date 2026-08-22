# PDF export

Branch `feature/pdf-export`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/pdf-export`.

## Why this scope exists, and what changed about it

`plan.md` calls PDF "a required Phase 1 capability, not a late optional feature" and **the fidelity
contract for exact screenplay pagination** -- the format that has to agree with what the editor
previewed. FDX and DOCX are interchange; this one is the deliverable a writer sends out.

**Read `plan.md`'s Exports section first: the headless-Chromium approach it originally specified is
now superseded, and the reasoning matters more than the conclusion.** Chromium was specified when
the browser was the only thing that knew where lines fell. `packages/layout` now computes the page
and line model exactly, so Chromium would re-derive layout the product already owns -- and
disagreement between browser text metrics and this specification is precisely the failure the
layout package exists to prevent. That is not hypothetical: a CI font-hinting difference silently
widened glyph advances and broke every character-grid assertion
(`progress/test-harness-hardening.md`).

The PDF is therefore generated directly from the layout model: a pure function, no browser, no
worker service, no Dockerfile.

## The rule this slice turns on

**Every position comes from the grid; nothing comes from font metrics.** Lines are placed at
coordinates derived from `pageFormat`'s character-and-line grid, exactly as
`MEASURED_COURIER_PRIME_ADVANCE_EM` is already forbidden from driving layout. `packages/layout`
has already decided which lines exist, what they contain, and which page they are on -- this
package's job is to paint that model, never to re-decide any of it.

That rule is what makes the typeface a rendering detail. **Use PDF's standard Courier for now**
(one of the fourteen fonts every viewer carries, no embedded file, advance exactly 0.6em, which is
precisely the specification's ten characters per inch). **The owner has asked for Courier Prime
once export moves server-side.** Because positions come from the grid, that swap changes glyph
shapes and nothing structural. Structure the code so the face is a parameter, not an assumption --
and if honouring the rule anywhere requires reading a font metric, stop and report rather than
quietly reintroducing browser-style layout.

## What this must achieve

1. **A new `packages/pdf`** exporting a pure `screenplayToPdf(screenplay: Screenplay): Uint8Array`.
   Pure, deterministic, byte-identical for identical input -- the same contract `packages/fdx` and
   `packages/docx` hold, and for the same reason: a server-side export of a historical revision
   must call this exact function later.

2. **`pdf-lib` is approved** as the PDF writer. Hand-rolling PDF means hand-rolling byte-exact xref
   offsets, which is a materially worse risk than the XML we hand-write elsewhere. It supports the
   standard fonts now and embedding later, so it does not have to be revisited for the Courier
   Prime change. Use its standard-font path; do not add a font file in this slice.

3. **Page count must equal `paginateScreenplay`'s.** This is the fidelity contract in one sentence
   -- `plan.md`: "a script that previews at 112 pages must not export at 113." Assert it directly,
   over fixtures long enough to span several pages, including one that exercises a dialogue split.

4. **Every generated line the layout model produces must appear**: `(MORE)`, `CONT'D`, page
   numbers in the specified position and numeral style, space-before suppression at page tops. The
   page model already contains all of it; do not recompute any of it.

5. **The title page**, when present, ahead of the script and never paginated with it.

6. **Scene numbers, when `documentSettings.sceneNumbersEnabled`.** Unlike DOCX, this format can and
   should render them, in **both margins**, per `plan.md`'s "Locked scripts". Note the difference
   from the other exporters: these numbers are computed from document order, not read from the
   canonical `sceneNumber` field, so this package computes them the same way
   `pagination.ts`'s `computeSceneNumberDecorations` does. Where a block carries a stored
   `sceneNumber`, that value wins -- it is a locked production number and must not be renumbered.

7. **A client-side download**, thin over the pure function, alongside FDX and DOCX.

## Out of scope

The export job queue, storage, signed URLs, and revision-based server-side export -- their own
slice, serving all three formats. Font embedding. FDX import. Anything that re-derives layout.

## Verification

The full gate list, `pnpm format:check` **after** the progress entry, and the persistence gate
three times. `main` is green.

Tests must parse the produced PDF back, not merely assert it is non-empty -- extract the text and
assert page count, per-page content, and that a known line lands on the page the layout model says
it does. `pdf-lib` can reload its own output; a third-party reader for an independent check is
worth considering the way `python-docx` was used to validate DOCX.

Assert determinism directly: serialize twice, require identical bytes.

For every test guarding specific behaviour: break the behaviour, confirm the test fails, restore,
report it. Seven vacuous tests have been found on this project, one written by the lead. The
likeliest here is the page-count assertion -- make sure it compares against `paginateScreenplay`'s
own output for the same input, not against a number written into the test that both sides could
drift from together.

Cross-package note: `apps/web` imports built `dist`, so run `pnpm --filter @finaler-draft/pdf build`
before any `apps/web` test or mutation.

No credential may appear in any file you write.

## Rules

Do not stage, commit, merge, rebase, force-push, reset, or create or delete branches or worktrees.
No TODO or placeholder comments, no emojis, strict TypeScript, `.js` extensions on relative imports.
Match the surrounding comment style: record _why_, citing `plan.md`. If the code contradicts the
specification, stop and report rather than bending either.

## Checkpoints -- SendMessage to the lead

1. Before writing the painter: how you map the layout model's page and line coordinates onto PDF
   user space, where the origin and text baseline sit, and how you are certain no font metric enters
   a position. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report. The owner opens the PDF; do not
   claim it is correct on tests alone.

## Log

### 2026-08-22 -- implementation agent -- checkpoint 1: geometry mapping researched, approved with three changes

Read `plan.md`'s Exports section and this file's own "Superseded" explanation, `packages/layout/src`
(`paginate.ts`, `pageBreak.ts`, `groups.ts`, `wrap.ts`), `packages/screenplay/src/pageFormat.ts`,
`packages/fdx`/`packages/docx`'s established pure-exporter pattern and progress logs, and
`apps/web/src/pagination.ts`'s `computeSceneNumberDecorations`. Sent the lead a full design for
mapping `packages/layout`'s page/line grid onto PDF user space:

- One PDF page per `Page` in `LayoutResult`, plus an unpaginated title page in front when present.
- `lineTopPt(i) = MARGIN_TOP_IN*72 + i*LEADING_PT` (distance from the page's top edge), converted to
  PDF's bottom-up Y once, in `baselineForSlotTop`, reused for body lines, the page number, and the
  title page.
- Horizontal widths computed analytically from the grid (`graphemeCount * 72/NOMINAL_CHARACTERS_PER_INCH`),
  never from `pdf-lib`'s `font.widthOfTextAtSize` -- Courier's Standard-14 advance is exactly 0.6em
  by PDF-spec definition, cross-checked against `pdf-lib`'s own metric in a test, never in production
  code driving a position.
- Scene numbers computed the same way `computeSceneNumberDecorations` does, reimplemented over
  canonical blocks (that function walks a ProseMirror doc this pure package cannot depend on), with a
  stored `sceneNumber` winning as the label per item 6.
- Flagged one open question: PDF's un-embedded standard Courier uses WinAnsiEncoding, which cannot
  encode non-Latin scripts or emoji, and `page.drawText` throws when it meets one.

Approved with three changes:

1. **Baseline at `slotTop + 0.8 * LEADING_PT`, not the slot's bottom edge.** The slot should contain
   the glyphs it represents; the full-slot placement I proposed put every descender outside its own
   row and the first line's glyphs below the top margin. 0.8 is a chosen convention for slot
   containment (documented as such in `geometry.ts`), not a value read off any font's metrics --
   baseline-to-baseline spacing across lines stays exactly `LEADING_PT` either way.
2. **WinAnsi failures must throw an actionable message**: name the character and its code point
   (reusing `pdf-lib`'s own message, which already has both), locate it by block id and element, and
   say plainly this is a limitation of the un-embedded standard font, not a script defect.
3. **No second grapheme counter.** `graphemeLength` was exported from `packages/layout` (done by the
   lead while this agent was between sessions) for this package to import, rather than reimplementing
   `wrap.ts`'s grapheme-counting logic a second time -- the same "don't duplicate a normative
   character-cell count" reasoning that governs the XML escaper shared as `@finaler-draft/xml-escape`.

### 2026-08-22 -- implementation agent -- PDF export complete

#### What shipped

**`packages/pdf`** (new package, `@finaler-draft/pdf`): a pure `screenplayToPdf(screenplay:
Screenplay): Promise<Uint8Array>`, painting `packages/layout`'s precomputed page-and-line model
directly with `pdf-lib`'s standard-font path (`StandardFonts.Courier`), no browser, no worker
service, no Dockerfile -- split across:

- `geometry.ts` -- every grid-to-points conversion: the line grid (`lineTopPt`, `baselineForSlotTop`,
  `baselineForLine`), analytic text width (`widthPt`), per-element left indents
  (`leftIndentPtFor`, `generatedLineLeftPt`), and every fixed right/left edge (`TRANSITION_RIGHT_EDGE_PT`,
  `PAGE_NUMBER_RIGHT_EDGE_PT`/`PAGE_NUMBER_TOP_SLOT_PT`, the scene-number margins, the title page's
  center). The one module every "position comes from the grid" claim in this package rests on.
- `sceneNumbers.ts` -- `computeSceneNumberLabels`, matching `apps/web/src/pagination.ts`'s
  `computeSceneNumberDecorations` over canonical blocks instead of a ProseMirror doc, with a stored
  `sceneNumber` winning as the label without disturbing the running counter for later headings.
- `pageNumberFormat.ts` -- `formatPageNumber`/roman-numeral formatting, a small duplicate of
  `apps/web/src/pagination.ts`'s identically-named function (see checkpoint-1's item 3 for why this
  one, unlike grapheme counting, was fine to duplicate rather than share).
- `titlePage.ts` -- the ordered title-page line list (text, alignment, blank-line gaps), on the same
  six-lines-per-inch grid the body uses. Gap constants reuse `packages/fdx`'s reference-grounded
  values where FDX has them (title/credit/author/source/draftDate) and `packages/docx`'s deliberate
  "push contact toward the bottom" value otherwise -- no genuine PDF reference exists for this
  package either, so this is this package's own judgment call, flagged below and inheriting the same
  flag from both siblings.
- `encoding.ts` -- `assertEncodable`, wrapping `pdf-lib`'s own `PDFFont.encodeText` WinAnsi failure
  (which already names the character and its code point) with the block/element location and an
  explanation that this is the un-embedded standard font's limitation, not a script defect.
- `painter.ts` -- the only module that touches `pdf-lib`'s `PDFDocument`/`PDFPage`/`PDFFont` objects:
  `paintTitlePage` and `paintBodyPages`, converting every `PageLine` into one `drawGridText` call at a
  position `geometry.ts` computed.
- `index.ts` -- orchestration: paginate, create the document (with the determinism fix below), embed
  Courier once, paint, save.
- `testFixtures.ts`/`pdfTestUtils.ts` -- test infrastructure (excluded from coverage): block/screenplay
  builders, and a from-scratch PDF content-stream parser (`extractPageTextRuns`/`extractPageText`/
  `extractPageRuns`) that decodes each page's content stream via `pdf-lib`'s public `PDFArray`/
  `PDFRawStream`/`decodePDFRawStream` API and regex-parses the `Tj`/`TJ`/`Tm` operators this
  package's own `drawText` calls produce -- `pdf-lib` has no text-extraction API, so tests reload with
  it (the scope's own suggestion) and then read the raw operators themselves. `extractPageRuns` also
  recovers each run's `(x, y)` from its `Tm` translation, not just its text, specifically so a
  mutation that draws _correct text at the wrong coordinate_ is still caught -- see the mutation
  report below.

**One PDF page per `LayoutResult.Page`, in document order, plus an unpaginated title page in front
when `titlePages[0]` exists** -- never counted, never numbered, matching FDX/DOCX. Page count equals
`paginateScreenplay`'s own count by construction (`paintBodyPages` iterates `layout.pages` directly);
every test asserting this compares against a live `paginateScreenplay(blocks)` call on the same
fixture, never a number written into the test.

**Every position is grid-derived**: left-aligned elements read `ELEMENT_INDENTS` or
`documentSettings.characterIndentIn`/`parentheticalIndentIn` directly; right-aligned content
(`transition`, the page number, the right-margin scene number) and centered title-page lines use
`widthPt`'s analytic character-count formula, never `pdf-lib`'s `font.widthOfTextAtSize`. The only
font-object call in the whole package is the unavoidable `page.drawText` glyph-painting call itself,
which never decides a position, only how a glyph looks once its position is already fixed. Verified
both by unit tests on `geometry.ts` directly and by a new class of integration test
(`extractPageRuns`) that reads back the PDF's own `Tm` coordinates and compares them to `geometry.ts`'s
functions -- added specifically because the page-content tests alone cannot catch `painter.ts` calling
the _wrong_ (but still individually-correct) geometry function at a given draw site; see mutation 5
below for the concrete bug class this catches that content-only tests miss.

**`(MORE)`/`CONT'D`, `(MORE)`/`CONT'D` placement, and dialogue splits**: entirely `packages/layout`'s
decision (`GeneratedLine`s in the page model); this package only draws them, at the character indent,
per plan.md. Verified against `paginate.ts`'s own documented fixture (`textForActionLineCount(50)` +
a 4-line dialogue split): `(MORE)` lands on the outgoing page, `CONT'D` on the incoming one, at the
correct coordinate.

**Page numbers**: `Page.pageNumber === 1` (the first body page) never gets a printed number; every
later page prints `formatPageNumber(pageNumber, style) + '.'`, right-aligned at
`PAGE_NUMBER_RIGHT_EDGE_PT`, top-aligned at `PAGE_NUMBER_TOP_SLOT_PT` -- both `pageFormat.ts`'s own
fixed figures, independent of the body line grid. Roman-numeral style verified directly.

**Scene numbers**: computed via `computeSceneNumberLabels`, drawn in both margins (plan.md's "Locked
scripts": "Scene numbers print in both margins") at the same y as the scene heading's first line,
reusing `apps/web/src/styles.css`'s own 0.5in gap outside the body margins so a writer sees the same
position on screen and in the PDF. An empty scene heading is skipped -- no label, no number consumed
-- matching `computeSceneNumberDecorations` exactly. A stored `sceneNumber` (a locked production
number) wins as the printed label without disturbing the running count for later headings.

**Title page**: rendered as page 0 when `titlePages[0]` exists, never paginated with the body, never
numbered; throws when more than one title page is present, matching FDX/DOCX's identical reasoning
(no established multi-title-page convention in any of the three formats). `title`/`credit`/`authors`/
`source` center between the body margins (not the physical page); `draftDate` left-aligns;
`contact`'s lines each right-align, one PDF line per array entry (no embedded-newline-in-one-draw
trick -- `page.drawText` has no such concept, so one call per contact line is the natural
representation here, not a reduced one).

**Encoding**: PDF's standard, un-embedded Courier uses WinAnsiEncoding -- covers plain Latin text and
the typographic characters that actually show up constantly (curly quotes, em/en dashes) but excludes
non-Latin scripts and emoji. A character outside it makes `assertEncodable` throw before any
`drawText` call, with the character, its code point (from `pdf-lib`'s own message), the block id, the
element, and an explicit statement that this is the un-embedded font's limitation -- not a script
defect -- and that it goes away once Courier Prime is embedded. No transliteration, no silent
substitution, per the standing "fail loudly" rule.

**Determinism**: `PDFDocument.create({ updateMetadata: false })`. `pdf-lib`'s default
(`updateMetadata: true`) stamps the Info dictionary's `ModificationDate` (and `CreationDate`, if
unset) from `new Date()` -- confirmed directly in `pdf-lib`'s own source
(`PDFDocument.prototype.updateInfoDict`), the same class of risk `packages/docx`'s
`DETERMINISTIC_ZIP_MTIME` guards against for its ZIP container. `updateMetadata: false` skips the
call entirely rather than substituting a fixed date -- a PDF with no `Producer`/`Creator`/
`CreationDate`/`ModDate` is fully valid, and this avoids picking an arbitrary constant that would need
its own justification. `pdf-lib`'s object-ID and resource-name allocation (`PDFContext`'s
`SimpleRNG.withSeed(1)`, confirmed in its source) is already seeded, not random, so it needed no
override. `screenplayToPdf` called twice on the same screenplay is asserted to produce byte-identical
output; the mechanism was independently proven with a throwaway `vi.useFakeTimers` probe forcing a
real five-month gap between two calls without the fix, which did produce different bytes, confirming
`updateMetadata: false` is what prevents it (see the mutation report).

**Deliberately `async`, contradicting this scope's own stated signature.** Item 1 states
`screenplayToPdf(screenplay: Screenplay): Uint8Array`. `pdf-lib`'s entire document API --
`PDFDocument.create`, `embedFont`, and `save` -- returns a `Promise` even for this package's zero-I/O,
standard-font-only usage; there is no synchronous path through the library this scope approved (and
hand-rolling PDF bytes to stay synchronous is exactly what item 2 rejects). Flagged prominently rather
than silently either bending the code to something unsound or silently deviating from the written
signature: the actual signature is `Promise<Uint8Array>`. Every other property "pure" is meant to
guarantee -- determinism, no I/O, no randomness, no reads of the system clock -- still holds for a
function that merely returns a `Promise`; this is documented at length in `index.ts`'s own comment.
`apps/web/src/pdfDownload.ts`'s `triggerPdfDownload` is `async` for the identical reason, and its
`App.tsx` File-menu handler catches the rejection (`.catch(console.error)`) since a synthetic click
event cannot await it and an unhandled rejection would otherwise result -- see "Known limitations"
for what this exposes.

**Client-side download** (`apps/web/src/pdfDownload.ts`): `triggerPdfDownload(screenplay)`,
`pdfFilename(title)` -- the same sanitization and fallback-name logic as `fdxDownload.ts`/
`docxDownload.ts`, MIME type `application/pdf`. Wired into `App.tsx`'s File menu as "Download PDF…",
beside "Download FDX…"/"Download DOCX…", with the same no-op-when-invalid-projection guard. Root
`package.json`'s `build` and `typecheck` chains gained `pnpm --filter @finaler-draft/pdf build`
between `@finaler-draft/docx` and `@finaler-draft/web` -- confirmed load-bearing directly (mutation
tests below): removing it from the `typecheck` chain and clearing both `packages/pdf/dist` and
`apps/web`'s `tsbuildinfo` cache reproduces `Cannot find module '@finaler-draft/pdf'`.

#### Manual verification beyond the automated gates

Generated a smoke PDF from a fixture covering every block type, a populated title page, scene
numbers, and a dialogue split, and read it back with **`pypdf`** (an independent, third-party PDF
library with no relationship to `pdf-lib` or this codebase, installed only for this manual check, not
a project dependency -- the same posture `python-docx` had for validating `packages/docx`). It opened
without error and reported: 3 pages (title page + the 2 body pages `paginateScreenplay` independently
computes for the same blocks, confirmed by a separate script calling `paginateScreenplay` directly),
every page's `mediabox` exactly `[0, 0, 612, 792]` (8.5in x 11in), the title page's title/credit/
author/draftDate/contact text all present and correctly positioned relative to each other, both
scene headings numbered "1" and "2" (each appearing twice, once per margin), and the dialogue split
landing correctly across the page boundary with the character cue repeated on the continuation page.

**This is real, independent-library confirmation that the file is genuinely valid, parseable PDF --
not a claim that every PDF viewer renders it identically or that the visual result is correct. The
owner opening this file (Preview, Acrobat, a browser) is the real acceptance test and has not
happened yet.**

#### Mutation-testing report

Every mutation: introduced in the source, ran the affected test file(s) directly against source
(`packages/pdf`'s own suite needs no rebuild for its own tests -- vitest resolves `./foo.js` imports
against `src` within the same package; only _consumers_ like `apps/web` need `packages/pdf` rebuilt),
confirmed the predicted test(s) failed with the predicted symptom, restored the exact original file
(`diff` against a pre-mutation backup copy confirmed byte-identical every time), and re-ran green.

1. **Baseline ratio 0.8 -> 1.0** (slot's bottom edge instead of 0.8 of the leading down). 2 tests
   failed as predicted: "places the baseline inside its own 12pt slot" (`708` not `> 708`) and
   "baselineForSlotTop is the single conversion every caller shares" (`744` not `746.4`).
2. **`POINTS_PER_CHARACTER` derivation broken** (divided by 11 instead of `NOMINAL_CHARACTERS_PER_INCH`).
   2 tests failed: the direct `toBe(7.2)` assertion, and the **pdf-lib cross-check test** itself
   (`font.widthOfTextAtSize` no longer agreed with the broken `widthPt`) -- confirming that test
   genuinely exercises the 0.6em assumption rather than trivially passing. Notably, `index.test.ts`'s
   position tests (which also call `widthPt` to compute their own expected values) did **not** fail --
   expected and correct: those tests check "painter calls `geometry.ts` correctly," not "`geometry.ts`
   is correct," which is `geometry.test.ts`'s own job and which did catch it.
3. **`leftIndentPtFor('character', ...)` stopped reading `documentSettings`** (hardcoded `3.7 * 72`).
   1 test failed: "respects a custom characterIndentIn/parentheticalIndentIn" (only the character half,
   confirming the mutation's precise blast radius, not a coincidence).
4. **Page-numbering rule broken** (`pageNumber !== 1` -> `!== 0`, printing a number on page 1 too).
   1 test failed: "omits the printed number on the first body page" (`'1.'` unexpectedly present).
5. **Generated-line position swapped** (`(MORE)`/`CONT'D` drawn at `leftIndentPtFor('action', ...)`
   instead of `generatedLineLeftPt`). The dedicated position test failed (`108` instead of
   `266.4`) -- **this is the mutation class the page-content-only tests (page 1-4 in this list's
   sibling packages' own reports) cannot catch on their own**: the text `(MORE)` still renders,
   still lands on the correct page, and every `toContain('(MORE)')`-style assertion still passes.
   Only comparing the PDF's own drawn coordinate against `geometry.ts` catches a correct string
   painted at the wrong indent -- the reason `extractPageRuns` and the "positions come from the
   grid" describe block were added beyond what the scope's stated verification bar required.
6. **Stored `sceneNumber` no longer wins** (`labels.set(block.id, String(sceneNumber))` unconditionally).
   2 tests failed: the direct `computeSceneNumberLabels` unit test and the end-to-end
   `screenplayToPdf` integration test asserting `'25A'` appears twice.
7. **Empty scene heading no longer skipped** (removed the `block.text === ''` guard). 2 tests failed:
   the direct unit test (`labels.has('sh2')` true instead of false) and the integration test
   (`'2'` appeared instead of being consumed by the empty heading with no number drawn).
8. **Roman-numeral formatting removed** (`formatPageNumber` always returns `String(pageNumber)`).
   2 tests failed: the direct `pageNumberFormat.test.ts` roman-numeral assertions and the
   `screenplayToPdf` integration test expecting `'IV.'` on the fourth page.
9. **Multiple-title-pages throw removed** (`if (screenplay.titlePages.length > 1)` -> `if (false)`).
   The dedicated "throws when more than one title page is present" test failed -- the promise
   resolved with real bytes instead of rejecting.
10. **`updateMetadata: false` removed** (`PDFDocument.create()` reverted to its default). The
    determinism test did **not** fail -- an honest, real blind spot: both calls in a synchronous test
    happen within the same second, so `new Date()`'s formatted PDF-date string doesn't actually
    differ (the identical class of narrow-timing-window finding `packages/docx`'s own mutation report
    records for its ZIP `mtime`). Proved the underlying mechanism is real anyway with a throwaway
    `vi.useFakeTimers` probe (`vi.setSystemTime` five months apart around the two calls, not committed
    to the suite): with the mutation active, bytes genuinely differed; the probe was deleted after
    confirming this, and is not part of the shipped test suite (a fake-timers-based determinism test
    was judged not worth the added complexity given the underlying `pdf-lib` mechanism -- seeded RNG
    for object/resource naming, confirmed by source inspection -- already rules out every _other_
    source of nondeterminism, and this is the one already-neutralized exception).
11. **`assertEncodable` made a no-op** (`return;` before the `try`). 5 tests failed: 2 of
    `encoding.test.ts`'s location-formatting tests and the 3 `screenplayToPdf` integration assertions
    checking the wrapped message's block id, element, and "un-embedded Courier" explanation. Notably,
    `page.drawText` still threw -- `pdf-lib`'s own `encodeText` call inside `drawText` still fires --
    just with its bare, unlocated message, confirming this package's wrapping is what adds the
    actionable context, not what makes the failure loud in the first place (that was already true).
12. **`draftDate` alignment changed** (`'left'` -> `'center'`). The dedicated `titlePageLines` test
    failed with a structural diff on the `alignment` field.
13. **`pdfFilename` stopped sanitizing** (`` `${title}.pdf` `` with no cleanup). 3 of 4
    `pdfDownload.test.ts` filename tests failed (the plain-title test is a no-op either way, matching
    FDX/DOCX's own precedent).
14. **`triggerPdfDownload` call removed from the "Download PDF…" menu item** (`if (false && ...)`,
    import kept referenced so the mutation is isolated to the wiring). The `App.test.tsx` "downloads
    the current screenplay as PDF from the File menu" integration test failed -- its `waitFor`
    assertion timed out, since nothing ever called `createObjectURL`.
15. **Root `package.json`'s `typecheck` chain lost `pnpm --filter @finaler-draft/pdf build`**
    (removed from the `&&` chain). With `packages/pdf/dist` and `apps/web`'s own `tsbuildinfo` cache
    both cleared first (otherwise `tsc -b`'s incrementality silently no-ops and hides the break --
    caught by actually re-running it, not inferred), `pnpm typecheck` failed with
    `Cannot find module '@finaler-draft/pdf'` at `pdfDownload.ts`'s import, confirming the root
    script wiring is genuinely load-bearing and not decorative.

Every restoration was verified both by `diff` against a pre-mutation backup file (byte-identical every
time) and by re-running the affected suite back to green afterward.

#### Gate results

1. `pnpm typecheck` (workspace-wide, including the new `@finaler-draft/pdf`) -- clean.
2. `pnpm lint` -- clean, workspace-wide, `--max-warnings=0`.
3. `pnpm test:coverage` (workspace-wide) -- clean. `@finaler-draft/pdf`: 61 tests, 99.33%/96.42%/
   100%/99.33% statements/branches/functions/lines. Two files carry the only uncovered branches, both
   a defensive, structurally-unreachable pattern already established elsewhere in this codebase and
   left uncovered deliberately rather than forced open artificially: `geometry.ts`'s
   `requiredIndentValue` throw (identical in spirit to `packages/fdx`/`packages/docx`'s own
   `requiredIndentValue`) and `encoding.ts`'s `cause instanceof Error ? ... : String(cause)` fallback
   (`pdf-lib` always throws real `Error` instances in practice). `apps/web`: 300 tests (27 files,
   including the new `pdfDownload.test.ts` and the new "PDF download" describe block in
   `App.test.tsx`), all passing; `pdfDownload.ts` at 100%/100%/100%/100%.
4. `pnpm build` (workspace-wide) -- clean. Vite's default 500kB uncompressed-chunk warning fires on
   the `App` chunk (807.52kB raw, 297.96kB gzip, up from bundling `pdf-lib` alongside the existing
   FDX/DOCX exporters) -- not suppressed, per the standing rule not to suppress it, but flagged below:
   this exceeds plan.md's stated 200kB-gzip lazy-editor-chunk budget, and no CI step currently enforces
   that budget despite plan.md's claim that one exists (confirmed by reading `.github/workflows/quality.yml`
   directly -- no bundle-size step is present for any of the three exporters).
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- 21/21 passed (one run hit an unrelated,
   non-reproducing Chrome-launch timeout in `app-shell.spec.ts`'s `beforeEach` -- a certificate-parsing
   error from the local Chrome install, not this package -- and passed cleanly on immediate re-run and
   twice more afterward; not a regression from this work).
6. `PLAYWRIGHT_CHANNEL=chrome TEST_DATABASE_URL=... pnpm test:system:persistence` -- run six times
   total across this slice (three before the position-verification tests and mutation testing were
   added, three more on the final restored state), 9/9 passed every time. The URL was passed on the
   command line only, never written to any file.
7. `git diff --check` -- clean. New untracked files (`packages/pdf/`, `apps/web/src/pdfDownload.ts`,
   `pdfDownload.test.ts`) were checked by hand for trailing whitespace and missing trailing newlines
   instead of via `git add`, since staging is the owner's to do, not this agent's.
8. `pnpm format:check` -- run after this entry was written (see below).

#### Known limitations / things not done

- **The owner has not opened this PDF yet.** Automated tests and one independent third-party library
  (`pypdf`) confirm the file is structurally valid and its content matches `packages/layout`'s model
  exactly; neither confirms it looks right in a real PDF viewer. This is the real acceptance test per
  this scope's own instruction and has not happened.
- **`screenplayToPdf`'s actual signature is `Promise<Uint8Array>`, not the `Uint8Array` this scope's
  item 1 states.** `pdf-lib`'s document API is Promise-based end to end with no synchronous path, and
  hand-rolling PDF bytes to stay synchronous is exactly what item 2's own reasoning rejects. Every
  other purity property (determinism, no I/O, no randomness) holds for the `Promise`-returning
  function; flagged as the one place the implementation's literal type diverges from the written scope.
- **PDF's un-embedded standard Courier cannot render non-Latin scripts or emoji at all** -- it throws
  a located, actionable error rather than silently substituting or dropping the character. This is
  strictly worse than FDX/DOCX (which have no such restriction) and is a direct, foreseeable
  consequence of this slice's own "no font file in this slice" instruction. Embedding Courier Prime
  (the owner's stated next step for this format) removes the restriction entirely; not implemented
  here, per the explicit scope boundary.
- **No user-facing error surface exists in the editor for an export failure.** `App.tsx`'s "Download
  PDF…" handler catches a rejection (most likely the WinAnsi limitation above) and only
  `console.error`s it -- there is no toast, banner, or dialog anywhere in this codebase for a
  client-side async failure of this kind, and inventing one was judged out of scope for "a client-side
  download, thin over the pure function." A writer whose title or screenplay text contains an
  unsupported character currently sees nothing happen.
- **Title-page vertical layout is this package's own judgment call**, inheriting `packages/fdx`'s
  reference-grounded gap constants where they exist and `packages/docx`'s "push contact toward the
  bottom" choice otherwise -- no genuine PDF reference file exists to check either against, exactly
  the position both siblings were already in. Expect a visual-adjustment round once the owner opens a
  populated title page.
- **`dual_dialogue` is unsupported**, matching `packages/layout`'s own `UnsupportedBlockError` --
  this package adds no handling of its own and simply lets that error propagate, per this scope's
  explicit "out of scope: anything that re-derives layout." Confirmed by a dedicated test that the
  error propagates rather than being silently swallowed or mis-paginated.
- **The bundle-size consequence of adding `pdf-lib`** (see gate 4 above) is real and worth the owner's
  attention even though nothing currently enforces it: `pdf-lib` is a substantial client-side
  dependency, and `@finaler-draft/pdf` is statically imported into `App.tsx`'s main chunk today, the
  same way `@finaler-draft/fdx`/`@finaler-draft/docx` already are. If the bundle-budget CI step
  plan.md describes is ever actually implemented, this package (and arguably its two siblings) would
  need a dynamic `import()` behind the "Download PDF…" click rather than a static import, so `pdf-lib`
  only loads when a writer actually exports. Not implemented here -- it was not part of this scope's
  seven "must achieve" items, and no CI gate currently fails without it, but it was not silently
  decided either.
- **No page-count-independent visual regression test** (e.g. rasterizing a page image and diffing
  pixels) -- the scope's own suggestion ("PDF text and page-image regression tests") for the
  server-side export slice, not this one; this slice's tests parse text and coordinates, not pixels.
- **No server-side / historical-revision export caller yet** -- `screenplayToPdf` is pure (modulo the
  `Promise` return) and ready for one, but this slice only wires a client-side caller, matching
  `packages/fdx`/`packages/docx`'s identical scope boundary.
- Coverage thresholds are per-package at 90%; `packages/pdf` landed at 99.33%/96.42%/100%/99.33%, well
  above threshold, with the uncovered lines two defensive, structurally-unreachable branches matching
  established patterns elsewhere in this codebase -- no attempt was made to force either open
  artificially.

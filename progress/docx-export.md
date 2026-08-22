# DOCX export

Branch `feature/docx-export`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/docx-export`.

## Why this scope exists

`plan.md`: "Provide `.docx` export in Phase 1 from the same canonical snapshot using an OOXML
generator. It should preserve the screenplay's content, element semantics, page breaks, and basic
page layout, but PDF is the fidelity contract for exact screenplay pagination."

That last clause sets the bar. DOCX does **not** have to reproduce our pagination exactly -- PDF
carries that contract. It has to produce a Word document that is unmistakably a screenplay: right
element semantics, right indents, right typeface, correct page size and margins, and forced page
breaks where the canonical model has them.

## Read the FDX slice's log first

`progress/fdx-export.md` cost three upload cycles, every one from the same mistake in different
clothes: applying our own judgment to a format we do not own. Trimming an element to "the parts
that matter" produced a file Final Draft could not open at all. **The rule that came out of it
applies here unchanged**: for any structure this product does not define, reproduce the specified
shape exactly and substitute only the values we genuinely own.

**One real difference works in our favour.** FDX has no public specification, which is why it had
to be reverse-engineered from a reference file. OOXML is an openly published standard (ECMA-376 /
ISO/IEC 29500) and WordprocessingML is documented in detail. Building from the specification is
therefore legitimate here in a way it was not there. It is not a licence to guess: **cite the part
of the specification each structural decision comes from** in your progress entry, the same way the
FDX log cites its reference file. "Every example does it this way" is not a citation.

**The owner is the acceptance oracle** and will open the output in Word. Do not claim this works on
the strength of tests. Say what you verified and what needs that check.

## What this must achieve

1. **A new `packages/docx`** exporting a pure `screenplayToDocx(screenplay: Screenplay): Uint8Array`.
   Pure means no DOM, filesystem, network or server, for the same reason `packages/fdx` is pure: a
   server-side export of a historical revision has to call the identical function later.

2. **`fflate` (0.8.3) is approved, for zipping only.** It is the one new dependency in this slice
   and exists because `.docx` is an OPC package -- a ZIP of XML parts -- and hand-rolling ZIP
   central directories and CRCs is a worse risk than one small, dependency-free library. **Write the
   OOXML by hand**, exactly as FDX is written by hand. The format work stays under our control,
   because that is where the fidelity risk lives.

3. **Emit the minimal set of parts that makes a valid document.** Fewer parts means fewer things to
   get subtly wrong, and the FDX experience says an incomplete-but-required structure fails harder
   than a missing optional one. Whatever the specification requires for a WordprocessingML package
   -- content types, package relationships, the document part and its relationships, styles --
   include in full; do not include parts Word merely happens to write.

4. **Element semantics as named paragraph styles**, one per screenplay element, so a reader can see
   in Word that a block _is_ a scene heading rather than inferring it from indentation. Indents,
   the typeface and the type size come from `packages/screenplay/pageFormat` and
   `documentSettings`, never from Word's defaults -- the same values-versus-structure split that
   governs FDX.

5. **Page geometry from our specification**: 8.5 x 11, our margins. Note the unit: WordprocessingML
   uses twips (1/1440 inch) in most places and half-points for font sizes. A conversion error
   produces a plausible-looking document with wrong geometry, which is the failure mode that hides.
   Test the conversions directly.

6. **A `page_break` block emits a real page break.** Everything else about pagination is Word's to
   compute; this is the one place the canonical model asserts a break and it must survive.

7. **The title page, if present**, on its own page ahead of the script.

8. **Exactly one XML-escaping implementation in this repository.** `packages/fdx` already has an
   audited one. Do not copy it. Security-relevant code that exists twice is two things to audit and
   two things to drift. Extract it to a shared home both packages import, justify the placement in a
   comment, and make sure `packages/fdx`'s tests still cover it.

9. **Canonical input, not editor input**, exactly as FDX: handle every canonical block type, throw
   on anything unrecognised rather than skipping it silently, and **omit annotations entirely**
   (`plan.md`: notes "must never enter PDF, DOCX, or FDX screenplay flow by accident").

10. **A client-side download**, thin over the pure function, alongside the existing FDX one.

## Out of scope

PDF and its job infrastructure. FDX import. Server-side or revision-based export. Reproducing our
exact pagination -- PDF owns that contract. Comments, tracked changes, headers/footers beyond page
numbering if it falls out naturally.

## Verification

The full gate list, `pnpm format:check` **after** writing your progress entry, and the persistence
gate three times. `main` is green, so any failure is yours.

Because there is no reference file to diff against, **tests must assert the package's structure, not
just its bytes**: unzip your own output in the test, parse each part, and assert the relationships
and required elements resolve. A test that only checks the archive is non-empty proves nothing.

For every test guarding specific behaviour: break the behaviour, confirm the test fails, restore,
and report it. Six vacuous tests have been found on this project, one written by the lead, and the
most recent was a document-wide assertion standing in for a local property that passed until an
unrelated element happened to contain the same substring. The likeliest here is the unit
conversion: assert computed twip values against known inch figures, not against constants the same
code produced.

Cross-package note: `apps/web` imports built `dist`, so run `pnpm --filter @finaler-draft/docx build`
before any `apps/web` test or mutation, or a mutation will look uncaught when it is not.

No credential may appear in any file you write.

## Rules

Do not stage, commit, merge, rebase, force-push, reset, or create or delete branches or worktrees --
the owner controls staging, committing and pushing. No TODO or placeholder comments, no emojis,
strict TypeScript, `.js` extensions on relative imports. Match the surrounding comment style: record
_why_, citing `plan.md` or the specification. If the code contradicts the specification, stop and
report rather than bending either.

## Checkpoints -- SendMessage to the lead

1. Before writing the serializer: the package layout you intend to emit, the style and geometry
   mapping, where the shared escaper will live, and every specification citation backing those
   choices. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

## Log

### 2026-08-22 -- implementation agent -- checkpoint 1: OOXML design researched, approved with two additions

Full package layout, unit-conversion citations, indent-frame-of-reference conversion, page-break
handling, and two genuinely new design areas (`dual_dialogue` as a borderless two-column table;
title-page vertical layout with no reference file to check against) proposed to the lead and
approved, with six explicit answers and two additions folded in before implementation started:

1. **`dual_dialogue` as a borderless `w:tbl`** -- approved as a deliberate departure from
   `packages/fdx`'s sequential-paragraphs approach: FDX's `<DualDialogue>` wrapper has no rendering
   meaning of its own (Final Draft's app lays the columns out), while WordprocessingML has a real,
   normative side-by-side primitive (ECMA-376 Part 1 section 17.4, "Tables") that FDX's schema does
   not expose. Unreachable today either way -- the editor refuses `dual_dialogue`.
2. **Title page: attempt approximate vertical positioning** on this package's own `pageFormat`
   line grid (54 lines/page, 6 lines/inch), not a flat top-down layout -- DOCX is explicitly not
   the fidelity contract, so "roughly right" beats "provably flat and wrong-looking." Flagged as
   unverified against any Word-saved reference, parallel to how `progress/fdx-export.md` flagged
   `draftDate`/`contact` positioning there.
3. **Scene numbers as trailing run text** (`  (scene N)`), reusing `screenplayToPlainText`'s
   existing convention for the identical problem rather than inventing one. Recorded as a
   limitation, not solved here: a right-aligned tab stop would be the better answer if the owner
   dislikes the inline form, and -- more importantly -- **Phase 1 display scene numbers never
   appear in DOCX at all**, since they are computed decorations the exporter cannot see, unlike
   FDX's `SceneNumberOptions` (Final Draft computes its own numbers). A real behavioral difference
   between the two exports, stated here for the owner rather than left to discover.
4. **`w:caps` on Scene Heading/Character/Transition/Shot** -- approved, not scope creep: uppercase
   display is screenplay semantics, and a display-only transform keeps stored text exactly as
   authored, mirroring FDX's confirmed `AllCaps` convention. The precise ECMA-376 sub-clause for
   `caps` itself was not independently pinned during research (unlike `sz`/`ind`/`pgSz`/
   `pageBreakBefore`/`jc`, each confirmed against a specific section number) -- left explicitly
   uncited in `styles.ts`'s own comment rather than presented as confirmed.
5. **The DOMParser parse-back proof lives in `apps/web`** (with `fflate` as its own devDependency
   to unzip the bytes first), matching the existing `fdxExport.test.ts` precedent, rather than
   adding `jsdom` to `packages/docx` itself.
6. **Fixed zip `mtime` of `1980-01-01T12:00:00Z`** -- approved; DOS timestamp minimum, matches
   `fflate`'s own README example, and noon UTC (not midnight) avoids the local-timezone-rollback
   edge case described below.

Two additions from the lead, both implemented and both caught real bugs during implementation
(see "What shipped" below): assert `screenplayToDocx` determinism directly (serialize the same
screenplay twice, require byte-identical output), and keep `xml:space="preserve"` under test with
a real leading/trailing-space round-trip through unzip, not just presence in the source.

### 2026-08-22 -- implementation agent -- DOCX export complete

#### What shipped

**`packages/xml-escape`** (new shared package, `@finaler-draft/xml-escape`): `escapeXmlText`,
extracted verbatim from `packages/fdx/src/escape.ts`'s `escapeFdxText` and renamed to reflect that
it is XML-1.0-general, not FDX-specific -- FDX and WordprocessingML are both XML 1.0 documents with
identical escaping rules. `packages/fdx/src/escape.ts` and `escape.test.ts` are deleted;
`packages/fdx/src/index.ts` now imports `escapeXmlText` from `@finaler-draft/xml-escape` (checked
first: `escapeFdxText` had no consumers outside `packages/fdx`'s own two files, so this was a
mechanical, safe move, confirmed by `packages/fdx`'s full test suite staying green afterward with
identical coverage numbers). Modeled on `packages/layout`'s package.json/tsconfig shape like every
other pure package here. Root `package.json`'s `build`/`typecheck` chains gained
`@finaler-draft/xml-escape` before `@finaler-draft/fdx`.

**`packages/docx`** (new package, `@finaler-draft/docx`): a pure
`screenplayToDocx(screenplay: Screenplay): Uint8Array`, no DOM, filesystem, network, or server,
split across:

- `units.ts` -- `twipsFromInches`/`halfPointsFromPoints`, tested against known figures (US Letter's
  well-known `12240 x 15840` twips, the specification's own `w:val="27"` = 13.5pt example), not
  round-trips through the same formula.
- `styles.ts` -- the named-style catalog (`SceneHeading`, `Action`, `Character`, `Parenthetical`,
  `Dialogue`, `Transition`, `Shot`, plus `Normal` and `TitlePage`) and `indentFor`, the
  page-edge-to-margin indent conversion (see "Specification citations" below).
- `documentXml.ts` -- `word/document.xml`'s body: title page, script paragraphs, the dual-dialogue
  table, and the shared `sectPr`.
- `opcPackage.ts` -- the five hand-written OPC parts and `buildDocxPackage`, the one call into
  `fflate.zipSync`.
- `index.ts` -- orchestration and the public `screenplayToDocx` export.
- `testFixtures.ts` -- block/screenplay builders plus `unzipDocx`/`docxPart`/`docxDocumentXml`/
  `paragraphsWithStyle` test helpers (unzip via `fflate`, already this package's production
  dependency, used bidirectionally in tests only).

**OPC package**: exactly five parts -- `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`,
`word/styles.xml`, `word/_rels/document.xml.rels` -- per item 3's "minimal set of parts." No
`docProps/*`, theme, font-table, settings, or header/footer parts. Content type strings and
relationship type URIs are the values every real `.docx` producer emits (see citations); this
package has no genuine Word-saved reference file to diff against the way `packages/fdx` has its
FD13 reference, stated here as a limitation rather than a confirmed fact.

**Body blocks**, one named-style `<w:p>` each: `scene_heading` -> `SceneHeading`, `action` ->
`Action`, `character` -> `Character`, `parenthetical` -> `Parenthetical`, `dialogue` -> `Dialogue`,
`transition` -> `Transition` (right-aligned via `w:jc`), `shot` -> `Shot`. Display names match the
`Type` strings `packages/fdx` already writes ("Scene Heading", "Character", ...) -- a deliberate
consistency choice, not an OOXML requirement. Every unhandled block type throws
(`screenplayToDocx cannot represent unknown block type: ...`), matching item 9 and FDX's own
pattern exactly, including the exhaustive-`switch`-with-`never`-default TypeScript idiom.

**`dual_dialogue`**: a borderless two-column `w:tbl` (ECMA-376 section 17.4), left column's blocks
in the left `w:tc`, right's in the right `w:tc`, each cell paragraph keeping its ordinary
`w:pStyle` (so Word's Styles pane still shows "Character"/"Dialogue") but with a direct `<w:ind
w:left="0" w:right="0"/>` overriding the style's page-relative indent, which would otherwise push
text out of a cell roughly half the body's width. `page_break` immediately before a `dual_dialogue`
block attaches `pageBreakBefore` to the first paragraph of the left cell -- there is no
paragraph-level page-break property on a table itself.

**`page_break`**: `<w:pageBreakBefore/>` (ECMA-376 section 17.3.1.23) attached to the paragraph
immediately following a `page_break` block, not a synthetic empty paragraph -- identical reasoning
to `packages/fdx`'s `StartsNewPage` handling (an inserted blank paragraph would shift every
subsequent line down by one). Same two degenerate cases, same reasoning: consecutive `page_break`
blocks collapse to one `pageBreakBefore`, and a trailing `page_break` with nothing after it renders
nothing.

**Title page**: single section (no separate vertically-centered section -- see "What was
considered and rejected" below), rendered top-down with blank-paragraph padding on `pageFormat`'s
own 54-line/6-lines-per-inch grid: 18 blank lines before `title` (roughly a third down the page),
2 before `credit`, 0 before `authors` (matching the genuine zero-gap "Written by"/author pattern
`packages/fdx/fixtures/final-draft-13-reference.fdx` already confirms -- a standard screenwriting
convention independent of Final Draft specifically, reused here as real corroboration rather than
invented), 4 before `source`, 3 before `draftDate`, then 20 blank lines before `contact`. `title`
gets `<w:caps/>` and `<w:u w:val="single"/>` (display-only; stored text unchanged), matching FDX's
confirmed title convention. `contact`'s multiple lines join into **one** right-aligned paragraph
with `<w:br/>` (ECMA-376 section 17.3.3.1) between them, right-aligned per plan.md's "A contact
block in the lower right" (line 509) -- explicitly **not** FDX's embedded-`\n`-in-one-`<w:t>`
convention, which would not render as a line break in WordprocessingML at all (there is no rule
making a raw newline inside run text visible; this was caught during design, not discovered as a
bug later). When a title page is present, the script's first paragraph always gets
`pageBreakBefore` regardless of the canonical blocks' own content, so the script starts on page 2
independent of the title page's own line count. `titlePages` empty omits every `TitlePage`-styled
paragraph entirely; more than one throws (`screenplayToDocx supports at most one title page`),
matching FDX's identical reasoning -- WordprocessingML has no established multi-title-page
convention either, unreachable today since the editor caps at one.

**Scene numbers**: appended as a second run, `  (scene N)`, when `sceneNumber` is present --
WordprocessingML has no structural equivalent to FDX's bare `Number` paragraph attribute, so
omitting it when present would be the silent-data-loss violation the scope rules out. Reuses
`packages/screenplay/src/index.ts`'s own `screenplayToPlainText` convention for the identical
problem. **Recorded per the lead's note**: Phase 1's _displayed_ scene numbers (the ones a writer
sees painted in the margin, computed by `packages/layout`) never appear in this DOCX export at all
-- they are computed decorations the pure exporter cannot see, a real behavioral difference from
FDX (which emits `SceneNumberOptions` and lets Final Draft compute its own numbers), not a bug.

**Annotations**: never read by `screenplayToDocx` at all -- not filtered, simply untouched. Tested
directly: `screenplayFixture` (which carries one annotation) and the same screenplay with
`annotations: []` produce **byte-identical** output (a stronger assertion than FDX's own
XML-string-diff, possible here because the ZIP as a whole is now a deterministic function of the
input -- see "Determinism" below).

**Escaping**: `escapeXmlText` (the shared package) is the only escaping path, used for every
`<w:t xml:space="preserve">` run. Always `xml:space="preserve"` (W3C XML 1.0 section 2.10; ECMA-376
section 17.3.3.31 notes implementations should respect it) since screenplay text can carry
meaningful leading/trailing spaces Word would otherwise trim. No user text goes into any XML
attribute in this package (unlike FDX's `Number` attribute) -- scene numbers are escaped run text,
not an attribute value -- so there is exactly one call-site pattern to audit.

**Determinism**: `fflate.zipSync` stamps a per-file `mtime` defaulting to the current time unless
told otherwise (confirmed directly from `fflate`'s own README, whose own example passes an
identical fixed date for the identical reason). Fixed to `Date.UTC(1980, 0, 1, 12, 0, 0)` --
noon UTC, not midnight, because `fflate` encodes the DOS timestamp from the `Date`'s _local_
calendar fields and rejects a year outside 1980-2099: midnight UTC on 1980-01-01 throws
`date not in range 1980-2099` in any timezone west of UTC, where the local calendar date rolls back
into 1979 (**caught by actually running the serializer during development, not merely inferred
from the spec** -- see "What was considered and rejected" below). `screenplayToDocx` called twice
on the same screenplay is asserted to produce byte-identical output.

**Client-side download** (`apps/web/src/docxDownload.ts`): `triggerDocxDownload(screenplay)`,
`docxFilename(title)` -- a line-for-line mirror of `fdxDownload.ts`, identical sanitization, `.docx`
extension, Blob MIME type `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
(the registered IANA type). One real cross-cutting bug surfaced here: `new Blob([bytes], ...)`
where `bytes` is `screenplayToDocx`'s return value fails to typecheck under this repository's
TypeScript/DOM-lib version (`Uint8Array<ArrayBufferLike>` is not assignable to `BlobPart`, which
requires the narrower `Uint8Array<ArrayBuffer>` -- `ArrayBufferLike` also admits
`SharedArrayBuffer`, which `zipSync` never actually produces). Fixed with `bytes.slice()`, which
returns a concretely `ArrayBuffer`-backed copy; documented inline as a real type-system gap, not
routed around with an unsound cast. Wired into `App.tsx`'s File menu as "Download DOCX…", directly
beside "Download FDX…", with the same no-op-when-invalid-projection guard.

#### Specification citations (by structural decision)

- **Twips** (`w:pgSz`, `w:pgMar`, `w:ind`): ECMA-376 Part 1 section 17.6.13 (`pgSz`) defines the
  unit as `ST_TwipsMeasure`, twentieths of a point -- confirmed via the ooxml.info and datypic
  ECMA-376 mirrors, cross-checked against the well-known US Letter figures `w="12240" h="15840"`
  (exactly `8.5in * 1440` / `11in * 1440`).
- **Half-points** (`w:sz`/`w:szCs`): ECMA-376 Part 1 section 17.3.2.38, confirmed via a c-rex.net
  ECMA-376 Part 4 text mirror whose own worked example (`w:val="27"` = 13.5pt) is reproduced
  directly in `units.test.ts`.
- **Paragraph indentation** (`w:ind`, relative to the section's margins, not the physical page
  edge): ECMA-376 Part 1 section 17.3.1.12, confirmed via the datypic mirror.
- **Paragraph alignment** (`w:jc`): ECMA-376 Part 1 section 17.3.1.13, confirmed via a Microsoft
  Learn OI29500 interoperability-notes citation and the c-rex.net Part 4 mirror.
- **Forced page break** (`w:pageBreakBefore`): ECMA-376 Part 1 section 17.3.1.23, confirmed via
  ooxml.info -- "the paragraph shall be rendered on a new page as if... preceded by a page break."
- **Tables** (`w:tbl`/`w:tblGrid`/`w:tr`/`w:tc`, used for `dual_dialogue`): ECMA-376 Part 1 section
  17.4, a normative, extremely well-documented OOXML feature -- general knowledge of a standard,
  common construct, not independently sub-clause-cited the way the less-common elements above are.
- **Styles part structure** (`w:styles` root containing `docDefaults` then `style*` in sequence,
  `w:basedOn`): ECMA-376 Part 1 section 17.7, confirmed structurally via the datypic mirror
  (`w:styles`, `w:docDefaults`, `w:style`, `w:basedOn` element pages) during checkpoint-1 research.
  The precise sub-clause for `w:caps` specifically was **not** independently pinned -- flagged as
  uncited in `styles.ts`'s own comment rather than presented as confirmed alongside the others.
- **Run-level line break** (`<w:br/>`, used to join `contact`'s multiple lines into one paragraph):
  ECMA-376 Part 1 section 17.3.3.1.
- **`xml:space="preserve"`**: W3C XML 1.0 section 2.10 (the underlying standard); ECMA-376 section
  17.3.3.31 (`t` -- Text) notes implementations should respect it.
- **OPC package structure** ([Content_Types].xml, `_rels/.rels`, part relationships, content-type
  Default/Override rules): ECMA-376 Part 2 (Open Packaging Conventions), corroborated via search
  summaries referencing the standard (EduTech Wiki, mashupguide) rather than a direct section
  fetch of Part 2 itself -- the weakest-sourced citation in this list, flagged as such.
- **Content type strings and relationship type URIs** (`.../wordprocessingml.document.main+xml`,
  `.../wordprocessingml.styles+xml`, `.../relationships/officeDocument`,
  `.../relationships/styles`): confirmed as the values every real `.docx` producer emits via
  MS-OE376 interoperability-notes search results; no genuine Word-saved file exists in this
  repository to diff byte-for-byte against, unlike `packages/fdx`'s FD13 reference.
- **`fflate.zipSync`/`ZipOptions`/`mtime` determinism**: `fflate`'s own README
  (github.com/101arrowz/fflate, fetched raw), a primary source for the library itself rather than
  the file format -- its own top-level example sets a fixed `mtime`, which this package's
  `DETERMINISTIC_ZIP_MTIME` follows for the identical reason.

#### What was considered and rejected

**A separate, vertically-centered title-page section** (`w:sectPr` with `w:vAlign="center"` inside
a `continuous`- or `nextPage`-type section break) was researched at checkpoint 1 and rejected in
favor of the simpler blank-paragraph-padding approach actually shipped. `vAlign="center"` is
confirmed to center a section's content "for all pages in this section," but combining that
cleanly with plan.md's separate "contact in the lower right" requirement inside one physical page,
without a genuine Word-saved file to check the rendered result against, was assessed as exactly
the class of guess the scope warns against. The padding approach is lower-fidelity but fully
specified and testable; flagged as a limitation below, not silently chosen.

**`fflate.zipSync`'s nested-object `Zippable` shape** (`{ word: { 'document.xml': ..., _rels: {
'document.xml.rels': ... } } }`) was the first implementation and was replaced with flat,
slash-separated string keys after discovering empirically (not from documentation) that nested
objects make `fflate` write an explicit directory entry (`word/`, `_rels/`, `word/_rels/`) for
every object level -- entries with no OPC purpose that would contradict item 3's "minimal set of
parts." Mutation-tested directly (see below): reverting to nested objects makes the "exactly five
parts" test fail immediately, confirming this was a real, catchable difference, not decoration.

**Midnight UTC for the fixed zip `mtime`** was the first value tried and failed at runtime with
`Error: date not in range 1980-2099` on this machine's timezone -- not a theoretical edge case
caught by inspection, but an actual thrown error during a first smoke test of the built package.
Noon UTC resolved it and is now the shipped, tested value; the discovery is recorded in
`opcPackage.ts`'s own comment so it is not silently rediscovered later.

#### Manual verification beyond the automated gates

No genuine Word-saved reference file exists for this package (unlike `packages/fdx`'s FD13
reference), so beyond the automated test suite, output from this package's own smoke fixture
(covering every block type, a populated title page, a `page_break`, and a `dual_dialogue`) was:

- Checked well-formed part-by-part with `xmllint --noout` (every one of the five parts: clean).
- **Opened with `python-docx`** (an independent, widely-used third-party OOXML library with no
  relationship to this codebase or to `fflate`), installed only for this manual check, not as a
  project dependency. It opened the file without error and read back: every paragraph's style name
  correctly ("Title Page", "Scene Heading", "Action", "Character", "Parenthetical", "Dialogue",
  "Transition", "Shot"), every paragraph's text correctly including the round-tripped hostile
  characters (`&`, `<`, `"` decoded back to their literal forms, proving escaping did not corrupt
  content), the dual-dialogue table as a real 1-row/2-column table with correct per-cell text, and
  section geometry in EMUs that converts back exactly to `pageFormat`'s own inches (7772400 EMU =
  8.5in, 10058400 EMU = 11in, 1371600 EMU = 1.5in left margin, 914400 EMU = 1.0in for each of
  top/right/bottom).

**This is real, independent-library confirmation that the package structure is genuinely valid
OOXML a third party can parse -- not a claim that Word itself accepts or renders it correctly.**
The owner opening this file in Word, per this scope's explicit instruction, is still the actual
acceptance test and has not happened yet.

#### Mutation-testing report

Every mutation below: introduced in the source, rebuilt the affected package(s)
(`pnpm --filter @finaler-draft/<pkg> build`, required before `apps/web`'s own tests can see a
`packages/*` change, per this scope's own note -- verified this procedure directly, see mutation 1),
ran the affected test file(s), confirmed the predicted test(s) failed with the predicted symptom,
restored the exact original file (`diff` against a pre-mutation backup copy confirmed byte-identical
every time), rebuilt again, and re-ran green.

1. **`escapeXmlText` -> identity function** (disable all escaping). `packages/xml-escape`:
   7 of 9 tests failed (the empty-string and non-ASCII-passthrough tests are no-ops either way).
   `packages/fdx` (rebuilt): 3 tests failed, its own hostile-escaping suite. `packages/docx`
   (rebuilt): 1 test failed, the dedicated escaping test. `apps/web/src/docxExport.test.ts`
   (jsdom, DOMParser): 2 of 4 tests failed with a real `parsererror` ("103:43: disallowed
   character."), proving the parse-back proof actually exercises the parser.
2. **Remove only the invalid-XML-character stripping**, keep entity escaping.
   `packages/xml-escape`: exactly the two tests naming that behavior failed (control characters;
   unpaired surrogate) -- every entity-escaping test stayed green, confirming the two behaviors
   are tested independently.
3. **Break `twipsFromInches`** (`* 1440` -> `* 1440 * 2`). 10 tests failed across all three
   `packages/docx` test files (`units.test.ts`'s direct conversion tests, `styles.test.ts`'s
   indent tests, `index.test.ts`'s page-size/margin/indent structural assertions) -- confirms the
   conversion is genuinely load-bearing everywhere geometry is emitted, not just in isolation.
4. **Break `halfPointsFromPoints`** (`* 2` removed). 3 tests failed: both direct `units.test.ts`
   tests and `styles.test.ts`'s docDefaults font-size assertion.
5. **Break the indent frame-of-reference** (`character`'s indent stopped subtracting
   `MARGIN_LEFT_IN`). 3 tests failed: both direct `character` indent tests in `styles.test.ts` and
   the custom-`documentSettings`-reflected test in the same file -- this is the exact "document
   that opens fine and is wrong" bug class the scope singled out, and it fails loudly here.
6. **Break the `parenthetical` right-edge derivation** (dropped `- widthIn` from the formula).
   2 of 3 related tests failed as predicted (both direct-value tests). The third --
   "the right-edge-from-width formula reproduces a value the specification states directly" --
   correctly stayed **green**, because it independently recomputes the formula against
   `ELEMENT_INDENTS.dialogue`'s own stated numbers rather than calling `indentFor` at all; it
   tests the formula's mathematical validity, not this code path's use of it. Recorded here so
   the distinction is explicit, not mistaken for a missed mutation.
7. **Force `startsNewPage` to always `false`** (`page_break` becomes a permanent no-op). All four
   page-break-specific tests failed, including the dual-dialogue-follows-a-page-break case and
   the title-page-forces-a-break case.
8. **Swap dual-dialogue column order** (right's blocks before left's). The dedicated ordering test
   failed with the exact predicted symptom (`ADA`'s index no longer less than `MILES`'s).
9. **Silently skip an unrecognized block type instead of throwing** (empty `default` branch). The
   dedicated "throws on an unrecognized block type" test failed.
10. **Silently export only the first title page instead of throwing on more than one.** The
    dedicated multiple-title-pages test failed the same way.
11. **Make annotations leak into the exported body** (appended each annotation's text as an extra
    `Action` paragraph). The dedicated byte-identity annotations test failed.
12. **Remove `xml:space="preserve"`.** 12 tests failed, broader than the single dedicated
    whitespace test -- most of `index.test.ts`'s element-mapping and title-page assertions
    literally match the `xml:space="preserve"` substring, so this mutation's blast radius
    confirms the attribute is load-bearing throughout, not narrowly isolated. The dedicated
    "preserves leading and trailing spaces" test is among the twelve that failed.
13. **Disable the fixed zip `mtime`.** First attempt (`new Date()` evaluated once at module load)
    did **not** fail either byte-identity test -- both `screenplayToDocx` calls in a synchronous
    test happen within DOS timestamp's own 2-second granularity window, so the mtime component
    doesn't actually differ. This is an honest, real blind spot of the determinism test against
    genuinely narrow timing windows, recorded rather than hidden. A second, stronger mutation
    (a module-level counter forcing each call's `mtime` 40 days apart, guaranteeing a real
    difference) correctly failed **both** the determinism test and the annotations byte-identity
    test (which also depends on determinism) -- confirming the mechanism works once the mtime
    genuinely varies, which is the actual regression class `DETERMINISTIC_ZIP_MTIME` guards
    against (a future refactor reintroducing a real `new Date()` at a call site invoked at
    meaningfully different times, not two calls milliseconds apart in one test).
14. **Revert the OPC package's flat zip paths to nested objects.** The "exactly five parts, nothing
    more" test failed immediately, catching the reintroduced directory entries.
15. **`docxFilename` -> `` `${title}.docx` `` (no sanitization).** 3 of 4 `docxDownload.test.ts`
    filename tests failed (the plain-title test is a no-op either way, matching mutation 1's and
    FDX's own precedent).
16. **Remove the `triggerDocxDownload` call from the "Download DOCX…" menu item** (no-op
    `onSelect`, keeping the import referenced via `if (false)` to isolate the wiring specifically).
    The `App.test.tsx` "downloads the current screenplay as DOCX from the File menu" integration
    test failed (`createObjectURL` called 0 times instead of 1), proving the App-level wiring is
    genuinely exercised end-to-end.

Every restoration was verified both by `diff` against the pre-mutation backup file (confirmed
byte-identical every time, `wc -l` of the diff output was 0 in every case) and by re-running the
affected package's full test suite afterward, back to green.

#### Gate results

1. `pnpm typecheck` (workspace-wide, all packages/apps including the two new
   `@finaler-draft/xml-escape` and `@finaler-draft/docx`) -- clean.
2. `pnpm lint` -- clean, workspace-wide, `--max-warnings=0`.
3. `pnpm test:coverage` (workspace-wide) -- clean. New packages:
   `@finaler-draft/xml-escape`: 9 tests, 100%/100%/100%/100% statements/branches/functions/lines.
   `@finaler-draft/docx`: 57 tests (8 units + 16 styles + 33 index), 99%/98.88%/100%/99%
   statements/branches/functions/lines (`styles.ts`'s uncovered lines 79-82 are the defensive
   "this should be structurally unreachable" `requiredIndentValue` throw, the same pattern
   `packages/screenplay`'s own `requiredElementIndentValue` and `packages/fdx`'s
   `requiredIndentValue` leave uncovered). `@finaler-draft/fdx`: unchanged at 45 tests, 99.33%/
   96.25%/100%/99.33% (identical coverage numbers to before the escape-extraction, confirming the
   extraction changed nothing observable). `apps/web`: 293 tests (26 test files, including the
   three new ones -- `docxDownload.test.ts`, `docxExport.test.ts`, and the new "DOCX download"
   describe block in `App.test.tsx`), all passing; `docxDownload.ts` at 100%/100%/100%/100%.
4. `pnpm build` (workspace-wide) -- clean.
5. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` -- 21/21 passed.
6. `PLAYWRIGHT_CHANNEL=chrome TEST_DATABASE_URL=... pnpm test:system:persistence` -- run six times
   total across this slice (three before mutation testing began, three more on the final restored
   state), 9/9 passed every time. The URL was passed on the command line only, never written to
   any file.
7. `git diff --check` -- clean. New untracked files (`packages/docx/`, `packages/xml-escape/`,
   `apps/web/src/docxDownload.ts`, `docxDownload.test.ts`, `docxExport.test.ts`) were checked by
   hand for trailing whitespace and missing trailing newlines instead of via `git add`, since
   staging is the owner's to do, not this agent's.
8. `pnpm format:check` -- run after this entry was written (see below).

#### Known limitations / things not done

- **No genuine Word-saved reference file exists for this package**, unlike `packages/fdx`'s FD13
  reference. Every structural decision is built from the OOXML specification and cross-checked
  against multiple independent secondary sources (see citations above), plus one independent
  third-party parser (`python-docx`, see "Manual verification" above) confirmed the output opens
  and reads back correctly -- but nothing here has been through Word itself. **The owner's own
  open-in-Word check is the real acceptance test for this entire package and has not happened
  yet.**
- **Title-page vertical layout is this package's own judgment call**, built on `pageFormat`'s own
  line grid rather than a Word-observed layout, and explicitly approved on that basis at
  checkpoint 2 ("DOCX is explicitly not the fidelity contract"). Expect a visual-adjustment round
  once the owner opens a populated title page in Word.
- **Phase 1's computed/displayed scene numbers never appear in this DOCX export.** They are
  `packages/layout`'s computed decorations, not canonical data the pure exporter can see. Only
  `scene_heading.sceneNumber` (canonical, when present) is exported, as trailing run text. This is
  a real, stated behavioral difference from `packages/fdx` (which emits `SceneNumberOptions` and
  lets Final Draft compute its own numbers), not a bug -- flagged per the lead's explicit
  instruction to tell the owner rather than let it be discovered.
- **`dual_dialogue`'s table shape is a specification-grounded design choice, not verified against
  any Word-saved file containing one** (no such file exists in this repository at all, for either
  format). Unreachable today -- the editor refuses `dual_dialogue`, and nothing can produce one
  until FDX/DOCX import lands.
- **The OPC-package-structure citation (ECMA-376 Part 2) is the weakest-sourced citation in this
  entry** -- corroborated via search-result summaries referencing the standard, not a direct
  fetch of Part 2's own text the way the WordprocessingML (Part 1) citations were. The resulting
  structure (`[Content_Types].xml`, `_rels/.rels`, per-part relationships) matches every
  `.docx`-producing tool's own output and was independently confirmed to parse correctly by
  `python-docx` and `xmllint`, which is the practical mitigation for a citation this package
  could not source as directly as the others.
- **No page numbering, headers, or footers.** Out of scope per this scope's explicit "headers/
  footers beyond page numbering if it falls out naturally" -- it did not fall out naturally here
  (a header part would be a sixth OPC part with its own relationship and content-type entry, real
  added complexity this slice's "minimal parts" principle argued against adding speculatively).
- **No server-side / historical-revision export caller yet** -- `screenplayToDocx` is pure and
  ready for one (that is why it is pure, and why its determinism is directly tested), but this
  slice only wires a client-side caller, matching `packages/fdx`'s identical scope boundary.
- Coverage thresholds are per-package at 90%; `packages/docx` landed at 99%/98.88%/100%/99%, well
  above threshold, with the two remaining uncovered lines a defensive, structurally-unreachable
  throw matching an established pattern elsewhere in this codebase -- no attempt was made to
  force that branch open artificially.

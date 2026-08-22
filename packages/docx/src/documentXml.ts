import type {
  DialogueColumn,
  DocumentSettings,
  Screenplay,
  ScreenplayBlock,
  TitlePage,
} from '@finaler-draft/screenplay';
import {
  BODY_WIDTH_IN,
  LINES_PER_PAGE_MIN,
  MARGIN_LEFT_IN,
  MARGIN_RIGHT_IN,
  MARGIN_TOP_IN,
  PAGE_HEIGHT_IN,
  PAGE_WIDTH_IN,
  type ScreenplayElementKind,
} from '@finaler-draft/screenplay/pageFormat';
import { escapeXmlText } from '@finaler-draft/xml-escape';
import { STYLE_ID_FOR_ELEMENT, type ParagraphIndent } from './styles.js';
import { twipsFromInches } from './units.js';

/**
 * `word/document.xml`'s bottom margin. `packages/screenplay/pageFormat` deliberately exports no
 * fixed bottom margin -- a screenplay page ends on a whole line, so the true bottom margin varies
 * between `MARGIN_BOTTOM_MIN_IN` and `MARGIN_BOTTOM_MAX_IN` -- but `BODY_HEIGHT_IN` is itself
 * derived as `PAGE_HEIGHT_IN - MARGIN_TOP_IN - 1.0`, which makes 1.0in the specification's own
 * nominal figure. `pgMar` wants a single fixed number, the same situation `packages/fdx`'s
 * `NOMINAL_BOTTOM_MARGIN_IN` resolves the same way for `<PageLayout>`.
 */
const NOMINAL_BOTTOM_MARGIN_IN = 1.0;

/** A borderless dual-dialogue table's column width: half the body width, in twips. */
const DUAL_DIALOGUE_COLUMN_WIDTH_TWIPS = Math.round(twipsFromInches(BODY_WIDTH_IN) / 2);

/** No indent, no right indent -- used inside a dual-dialogue table cell; see `dualDialogueColumnCellXml`. */
const ZERO_INDENT: ParagraphIndent = { leftTwips: 0, rightTwips: 0 };

function runXml(text: string, emphasis?: { caps?: boolean; underline?: boolean }): string {
  const rPrChildren: string[] = [];
  if (emphasis?.caps === true) {
    rPrChildren.push('          <w:caps/>\n');
  }
  if (emphasis?.underline === true) {
    rPrChildren.push('          <w:u w:val="single"/>\n');
  }
  const rPr =
    rPrChildren.length > 0 ? `        <w:rPr>\n${rPrChildren.join('')}        </w:rPr>\n` : '';
  return (
    `      <w:r>\n` +
    rPr +
    `        <w:t xml:space="preserve">${escapeXmlText(text)}</w:t>\n` +
    `      </w:r>\n`
  );
}

/**
 * One body `<w:p>`. `indentOverride` exists only for the dual-dialogue table cells (see
 * `dualDialogueColumnCellXml`): the named styles' own `w:ind` values are computed relative to the
 * *page's* margins (see `styles.ts`'s `indentFor`), which is wrong inside a table cell roughly
 * half the body's width -- applying, say, Character's normal ~2.2in left indent there would push
 * the text out of the cell entirely. Direct paragraph formatting overrides style formatting in
 * OOXML's standard cascade, so `w:pStyle` still names the element (Word's Styles pane still shows
 * "Character") while a direct `<w:ind>` neutralizes the page-relative value for that one paragraph.
 *
 * A block with empty text and no scene number renders as `<w:p>` with paragraph properties only
 * and no run -- a valid, ordinary empty paragraph in WordprocessingML, unlike FDX's self-closing
 * convention (that convention is FDX's own reference-confirmed shape, not a WordprocessingML
 * requirement; no genuine Word-saved file was available to check this package's shape against,
 * see this package's progress-entry limitations).
 */
function bodyParagraphXml(
  element: ScreenplayElementKind,
  text: string,
  documentSettings: DocumentSettings,
  options: {
    startsNewPage?: boolean;
    sceneNumber?: string;
    indentOverride?: ParagraphIndent;
  } = {},
): string {
  const styleId = STYLE_ID_FOR_ELEMENT[element];
  const indent = options.indentOverride;
  const indentXml = indent
    ? `        <w:ind w:left="${indent.leftTwips}" w:right="${indent.rightTwips}"/>\n`
    : '';
  const pageBreakXml = options.startsNewPage === true ? '        <w:pageBreakBefore/>\n' : '';

  const runs: string[] = [];
  if (text.length > 0) {
    runs.push(runXml(text));
  }
  if (options.sceneNumber !== undefined) {
    // No WordprocessingML structural equivalent to FDX's `Number` paragraph attribute exists --
    // dropping the number here, when present, would be exactly the silent data loss
    // `progress/docx-export.md` rules out. Reuses `packages/screenplay/src/index.ts`'s own
    // `screenplayToPlainText` convention for the identical problem (no dedicated slot for a scene
    // number in that output format either) rather than inventing a new one.
    runs.push(runXml(`  (scene ${options.sceneNumber})`));
  }

  return (
    `      <w:p>\n` +
    `        <w:pPr>\n` +
    `          <w:pStyle w:val="${styleId}"/>\n` +
    indentXml +
    pageBreakXml +
    `        </w:pPr>\n` +
    runs.join('') +
    `      </w:p>\n`
  );
}

type DialogueColumnBlock = DialogueColumn['blocks'][number];

function dialogueColumnBlockElement(block: DialogueColumnBlock): ScreenplayElementKind {
  return block.type;
}

function dualDialogueColumnCellXml(
  column: DialogueColumn,
  documentSettings: DocumentSettings,
  startsNewPageOnFirst: boolean,
): string {
  const paragraphs = column.blocks
    .map((block, index) =>
      bodyParagraphXml(dialogueColumnBlockElement(block), block.text, documentSettings, {
        indentOverride: ZERO_INDENT,
        ...(index === 0 && startsNewPageOnFirst ? { startsNewPage: true } : {}),
      }),
    )
    .join('');
  return (
    `        <w:tc>\n` +
    `          <w:tcPr>\n` +
    `            <w:tcW w:w="${DUAL_DIALOGUE_COLUMN_WIDTH_TWIPS}" w:type="dxa"/>\n` +
    `          </w:tcPr>\n` +
    paragraphs +
    `        </w:tc>\n`
  );
}

/**
 * `dual_dialogue`'s DOCX shape: a borderless two-column `w:tbl` (ECMA-376 Part 1 section 17.4,
 * "Tables"), left column's blocks in the left `w:tc`, right column's in the right `w:tc` -- a
 * deliberate departure from `packages/fdx`'s sequential-paragraphs-in-a-wrapper approach. FDX's
 * `<DualDialogue>` has no rendering meaning of its own; Final Draft's *app* lays the columns out
 * side by side. WordprocessingML has a real, normative side-by-side primitive FDX's schema
 * doesn't expose, so this uses it instead of porting FDX's compromise (lead-approved at
 * checkpoint 1, `progress/docx-export.md`).
 *
 * A table has no paragraph-level `pageBreakBefore` of its own; the standard way to force a table
 * onto a new page is to force the first paragraph of its first cell, which is what a reader
 * actually encounters first -- the same "attach the break to the next real content" principle
 * `packages/fdx` uses for its own `page_break` handling.
 */
function dualDialogueTableXml(
  block: Extract<ScreenplayBlock, { type: 'dual_dialogue' }>,
  documentSettings: DocumentSettings,
  startsNewPage: boolean,
): string {
  const leftCellXml = dualDialogueColumnCellXml(block.left, documentSettings, startsNewPage);
  const rightCellXml = dualDialogueColumnCellXml(block.right, documentSettings, false);
  return (
    `      <w:tbl>\n` +
    `        <w:tblPr>\n` +
    `          <w:tblW w:w="0" w:type="auto"/>\n` +
    `          <w:tblBorders>\n` +
    `            <w:top w:val="nil"/>\n` +
    `            <w:left w:val="nil"/>\n` +
    `            <w:bottom w:val="nil"/>\n` +
    `            <w:right w:val="nil"/>\n` +
    `            <w:insideH w:val="nil"/>\n` +
    `            <w:insideV w:val="nil"/>\n` +
    `          </w:tblBorders>\n` +
    `          <w:tblCellMar>\n` +
    `            <w:top w:w="0" w:type="dxa"/>\n` +
    `            <w:left w:w="0" w:type="dxa"/>\n` +
    `            <w:bottom w:w="0" w:type="dxa"/>\n` +
    `            <w:right w:w="0" w:type="dxa"/>\n` +
    `          </w:tblCellMar>\n` +
    `        </w:tblPr>\n` +
    `        <w:tblGrid>\n` +
    `          <w:gridCol w:w="${DUAL_DIALOGUE_COLUMN_WIDTH_TWIPS}"/>\n` +
    `          <w:gridCol w:w="${DUAL_DIALOGUE_COLUMN_WIDTH_TWIPS}"/>\n` +
    `        </w:tblGrid>\n` +
    `        <w:tr>\n` +
    leftCellXml +
    rightCellXml +
    `        </w:tr>\n` +
    `      </w:tbl>\n`
  );
}

/**
 * Renders `screenplay.blocks` to `document.xml`'s script body. `leadingPageBreak` is `true` when
 * a title page precedes the script (see `renderDocumentXml`) -- the script must always start on
 * its own page after a title page, independent of whatever the canonical blocks themselves ask
 * for, exactly as `pageFormat`'s own page-numbering rule treats the title page as never part of
 * script pagination.
 *
 * `page_break`'s handling matches `packages/fdx` exactly, same reasoning: `<w:pageBreakBefore/>`
 * (ECMA-376 section 17.3.1.23: "the paragraph shall be rendered on a new page as if... preceded
 * by a page break") is attached to the paragraph immediately following a `page_break` block, not
 * a synthetic empty paragraph -- an inserted blank paragraph would shift every following line down
 * by one, which plan.md's "a script that previews at 112 pages must not export at 113" rules out
 * here exactly as it does for FDX. The same two degenerate cases follow for the same reason:
 * consecutive `page_break` blocks collapse to one `pageBreakBefore` (there is no way to express
 * "two blank pages" through a paragraph property), and a trailing `page_break` with nothing after
 * it renders nothing.
 */
function renderBody(
  blocks: readonly ScreenplayBlock[],
  documentSettings: DocumentSettings,
  leadingPageBreak: boolean,
): string {
  const paragraphs: string[] = [];
  let pendingPageBreak = leadingPageBreak;

  for (const block of blocks) {
    if (block.type === 'page_break') {
      pendingPageBreak = true;
      continue;
    }

    const startsNewPage = pendingPageBreak;
    pendingPageBreak = false;

    switch (block.type) {
      case 'scene_heading':
        paragraphs.push(
          bodyParagraphXml('scene_heading', block.text, documentSettings, {
            startsNewPage,
            ...(block.sceneNumber !== undefined ? { sceneNumber: block.sceneNumber } : {}),
          }),
        );
        break;
      case 'action':
        paragraphs.push(
          bodyParagraphXml('action', block.text, documentSettings, { startsNewPage }),
        );
        break;
      case 'character':
        paragraphs.push(
          bodyParagraphXml('character', block.text, documentSettings, { startsNewPage }),
        );
        break;
      case 'dialogue':
        paragraphs.push(
          bodyParagraphXml('dialogue', block.text, documentSettings, { startsNewPage }),
        );
        break;
      case 'parenthetical':
        paragraphs.push(
          bodyParagraphXml('parenthetical', block.text, documentSettings, { startsNewPage }),
        );
        break;
      case 'transition':
        paragraphs.push(
          bodyParagraphXml('transition', block.text, documentSettings, { startsNewPage }),
        );
        break;
      case 'shot':
        paragraphs.push(bodyParagraphXml('shot', block.text, documentSettings, { startsNewPage }));
        break;
      case 'dual_dialogue':
        paragraphs.push(dualDialogueTableXml(block, documentSettings, startsNewPage));
        break;
      default: {
        // Unreachable while ScreenplayBlock's discriminated union covers exactly these cases --
        // throws instead of silently skipping if the schema ever grows a new block type before
        // this package is updated to handle it, per progress/docx-export.md item 9 ("throw on
        // anything unrecognised").
        const unhandled: never = block;
        throw new Error(
          `screenplayToDocx cannot represent unknown block type: ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }

  return paragraphs.join('');
}

// Vertical layout for the title page, on `pageFormat`'s own six-lines-per-inch, 54-lines-per-page
// grid (`LINES_PER_INCH`, `LINES_PER_PAGE_MIN`) -- NOT a Final Draft-derived figure the way
// `packages/fdx`'s constants are. No genuine Word-saved title page was available to check this
// against (unlike the FD13 reference `packages/fdx` has); this is this package's own judgment
// call, explicitly flagged in progress/docx-export.md, approved at checkpoint 2 on the basis that
// DOCX is not the fidelity contract ("a title page that is roughly right beats one that is
// provably flat and wrong-looking"). One figure IS corroborated by a genuine file already in this
// repository: `packages/fdx/fixtures/final-draft-13-reference.fdx` shows "Written by" immediately
// followed by the author line with zero blank lines between (packages/fdx/src/index.ts's own
// comment on `TITLE_PAGE_LINES_BEFORE_AUTHOR`), a standard screenwriting convention independent
// of Final Draft specifically -- reused here as `TITLE_PAGE_LINES_BEFORE_AUTHOR = 0`.
const TITLE_PAGE_LINES_BEFORE_TITLE = 18; // roughly a third of the way down a 54-line page.
const TITLE_PAGE_LINES_BEFORE_CREDIT = 2;
const TITLE_PAGE_LINES_BEFORE_AUTHOR = 0;
const TITLE_PAGE_LINES_BEFORE_SOURCE = 4;
const TITLE_PAGE_LINES_BEFORE_DRAFT_DATE = 3;
// Generous on purpose: pushes `contact` toward the bottom of the page in the common case (most
// fields present) per plan.md's "A contact block in the lower right" (line 509). Because each
// field's gap is a fixed count rather than a computed remainder, a title page with few fields
// present will not land `contact` as close to the bottom as one with every field present -- an
// approximation, not a computed guarantee, consistent with DOCX not being the fidelity contract.
const TITLE_PAGE_LINES_BEFORE_CONTACT = 20;

type TitlePageLine = {
  text: string;
  alignment: 'left' | 'center' | 'right';
  emphasis?: { caps?: boolean; underline?: boolean };
};

function titlePageLineXml(line: TitlePageLine): string {
  const jcOverride =
    line.alignment === 'center' ? '' : `        <w:jc w:val="${line.alignment}"/>\n`;
  if (line.text.length === 0) {
    return (
      `      <w:p>\n` +
      `        <w:pPr>\n` +
      `          <w:pStyle w:val="TitlePage"/>\n` +
      jcOverride +
      `        </w:pPr>\n` +
      `      </w:p>\n`
    );
  }
  return (
    `      <w:p>\n` +
    `        <w:pPr>\n` +
    `          <w:pStyle w:val="TitlePage"/>\n` +
    jcOverride +
    `        </w:pPr>\n` +
    runXml(line.text, line.emphasis) +
    `      </w:p>\n`
  );
}

function pushBlankTitlePageLines(lines: TitlePageLine[], count: number): void {
  for (let index = 0; index < count; index += 1) {
    lines.push({ text: '', alignment: 'center' });
  }
}

/**
 * The ordered title-page lines other than `contact`, which is rendered separately (see
 * `renderContactParagraph`) because it is one multi-line block, not a sequence of independent
 * lines. `title` gets underline + all-caps display (`emphasis`), the same convention
 * `packages/fdx` applies to its own title line, confirmed there against a genuine Final Draft
 * reference and a widely-recognized screenplay-title convention independent of that one app.
 */
function titlePageLines(titlePage: TitlePage): TitlePageLine[] {
  const lines: TitlePageLine[] = [];
  pushBlankTitlePageLines(lines, TITLE_PAGE_LINES_BEFORE_TITLE);

  if (titlePage.title !== undefined) {
    lines.push({
      text: titlePage.title,
      alignment: 'center',
      emphasis: { caps: true, underline: true },
    });
  }

  if (titlePage.credit !== undefined) {
    pushBlankTitlePageLines(lines, TITLE_PAGE_LINES_BEFORE_CREDIT);
    lines.push({ text: titlePage.credit, alignment: 'center' });
  }

  if (titlePage.authors !== undefined && titlePage.authors.length > 0) {
    pushBlankTitlePageLines(lines, TITLE_PAGE_LINES_BEFORE_AUTHOR);
    for (const author of titlePage.authors) {
      lines.push({ text: author, alignment: 'center' });
    }
  }

  if (titlePage.source !== undefined) {
    pushBlankTitlePageLines(lines, TITLE_PAGE_LINES_BEFORE_SOURCE);
    lines.push({ text: titlePage.source, alignment: 'center' });
  }

  if (titlePage.draftDate !== undefined) {
    pushBlankTitlePageLines(lines, TITLE_PAGE_LINES_BEFORE_DRAFT_DATE);
    lines.push({ text: titlePage.draftDate, alignment: 'left' });
  }

  return lines;
}

/**
 * `contact`'s multiple lines join into one right-aligned paragraph with `<w:br/>` (ECMA-376
 * section 17.3.3.1, a simple run-level line break) between them, NOT one `<w:t>` per line and NOT
 * FDX's convention of embedded `\n` characters inside a single `<w:t>` -- WordprocessingML has no
 * rule making a raw newline inside run text render as a visible line break, so porting FDX's
 * shape here would silently collapse the contact block onto one line. `<w:br/>` is the
 * spec-correct mechanism for "more than one line, one paragraph."
 */
function renderContactParagraph(contactLines: readonly string[]): string {
  const runChildren = contactLines
    .map((line, index) => {
      const breakXml = index > 0 ? '        <w:br/>\n' : '';
      return `${breakXml}        <w:t xml:space="preserve">${escapeXmlText(line)}</w:t>\n`;
    })
    .join('');
  return (
    `      <w:p>\n` +
    `        <w:pPr>\n` +
    `          <w:pStyle w:val="TitlePage"/>\n` +
    `          <w:jc w:val="right"/>\n` +
    `        </w:pPr>\n` +
    `      <w:r>\n` +
    runChildren +
    `      </w:r>\n` +
    `      </w:p>\n`
  );
}

function renderTitlePageParagraphs(titlePage: TitlePage): string {
  const linesXml = titlePageLines(titlePage).map(titlePageLineXml).join('');
  if (titlePage.contact === undefined || titlePage.contact.length === 0) {
    return linesXml;
  }
  const blanksXml = Array.from({ length: TITLE_PAGE_LINES_BEFORE_CONTACT })
    .map(() => titlePageLineXml({ text: '', alignment: 'center' }))
    .join('');
  return linesXml + blanksXml + renderContactParagraph(titlePage.contact);
}

/**
 * WordprocessingML has no established multi-title-page convention (same conclusion
 * `packages/fdx` reached for FDX's singular `<TitlePage>`) -- throws rather than silently
 * exporting only the first, per the "never silently drop real data" rule this scope states for
 * block types and extends here. Unreachable today: the editor caps a screenplay at one title
 * page.
 */
function renderTitlePage(titlePages: readonly TitlePage[]): string {
  if (titlePages.length > 1) {
    throw new Error(
      `screenplayToDocx supports at most one title page; received ${titlePages.length}. ` +
        'WordprocessingML has no established multi-title-page convention -- see progress/docx-export.md.',
    );
  }
  const [titlePage] = titlePages;
  return titlePage === undefined ? '' : renderTitlePageParagraphs(titlePage);
}

/**
 * The section properties every page in this document shares -- page size and margins from
 * `pageFormat`, never Word's own Letter/margin defaults, the same values-not-structure split
 * `packages/fdx`'s `renderPageLayout` follows for the identical reason: our pagination
 * (`packages/layout`) is authoritative, so this document must not silently disagree with it.
 * Single section for the whole document (title page included) -- see `documentXml.ts`'s module
 * comment on why a separate, vertically-centered title-page section was rejected at checkpoint 1.
 */
function sectPrXml(): string {
  return (
    `    <w:sectPr>\n` +
    `      <w:pgSz w:w="${twipsFromInches(PAGE_WIDTH_IN)}" w:h="${twipsFromInches(PAGE_HEIGHT_IN)}"/>\n` +
    `      <w:pgMar w:top="${twipsFromInches(MARGIN_TOP_IN)}" w:right="${twipsFromInches(MARGIN_RIGHT_IN)}"` +
    ` w:bottom="${twipsFromInches(NOMINAL_BOTTOM_MARGIN_IN)}" w:left="${twipsFromInches(MARGIN_LEFT_IN)}"` +
    ` w:gutter="0"/>\n` +
    `    </w:sectPr>\n`
  );
}

/**
 * `word/document.xml`'s full content: the root `<w:document>` (ECMA-376 Part 1 section 17.2.2's
 * WordprocessingML main namespace) wrapping `<w:body>` -- the title page's paragraphs (if any),
 * then the script body, then the shared `sectPr`.
 *
 * When a title page is present, the script's first paragraph always gets `pageBreakBefore`
 * (`renderBody`'s `leadingPageBreak`), independent of the canonical blocks' own content -- a title
 * page never participates in script pagination (`pageFormat`'s own rule), so the script must
 * start on a fresh page regardless of what the writer's first block happens to be.
 */
export function renderDocumentXml(screenplay: Screenplay): string {
  const titlePageXml = renderTitlePage(screenplay.titlePages);
  const hasTitlePage = screenplay.titlePages.length > 0;
  const bodyXml = renderBody(screenplay.blocks, screenplay.documentSettings, hasTitlePage);

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n` +
    `  <w:body>\n` +
    titlePageXml +
    bodyXml +
    sectPrXml() +
    `  </w:body>\n` +
    `</w:document>\n`
  );
}

// Re-exported so `index.test.ts` and `documentXml.test.ts` can cross-check `LINES_PER_PAGE_MIN`
// (imported at the top of this module) is genuinely `pageFormat`'s own constant, not a
// transcribed copy -- see the "known ground truth" style of check `packages/fdx`'s tests use.
export const TITLE_PAGE_GRID_LINES_PER_PAGE = LINES_PER_PAGE_MIN;

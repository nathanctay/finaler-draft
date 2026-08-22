import type { TitlePage } from '@finaler-draft/screenplay';

export type PdfTitlePageLine = {
  readonly text: string;
  readonly alignment: 'left' | 'center' | 'right';
};

/**
 * Vertical layout for the title page, on `pageFormat`'s own six-lines-per-inch grid -- the same
 * grid `geometry.ts`'s `lineTopPt`/`baselineForLine` already paint the body with, reused here
 * rather than inventing a second vertical scheme. No genuine reference file fixes a PDF title
 * page's layout (unlike `packages/fdx`'s Final Draft 13 reference), so these gap counts are this
 * package's own judgment call, following the same two siblings that faced the identical problem:
 *
 * - `LINES_BEFORE_TITLE`/`CREDIT`/`AUTHOR`/`SOURCE` reuse `packages/fdx`'s values, which -- alone
 *   among every title-page figure across all three exporters -- are grounded in a genuine
 *   Final Draft-saved reference file (`packages/fdx/fixtures/final-draft-13-reference.fdx`; see
 *   `packages/fdx/src/index.ts`'s own constants and `progress/fdx-export.md`).
 * - `LINES_BEFORE_DRAFT_DATE` also reuses FDX's value; FDX's own comment notes even its reference
 *   leaves this field blank, so this is inherited for consistency across exporters, not because
 *   it is independently confirmed.
 * - `LINES_BEFORE_CONTACT` uses `packages/docx`'s larger, deliberate value instead of FDX's --
 *   DOCX's reasoning (push `contact` toward the bottom of the page per plan.md's "A contact block
 *   in the lower right") is the better product intent of the two, and neither figure is confirmed
 *   against a genuine file either way.
 *
 * Flagged in `progress/pdf-export.md`'s "Known limitations": this needs the owner's visual check,
 * exactly as it did for DOCX.
 */
const LINES_BEFORE_TITLE = 17;
const LINES_BEFORE_CREDIT = 3;
const LINES_BEFORE_AUTHOR = 2;
const LINES_BEFORE_SOURCE = 4;
const LINES_BEFORE_DRAFT_DATE = 3;
const LINES_BEFORE_CONTACT = 20;

function blankLines(count: number): PdfTitlePageLine[] {
  return Array.from({ length: count }, () => ({ text: '', alignment: 'center' as const }));
}

/**
 * The ordered title-page lines, top to bottom, one PDF grid line each. `contact`'s entries are
 * each their own line (rather than one paragraph joined by embedded newlines, the way
 * `packages/fdx` represents a multi-line contact block) because `page.drawText` paints one
 * physical line per call -- there is no PDF equivalent of a soft line break inside a single draw,
 * so this is the natural, not a reduced, representation for this renderer.
 */
export function titlePageLines(titlePage: TitlePage): PdfTitlePageLine[] {
  const lines: PdfTitlePageLine[] = [];

  lines.push(...blankLines(LINES_BEFORE_TITLE));
  if (titlePage.title !== undefined) {
    lines.push({ text: titlePage.title, alignment: 'center' });
  }

  if (titlePage.credit !== undefined) {
    lines.push(...blankLines(LINES_BEFORE_CREDIT));
    lines.push({ text: titlePage.credit, alignment: 'center' });
  }

  if (titlePage.authors !== undefined && titlePage.authors.length > 0) {
    lines.push(...blankLines(LINES_BEFORE_AUTHOR));
    for (const author of titlePage.authors) {
      lines.push({ text: author, alignment: 'center' });
    }
  }

  if (titlePage.source !== undefined) {
    lines.push(...blankLines(LINES_BEFORE_SOURCE));
    lines.push({ text: titlePage.source, alignment: 'center' });
  }

  if (titlePage.draftDate !== undefined) {
    lines.push(...blankLines(LINES_BEFORE_DRAFT_DATE));
    lines.push({ text: titlePage.draftDate, alignment: 'left' });
  }

  if (titlePage.contact !== undefined && titlePage.contact.length > 0) {
    lines.push(...blankLines(LINES_BEFORE_CONTACT));
    for (const contactLine of titlePage.contact) {
      lines.push({ text: contactLine, alignment: 'right' });
    }
  }

  return lines;
}

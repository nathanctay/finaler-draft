import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import { TYPE_SIZE_PT } from '@finaler-draft/screenplay/pageFormat';
import type { Screenplay } from '@finaler-draft/screenplay';
import type { LayoutResult } from '@finaler-draft/layout';
import * as geometry from './geometry.js';
import { assertEncodable } from './encoding.js';
import type { EncodableLocation } from './encoding.js';
import { computeSceneNumberLabels } from './sceneNumbers.js';
import { formatPageNumber } from './pageNumberFormat.js';
import { titlePageLines } from './titlePage.js';

/** Draws one line of text at a grid-derived position, after confirming Courier can encode it. */
function drawGridText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  location: EncodableLocation,
): void {
  if (text.length === 0) {
    return;
  }
  assertEncodable(font, text, location);
  page.drawText(text, { x, y, size: TYPE_SIZE_PT, font });
}

/**
 * Paints the title page as an unpaginated first PDF page, ahead of the script -- plan.md's "Title
 * page never paginates with the screenplay body and never receives a page number." Throws when
 * more than one title page is present, matching `packages/fdx`/`packages/docx`'s identical
 * reasoning: PDF has no more established a convention for multiple title pages than FDX or
 * WordprocessingML do, and silently exporting only the first would be the silent-data-loss this
 * project's exporters all refuse. Unreachable today -- the editor never produces more than one.
 * A screenplay with no title page paints nothing here at all.
 */
export function paintTitlePage(pdfDoc: PDFDocument, font: PDFFont, screenplay: Screenplay): void {
  if (screenplay.titlePages.length > 1) {
    throw new Error(
      `screenplayToPdf supports at most one title page; received ${screenplay.titlePages.length}.`,
    );
  }
  const [titlePage] = screenplay.titlePages;
  if (titlePage === undefined) {
    return;
  }

  const page = pdfDoc.addPage([geometry.PAGE_WIDTH_PT, geometry.PAGE_HEIGHT_PT]);
  const lines = titlePageLines(titlePage);
  lines.forEach((line, lineIndex) => {
    if (line.text.length === 0) {
      return;
    }
    const y = geometry.baselineForLine(lineIndex);
    const width = geometry.widthPt(line.text);
    const x =
      line.alignment === 'center'
        ? geometry.TITLE_PAGE_CENTER_X_PT - width / 2
        : line.alignment === 'right'
          ? geometry.BODY_RIGHT_EDGE_PT - width
          : geometry.MARGIN_LEFT_PT;
    drawGridText(page, font, line.text, x, y, { context: 'the title page' });
  });
}

/**
 * Paints every body page from `packages/layout`'s precomputed model -- one PDF page per
 * `Page`, in order, so the PDF's page count equals `paginateScreenplay`'s by construction (the
 * fidelity contract this whole package exists for). Nothing here re-derives a break, a wrap, or
 * a generated `(MORE)`/`CONT'D` line: every one of those is already decided by `layout`, and this
 * function only converts each `PageLine` into a drawn glyph run at a grid-derived position.
 */
export function paintBodyPages(
  pdfDoc: PDFDocument,
  font: PDFFont,
  layout: LayoutResult,
  screenplay: Screenplay,
): void {
  const { documentSettings } = screenplay;
  const sceneNumberLabels = documentSettings.sceneNumbersEnabled
    ? computeSceneNumberLabels(screenplay.blocks)
    : undefined;
  // A wrapped scene heading spans several `AuthoredLine`s sharing one `blockId`; the number is
  // drawn once, beside the first of them. A heading's own lines are never split across pages
  // (`packages/layout/src/pageBreak.ts`'s own guarantee), so "first occurrence" is unambiguous.
  const numberedHeadings = new Set<string>();

  for (const layoutPage of layout.pages) {
    const page = pdfDoc.addPage([geometry.PAGE_WIDTH_PT, geometry.PAGE_HEIGHT_PT]);

    layoutPage.lines.forEach((line, lineIndex) => {
      if (line.kind === 'blank') {
        return;
      }
      const y = geometry.baselineForLine(lineIndex);

      if (line.kind === 'generated') {
        const x = geometry.generatedLineLeftPt(documentSettings);
        drawGridText(page, font, line.text, x, y, {
          context: `a generated "${line.reason}" line`,
          blockId: line.sourceBlockId,
        });
        return;
      }

      const location = {
        context: 'a screenplay line',
        blockId: line.blockId,
        element: line.element,
      };
      const x =
        line.element === 'transition'
          ? geometry.TRANSITION_RIGHT_EDGE_PT - geometry.widthPt(line.text)
          : geometry.leftIndentPtFor(line.element, documentSettings);
      drawGridText(page, font, line.text, x, y, location);

      if (
        line.element === 'scene_heading' &&
        sceneNumberLabels !== undefined &&
        !numberedHeadings.has(line.blockId)
      ) {
        numberedHeadings.add(line.blockId);
        const label = sceneNumberLabels.get(line.blockId);
        if (label !== undefined) {
          const numberLocation = {
            context: 'a scene number',
            blockId: line.blockId,
            element: 'scene_heading',
          };
          const leftX = geometry.SCENE_NUMBER_LEFT_RIGHT_EDGE_PT - geometry.widthPt(label);
          drawGridText(page, font, label, leftX, y, numberLocation);
          drawGridText(
            page,
            font,
            label,
            geometry.SCENE_NUMBER_RIGHT_LEFT_EDGE_PT,
            y,
            numberLocation,
          );
        }
      }
    });

    // plan.md's "Page numbering": "The first page of the screenplay carries no number. Numbering
    // begins at 2 on the second page." `Page.pageNumber` is already the body-relative position
    // (`packages/layout/src/model.ts`'s own doc comment), so `=== 1` is exactly that rule.
    if (layoutPage.pageNumber !== 1) {
      const label = `${formatPageNumber(layoutPage.pageNumber, documentSettings.pageNumberStyle)}.`;
      const x = geometry.PAGE_NUMBER_RIGHT_EDGE_PT - geometry.widthPt(label);
      const y = geometry.baselineForSlotTop(geometry.PAGE_NUMBER_TOP_SLOT_PT);
      drawGridText(page, font, label, x, y, { context: 'the page number' });
    }
  }
}

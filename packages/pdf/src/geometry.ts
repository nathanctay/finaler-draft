/**
 * Grid-to-points geometry for painting `packages/layout`'s page model into PDF user space.
 *
 * The rule this package exists under (`progress/pdf-export.md`, checkpoint 1): every position
 * comes from `packages/screenplay/src/pageFormat.ts`'s character-and-line grid, never from a
 * font's own metrics. `MEASURED_COURIER_PRIME_ADVANCE_EM` is forbidden from driving layout
 * anywhere in this codebase, and nothing below reads it, or calls `pdf-lib`'s
 * `font.widthOfTextAtSize` / `font.getWidth*`, to produce a position. The one exception --
 * unavoidable -- is `page.drawText` itself, which must paint glyphs through a font object; that
 * call never decides where anything goes, only how it looks once the position is already fixed.
 *
 * PDF user space has its origin at a page's bottom-left corner with Y increasing upward. Every
 * figure in `pageFormat.ts` is written the opposite way (distance down from the physical page's
 * top edge), so every function below that returns a Y coordinate does the flip once, here, rather
 * than leaving callers to reason about it individually.
 */
import {
  ELEMENT_INDENTS,
  LEADING_PT,
  MARGIN_LEFT_IN,
  MARGIN_RIGHT_IN,
  MARGIN_TOP_IN,
  NOMINAL_CHARACTERS_PER_INCH,
  PAGE_HEIGHT_IN,
  PAGE_NUMBER_RIGHT_IN,
  PAGE_NUMBER_TOP_IN,
  PAGE_WIDTH_IN,
} from '@finaler-draft/screenplay/pageFormat';
import type { ElementIndent, ScreenplayElementKind } from '@finaler-draft/screenplay/pageFormat';
import { graphemeLength } from '@finaler-draft/layout';
import type { DocumentSettings } from '@finaler-draft/screenplay';

export const POINTS_PER_INCH = 72;

export const PAGE_WIDTH_PT = PAGE_WIDTH_IN * POINTS_PER_INCH;
export const PAGE_HEIGHT_PT = PAGE_HEIGHT_IN * POINTS_PER_INCH;

const MARGIN_TOP_PT = MARGIN_TOP_IN * POINTS_PER_INCH;
export const MARGIN_LEFT_PT = MARGIN_LEFT_IN * POINTS_PER_INCH;
const MARGIN_RIGHT_PT = MARGIN_RIGHT_IN * POINTS_PER_INCH;

/** The body's own right content edge, `PAGE_WIDTH_IN - MARGIN_RIGHT_IN` in points. */
export const BODY_RIGHT_EDGE_PT = PAGE_WIDTH_PT - MARGIN_RIGHT_PT;

/**
 * Fraction of `LEADING_PT` between a line's slot top and its baseline. Approved at checkpoint 1:
 * `slotTop + 0.8 * LEADING_PT`. This is a chosen typesetting convention for keeping a 12pt
 * Courier glyph's ascenders and descenders inside its own 12pt slot -- it is NOT a value read off
 * any font's metrics. Baseline-to-baseline spacing across consecutive lines is exactly
 * `LEADING_PT` regardless of this ratio (the grid alone fixes that, see `baselineForLine` below);
 * changing this constant never changes line count, page count, or any position relative to
 * another line -- only how "low" glyphs sit within their own row. 0.8 is the conventional split;
 * any other fixed fraction of `LEADING_PT` would be equally metric-free, but the slot's own
 * bottom edge (fraction 1.0) was rejected because it visually sits every descender outside its
 * row and starts the first line's glyphs below the top margin rather than at it.
 */
const BASELINE_RATIO_OF_LEADING = 0.8;

/**
 * Horizontal points per character cell at the specification's nominal 10 pitch
 * (`NOMINAL_CHARACTERS_PER_INCH`). This is the character grid's own definition, not a font's
 * advance metric -- see `geometry.test.ts` for the cross-check confirming pdf-lib's actual
 * Courier `widthOfTextAtSize` agrees with this value (the PDF spec's own Standard-14 AFM gives
 * Courier an exact 0.6em advance, i.e. exactly 10 characters per inch at 12pt), but that
 * cross-check lives only in a test: nothing in this module calls into the font object to compute
 * a width.
 */
export const POINTS_PER_CHARACTER = POINTS_PER_INCH / NOMINAL_CHARACTERS_PER_INCH;

/** A text run's width in points, computed purely from the character grid -- see the module comment. */
export function widthPt(text: string): number {
  return graphemeLength(text) * POINTS_PER_CHARACTER;
}

/** Distance from the page's top physical edge to the top of body line `lineIndex`'s (0-based) 12pt slot. */
export function lineTopPt(lineIndex: number): number {
  return MARGIN_TOP_PT + lineIndex * LEADING_PT;
}

/**
 * Converts "distance from the page's top edge to a slot's top" into the PDF baseline Y (distance
 * from the page's bottom edge, PDF user-space convention) -- the one place the top-down/bottom-up
 * coordinate flip happens. Reused for body lines, the page number, and the title page: one
 * vertical scheme, not one per caller.
 */
export function baselineForSlotTop(slotTopPt: number): number {
  return PAGE_HEIGHT_PT - slotTopPt - BASELINE_RATIO_OF_LEADING * LEADING_PT;
}

export function baselineForLine(lineIndex: number): number {
  return baselineForSlotTop(lineTopPt(lineIndex));
}

function requiredIndentValue(indent: ElementIndent, field: 'leftIn' | 'rightIn'): number {
  const value = indent[field];
  if (value === undefined) {
    throw new Error(`ELEMENT_INDENTS.${field} is unset; the PDF indent derivation is stale.`);
  }
  return value;
}

/**
 * Left edge, in points, for every left-aligned body element. `character`/`parenthetical` read
 * `documentSettings` (the two elements plan.md's "Document settings" lets a writer adjust);
 * every other element's indent is fixed specification, taken directly from `ELEMENT_INDENTS`.
 * `transition` has no left indent (it is right-aligned against `TRANSITION_RIGHT_EDGE_PT` below)
 * -- throwing here rather than returning a meaningless number if a caller reaches it by mistake.
 */
export function leftIndentPtFor(
  element: ScreenplayElementKind,
  documentSettings: DocumentSettings,
): number {
  switch (element) {
    case 'character':
      return documentSettings.characterIndentIn * POINTS_PER_INCH;
    case 'parenthetical':
      return documentSettings.parentheticalIndentIn * POINTS_PER_INCH;
    case 'scene_heading':
    case 'action':
    case 'shot':
    case 'dialogue':
      return requiredIndentValue(ELEMENT_INDENTS[element], 'leftIn') * POINTS_PER_INCH;
    case 'transition':
      throw new Error(
        'transition has no left indent -- it is right-aligned; use TRANSITION_RIGHT_EDGE_PT.',
      );
  }
}

/** `(MORE)`/`CONT'D` render at the character indent by rule (plan.md), never as `character` elements. */
export function generatedLineLeftPt(documentSettings: DocumentSettings): number {
  return documentSettings.characterIndentIn * POINTS_PER_INCH;
}

/** `transition`'s right edge, from the physical page edge, per `ELEMENT_INDENTS.transition.rightIn`. */
export const TRANSITION_RIGHT_EDGE_PT =
  (PAGE_WIDTH_IN - requiredIndentValue(ELEMENT_INDENTS.transition, 'rightIn')) * POINTS_PER_INCH;

/** The page number's fixed position, independent of the body line grid -- `pageFormat.ts`'s own figures. */
export const PAGE_NUMBER_RIGHT_EDGE_PT = (PAGE_WIDTH_IN - PAGE_NUMBER_RIGHT_IN) * POINTS_PER_INCH;
export const PAGE_NUMBER_TOP_SLOT_PT = PAGE_NUMBER_TOP_IN * POINTS_PER_INCH;

/**
 * The gap between the body's left/right margins and each scene-number copy, reproduced from
 * `apps/web/src/styles.css`'s `.scene-number-left`/`.scene-number-right` rules (`right: calc(100%
 * + 0.5in)` / `left: calc(100% + 0.5in)`) so a writer sees the same position on screen and on the
 * printed page. This is not a `pageFormat.ts` constant -- it is the editor's own rendering
 * choice, not specification -- so it is cited here rather than restated as if it were normative.
 */
const SCENE_NUMBER_MARGIN_GAP_IN = 0.5;

/** Right edge of the left-margin scene-number copy (right-aligned, ending short of the body's left margin). */
export const SCENE_NUMBER_LEFT_RIGHT_EDGE_PT =
  (MARGIN_LEFT_IN - SCENE_NUMBER_MARGIN_GAP_IN) * POINTS_PER_INCH;

/** Left edge of the right-margin scene-number copy (left-aligned, starting past the body's right margin). */
export const SCENE_NUMBER_RIGHT_LEFT_EDGE_PT =
  (PAGE_WIDTH_IN - MARGIN_RIGHT_IN + SCENE_NUMBER_MARGIN_GAP_IN) * POINTS_PER_INCH;

/** The horizontal midpoint between the body's left and right margins, for centered title-page lines. */
export const TITLE_PAGE_CENTER_X_PT = (MARGIN_LEFT_PT + BODY_RIGHT_EDGE_PT) / 2;

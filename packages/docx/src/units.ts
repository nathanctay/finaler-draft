import { LINES_PER_INCH } from '@finaler-draft/screenplay/pageFormat';

/**
 * Unit conversions between `packages/screenplay/pageFormat`'s inches/points and the units
 * WordprocessingML actually uses. Isolated in their own module, with their own direct tests
 * against known figures (not round-trips through this same code), per `progress/docx-export.md`:
 * "a conversion error produces a plausible document with wrong geometry, which is the failure
 * mode that hides."
 *
 * Twips ("twentieths of a point"): the unit `w:pgSz`, `w:pgMar`, and `w:ind` all use for length.
 * ECMA-376 Part 1 section 17.6.13 (`pgSz`) defines the type as `ST_TwipsMeasure`; a point is
 * 1/72 inch, so a twentieth of a point is 1/1440 inch. US Letter's well-known Word-native figures
 * -- `w="12240" h="15840"` -- are exactly `8.5in * 1440` and `11in * 1440`, which is this
 * function's own cross-check (see `units.test.ts`).
 */
export function twipsFromInches(inches: number): number {
  return Math.round(inches * 1440);
}

/**
 * Half-points: the unit `w:sz`/`w:szCs` (font size) use. ECMA-376 Part 1 section 17.3.2.38
 * defines `sz`'s `val` as a positive half-point measurement -- the specification's own worked
 * example is `w:val="27"` meaning 13.5pt, i.e. `val / 2` is the point size. `TYPE_SIZE_PT` (12pt,
 * `packages/screenplay/pageFormat`) therefore becomes `w:val="24"`.
 */
export function halfPointsFromPoints(points: number): number {
  return Math.round(points * 2);
}

/**
 * Twentieths of a point, the unit `w:spacing`'s `w:line`, `w:before` and `w:after` use -- the same
 * twentieth-of-a-point measure as `w:ind` and `w:pgMar`, despite the different attribute names.
 */
export function twentiethsOfPointFromPoints(points: number): number {
  return Math.round(points * 20);
}

/**
 * The exact height of one line of the screenplay grid, in points. `LINES_PER_INCH` is 6, so a line
 * is 12pt. Derived rather than written as `12` because the grid is the specification's, not a
 * coincidence of the type size happening to be 12pt as well.
 */
export const LINE_HEIGHT_PT = 72 / LINES_PER_INCH;

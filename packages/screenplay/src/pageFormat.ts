/**
 * The screenplay page format: the physical geometry of a US Letter screenplay page.
 *
 * This is the single source of truth for every measurement in the specification. The web
 * editor derives its CSS custom properties from these values (see
 * `apps/web/src/pageGeometryCss.ts`); the deterministic layout package planned for the next
 * slice reads the same constants for pagination. Nothing here may be duplicated by hand
 * elsewhere — a second copy is how the two drift.
 *
 * The character grid is normative; inches are a rendering projection of it. `BODY_WIDTH_CHARACTERS`
 * and the per-element `characters` figures below are the specification, not a convenience derived
 * from dividing an inch measurement by a font's advance width. Never compute a character capacity
 * that way: it is the one calculation that would make line breaking font-dependent, which is
 * exactly what the fixed 10-pitch requirement exists to prevent. Where an inch figure and a
 * character figure both apply to the same element, the inch figure is what CSS renders and the
 * character figure is what pagination counts; they agree at nominal 10 pitch by specification, not
 * by measurement.
 */

/** US Letter page width, inches. Fixed; the page never reflows to the viewport. */
export const PAGE_WIDTH_IN = 8.5;

/** US Letter page height, inches. */
export const PAGE_HEIGHT_IN = 11;

/** Left margin, inches, measured from the physical page edge. */
export const MARGIN_LEFT_IN = 1.5;

/** Right margin, inches, measured from the physical page edge. */
export const MARGIN_RIGHT_IN = 1.0;

/** Top margin, inches, measured from the physical page edge. */
export const MARGIN_TOP_IN = 1.0;

/**
 * The bottom margin is not fixed. Pagination (the next slice) decides where a page breaks, and
 * whatever space remains below the last line is the bottom margin, ranging 0.5 to 1.5 in by
 * specification. There is deliberately no `MARGIN_BOTTOM_IN` constant: a fixed bottom padding
 * would fake a margin that pagination must own.
 */
export const MARGIN_BOTTOM_MIN_IN = 0.5;
export const MARGIN_BOTTOM_MAX_IN = 1.5;

/** Body width, inches: the page width minus the left and right margins. */
export const BODY_WIDTH_IN = PAGE_WIDTH_IN - MARGIN_LEFT_IN - MARGIN_RIGHT_IN;

/** Body width, characters. Normative — see the module comment. */
export const BODY_WIDTH_CHARACTERS = 60;

/** The screenplay typeface. Not adjustable, ever, per specification. */
export const TYPEFACE = 'Courier Prime';

/** Type size, points. Not adjustable, ever, per specification. */
export const TYPE_SIZE_PT = 12;

/**
 * The specified pitch: characters per inch at 12 pt Courier. This is the nominal figure the
 * specification is written in terms of — every horizontal measurement below is this many
 * characters per inch, by definition, not by measurement of any particular font file.
 */
export const NOMINAL_CHARACTERS_PER_INCH = 10;

/**
 * Leading, points. Equals `TYPE_SIZE_PT`: 12 pt type on 12 pt leading, single-spaced. This is
 * what makes six lines fill a vertical inch.
 */
export const LEADING_PT = 12;

/**
 * CSS `line-height`, unitless. A unitless line-height of 1 sets the line box to exactly
 * `TYPE_SIZE_PT`, independent of any font's internal ascent/descent metrics — measured in Chrome
 * at 12 pt (16 px) this produces an exact 16 px line box with no font-dependent variance at all,
 * unlike the horizontal pitch (see `MEASURED_COURIER_PRIME_ADVANCE_EM` below).
 */
export const LINE_HEIGHT_RATIO = 1;

/** Lines per vertical inch at `LEADING_PT` leading. */
export const LINES_PER_INCH = 6;

/** Body height, inches, at the minimum 1.0 in bottom margin: `PAGE_HEIGHT_IN - MARGIN_TOP_IN - 1.0`. */
export const BODY_HEIGHT_IN = PAGE_HEIGHT_IN - MARGIN_TOP_IN - 1.0;

/** Lines per page, inclusive range, given `LINES_PER_INCH` and the variable bottom margin. */
export const LINES_PER_PAGE_MIN = 54;
export const LINES_PER_PAGE_MAX = 55;

/** Page number position, inches from the top of the physical page. */
export const PAGE_NUMBER_TOP_IN = 0.5;

/** Page number position, inches from the right of the physical page. */
export const PAGE_NUMBER_RIGHT_IN = 0.75;

/**
 * Courier Prime's measured glyph advance width, as a fraction of its em box. This is an
 * OBSERVED fact, not a design input: measured in real Chrome (Playwright,
 * `PLAYWRIGHT_CHANNEL=chrome`) on 2026-08-08 by rendering 1/10/20/35/60-character runs of
 * multiple glyphs ('X', 'O', 'M', mixed text) at multiple font sizes (16, 100, 1000 px) and
 * multiple weights (400, 700), after confirming via `document.fonts.check(...)` that the real
 * webfont — not a fallback monospace — was in use. The ratio reproduced bit-for-bit across three
 * orders of magnitude of font size, which rules out subpixel rounding: it is a font design
 * metric, consistent with a 2048-unitsPerEm font whose glyph advance is 1228 units.
 *
 * 1228 / 2048 = 0.599609375, about 0.065% narrower than the nominal 0.6 em that exact 10 pitch
 * would require. Sixty characters therefore render about 0.004 in (0.1 mm) narrower than the
 * nominal 6.0 in, not wider — a full-measure line does not cross the right margin. This is
 * accepted and recorded, not corrected: forcing exactly 0.6 em with letter-spacing or a transform
 * would fight the font's real metrics and misbehave at other zoom levels for a discrepancy far
 * below anything visually meaningful.
 *
 * This constant exists to document the measurement and to back a regression test that fails
 * loudly if the rendered font's metrics ever drift — for example if Courier Prime fails to load
 * and a fallback monospace renders instead, whose ratio would not be close to this value. It
 * must NEVER be used to derive a layout figure: character budgets such as
 * `BODY_WIDTH_CHARACTERS` are normative and independent of it, and no line-breaking calculation
 * may divide an inch measurement by this ratio to obtain a character capacity.
 */
export const MEASURED_COURIER_PRIME_ADVANCE_EM = 1228 / 2048;

/**
 * Blank lines before each element, on the six-per-inch line grid -- see "Vertical spacing
 * between elements" in plan.md. Every blank line consumes one of the 54 to 55 lines on the page,
 * so this is a pagination input, not a styling choice, and must never be expressed in pixels: the
 * web editor's CSS derives a whole-line margin from these counts and the line-height custom
 * property, never a literal length.
 *
 * A speech is contiguous: character, parenthetical, and dialogue carry **zero** blank lines
 * before them relative to each other, in every order they can appear -- character to dialogue,
 * character to parenthetical, parenthetical to dialogue, and dialogue to a mid-speech
 * parenthetical. Only the `character` value below actually governs that (it is the sole entry
 * point into a speech); `parenthetical` and `dialogue` are zero unconditionally, which is exactly
 * what makes them contiguous with whatever preceded them inside the same speech. The blank line
 * before a `character` element is what separates one speech from the next.
 */
export const BLANK_LINES_BEFORE: Readonly<Record<ScreenplayElementKind, number>> = {
  scene_heading: 1,
  action: 1,
  character: 1,
  dialogue: 0,
  parenthetical: 0,
  transition: 1,
  shot: 1,
};

/** The screenplay elements the page format specifies indents for. */
export type ScreenplayElementKind =
  | 'scene_heading'
  | 'action'
  | 'character'
  | 'dialogue'
  | 'parenthetical'
  | 'transition'
  | 'shot';

/**
 * One element's horizontal placement, measured from the physical page edge per specification.
 * `leftIn`/`rightIn` are omitted where the specification gives no value for that side (a
 * one-sided indent with no fixed opposite edge, such as `character`). `characters` is omitted
 * for elements the specification gives no character budget for.
 */
export type ElementIndent = {
  readonly leftIn?: number;
  readonly rightIn?: number;
  readonly widthIn?: number;
  readonly characters?: number;
  readonly align?: 'left' | 'right';
};

/** Element indents, from the physical page edge, per specification. */
export const ELEMENT_INDENTS: Readonly<Record<ScreenplayElementKind, ElementIndent>> = {
  scene_heading: { leftIn: 1.5, rightIn: 1.0, widthIn: 6.0, characters: 60, align: 'left' },
  action: { leftIn: 1.5, rightIn: 1.0, widthIn: 6.0, characters: 60, align: 'left' },
  character: { leftIn: 3.7, align: 'left' },
  dialogue: { leftIn: 2.5, rightIn: 2.5, widthIn: 3.5, characters: 35, align: 'left' },
  parenthetical: { leftIn: 3.1, widthIn: 2.0, characters: 20, align: 'left' },
  transition: { rightIn: 1.0, align: 'right' },
  shot: { leftIn: 1.5, rightIn: 1.0, widthIn: 6.0, characters: 60, align: 'left' },
};

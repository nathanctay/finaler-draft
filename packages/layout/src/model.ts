/**
 * The layout package's output model: a deterministic page-and-line description of a canonical
 * screenplay. This is the sole public contract between pagination and its two consumers (the
 * in-browser editor and the server-side PDF renderer) — see `paginateScreenplay` in `paginate.ts`.
 */

import type { ScreenplayElementKind } from '@finaler-draft/screenplay/pageFormat';

/**
 * A JavaScript string index, UTF-16 code units. Same unit as the screenplay schema's annotation
 * offsets (`Utf16CodeUnitOffset` in `@finaler-draft/screenplay`). This is deliberately NOT the
 * unit line-wrapping measures against — wrapping counts graphemes (see `wrap.ts`), so a line's
 * character budget and a line's `startOffset`/`endOffset` are different units describing
 * different things: one is a rendered cell count, the other is a position in the source string.
 */
export type Utf16CodeUnitOffset = number;

/**
 * A blank grid row consumed by inter-element spacing (`BLANK_LINES_BEFORE`). Modeled as its own
 * row rather than a count carried on the following line, so "space before is suppressed at the
 * top of every page" is a structural property of the model instead of a rule a renderer has to
 * remember to apply: a page never begins with a `BlankLine`, by construction, which makes
 * `page.lines[0].kind !== 'blank'` true for every page and directly testable.
 */
export type BlankLine = {
  readonly kind: 'blank';
};

/**
 * One authored screen row, wrapped from a single canonical block's text.
 *
 * `startOffset`/`endOffset` are UTF-16 code units into that block's `text` (see
 * `Utf16CodeUnitOffset`). Ranges are contiguous and gapless across every authored line derived
 * from the same block, in source order:
 *
 * - the first line's `startOffset` is 0,
 * - each line's `endOffset` equals the next line's `startOffset`,
 * - the last line's `endOffset` equals `block.text.length`.
 *
 * Every UTF-16 code unit of the block's text therefore belongs to the range of exactly one line,
 * which is what lets a caller map any cursor offset or annotation anchor back to a single line.
 *
 * That gaplessness is deliberately NOT the same guarantee as `text` reproducing the source
 * exactly. `text` is the rendered content of the row; `startOffset`/`endOffset` is the source
 * span the row consumed while wrapping. They differ by exactly one thing: when a line ends
 * because a run of whitespace didn't fit, that whitespace is consumed into this line's
 * `endOffset` (so the next line's `startOffset` starts cleanly after it, and no code unit is
 * lost) but is never rendered — the line break substitutes for it, the same way a word processor
 * does not print a trailing space at a wrap point. Concretely:
 *
 * - `text === block.text.slice(startOffset, endOffset)` whenever the line ends because it ran
 *   out of tokens to place mid-word-boundary content that all fit (including any interior
 *   whitespace that fit and was rendered normally — authored text is never trimmed or
 *   normalised elsewhere in this range);
 * - `text` is a STRICT PREFIX of `block.text.slice(startOffset, endOffset)` when the line ends at
 *   a wrap point: the slice includes the whitespace run that caused the wrap, `text` does not.
 *
 * A caller that needs the exact source text for a range should slice `block.text` directly by
 * offset, not concatenate `text` fields.
 */
export type AuthoredLine = {
  readonly kind: 'authored';
  readonly element: ScreenplayElementKind;
  readonly blockId: string;
  readonly text: string;
  readonly startOffset: Utf16CodeUnitOffset;
  readonly endOffset: Utf16CodeUnitOffset;
};

/**
 * A line the engine inserted — `(MORE)` or a `CONT'D` continuation heading. Never present in the
 * canonical screenplay and never eligible to be written back to it.
 *
 * `sourceBlockId` identifies the `character` block whose speech was split: for `reason: 'more'`
 * it is the character block that opened the speech being split; for `reason: 'continued'` it is
 * the same character block, repeated on the continuation page.
 *
 * There is deliberately no `element` field. `(MORE)` and `CONT'D` render at the character indent
 * by rule (plan.md), not because they are `character` elements — they are layout artifacts, and
 * giving them `element: 'character'` would invite a renderer to treat them as authored character
 * cues (uppercasing, element-label display, extension stripping) when they are not. `reason`
 * alone determines how a renderer positions and formats them.
 *
 * Whether a writer may delete a generated line is a document-model and rendering question for a
 * later slice. This model only marks generated lines; it does not resolve that question.
 */
export type GeneratedLine = {
  readonly kind: 'generated';
  readonly reason: 'more' | 'continued';
  readonly sourceBlockId: string;
  readonly text: string;
};

export type PageLine = BlankLine | AuthoredLine | GeneratedLine;

export type Page = {
  /**
   * 1-based position of this page within the paginated body. Per plan.md, the first page carries
   * no printed page number and numbering begins at 2 on the second page — that is a rendering
   * decision (whether to draw the number), not something this model encodes beyond the position
   * itself; a renderer that wants the printed label omits it exactly when `pageNumber === 1`.
   * Title pages never paginate with the body and are never numbered — they do not appear here at
   * all, because `paginateScreenplay` never reads `Screenplay.titlePages`.
   */
  readonly pageNumber: number;
  readonly lines: readonly PageLine[];
  /** `lines.length`, exposed directly so callers don't need to re-derive it to reason about margins. */
  readonly lineCount: number;
  /**
   * The bottom margin this page's `lineCount` implies, in inches: `PAGE_HEIGHT_IN - MARGIN_TOP_IN
   * - lineCount / LINES_PER_INCH`. Plan.md's preferred range is 0.5–1.5 in, but a page outside
   * that range is a legitimate layout outcome, not a refusal — this engine fails only on
   * unsupported input (`dual_dialogue`), never on an unwelcome but valid margin. A page that ends
   * early because a keep-together rule (a scene heading, a character cue, or a parenthetical
   * moving whole rather than splitting) pulled content to the next page can widen this beyond
   * 1.5 in; see `paginate.test.ts` for the exact bound this engine can still produce and why.
   * Exposed so callers — including this package's own tests — can assert margin properties
   * across fixtures instead of this engine refusing to produce a page it doesn't like the shape of.
   */
  readonly bottomMarginIn: number;
};

export type LayoutResult = {
  readonly pages: readonly Page[];
};

/**
 * Thrown when the canonical screenplay contains a block this engine refuses to paginate rather
 * than guess about. `dual_dialogue` is the only case today: its column geometry is unsettled in
 * plan.md, and a wrong guess that silently produces plausible page numbers is worse than a
 * refusal.
 */
export class UnsupportedBlockError extends Error {
  readonly blockId: string;
  readonly blockType: string;

  constructor(blockId: string, blockType: string, message: string) {
    super(message);
    this.name = 'UnsupportedBlockError';
    this.blockId = blockId;
    this.blockType = blockType;
  }
}

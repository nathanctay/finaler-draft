/**
 * Line breaking: wraps a single canonical block's authored text into `AuthoredLine`s at a fixed
 * grapheme budget. See `packages/screenplay/src/pageFormat.ts` for where the budgets come from —
 * this module never reads anything but the `characters` figure already computed there.
 */

import {
  BODY_WIDTH_CHARACTERS,
  ELEMENT_INDENTS,
  MARGIN_RIGHT_IN,
  NOMINAL_CHARACTERS_PER_INCH,
  PAGE_WIDTH_IN,
} from '@finaler-draft/screenplay/pageFormat';
import type { ScreenplayElementKind } from '@finaler-draft/screenplay/pageFormat';
import type { AuthoredLine, Utf16CodeUnitOffset } from './model.js';

/**
 * Grapheme segmentation, fixed to an explicit locale rather than the runtime default.
 *
 * Extended grapheme cluster boundaries — the default algorithm behind `Intl.Segmenter`'s
 * `'grapheme'` granularity — are not locale-tailored the way word and sentence boundaries are:
 * there is no per-locale grapheme dictionary the way there is, say, Thai word segmentation.
 * Passing an explicit locale here is defensive rather than corrective: it guarantees this
 * module's output cannot vary with `Intl.DefaultLocale`, which is a process/runtime setting, not
 * a property of the document, and pagination must never depend on it.
 *
 * Word-boundary detection below deliberately does NOT use `Intl.Segmenter`'s `'word'`
 * granularity, which IS dictionary- and locale-sensitive (and, for some scripts, explicitly
 * permitted by spec to vary across implementations and ICU versions). Word boundaries here are
 * plain runs of whitespace vs. non-whitespace — deterministic, and sufficient for a fixed-pitch
 * Latin-script screenplay grid.
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

function graphemeLength(text: string): number {
  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _segment of GRAPHEME_SEGMENTER.segment(text)) {
    count += 1;
  }
  return count;
}

/** The UTF-16 length of the first `count` graphemes of `text`. `text` must have >= `count` graphemes. */
function utf16LengthOfFirstGraphemes(text: string, count: number): number {
  let seen = 0;
  for (const segment of GRAPHEME_SEGMENTER.segment(text)) {
    if (seen === count) {
      return segment.index;
    }
    seen += 1;
  }
  return text.length;
}

type Token = {
  readonly content: string;
  readonly start: Utf16CodeUnitOffset;
  readonly end: Utf16CodeUnitOffset;
  readonly isWhitespace: boolean;
};

const WHITESPACE_RUN = /^\s+$/;

/**
 * Splits `text` into maximal runs of whitespace and maximal runs of non-whitespace, tagged with
 * UTF-16 offsets into `text`. `String.split` on a capturing regexp can yield empty strings at the
 * boundaries (e.g. when `text` starts with whitespace); those carry no content and are dropped —
 * they would only complicate the offset bookkeeping below for no benefit, since offsets are
 * tracked by accumulating consumed length, not by token position.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  for (const piece of text.split(/(\s+)/)) {
    if (piece.length > 0) {
      tokens.push({
        content: piece,
        start: offset,
        end: offset + piece.length,
        isWhitespace: WHITESPACE_RUN.test(piece),
      });
    }
    offset += piece.length;
  }
  return tokens;
}

type PendingLine = {
  startOffset: Utf16CodeUnitOffset;
  parts: string[];
  cellCount: number;
  consumedEnd: Utf16CodeUnitOffset;
};

function freshLine(offset: Utf16CodeUnitOffset): PendingLine {
  return { startOffset: offset, parts: [], cellCount: 0, consumedEnd: offset };
}

/**
 * Wraps one block's authored text at a fixed grapheme budget, producing gapless `AuthoredLine`s.
 * See the `AuthoredLine` doc comment in `model.ts` for the offset/text-content contract this
 * implements — in particular, that `text` omits a wrap-causing whitespace run that `endOffset`
 * still covers.
 *
 * A single word longer than the budget is hard-broken at the budget boundary, with no hyphen:
 * screenplay format has no hyphenation convention, and inventing one here would be a formatting
 * decision this engine has no basis to make. The break repeats if the remainder is itself still
 * longer than the budget.
 *
 * Always produces at least one line, even for empty text — a block is addressable (for cursor
 * positioning) regardless of whether it currently holds any characters.
 */
export function wrapBlockText(
  blockId: string,
  element: ScreenplayElementKind,
  text: string,
  budget: number,
): AuthoredLine[] {
  const lines: AuthoredLine[] = [];

  const emit = (line: PendingLine): void => {
    lines.push({
      kind: 'authored',
      element,
      blockId,
      text: line.parts.join(''),
      startOffset: line.startOffset,
      endOffset: line.consumedEnd,
    });
  };

  // Tokens to process, as a stack (pop from the end); hard-split remainders get pushed back on,
  // and a word that doesn't fit on the current line is pushed back to be retried on a fresh one.
  const stack: Token[] = tokenize(text).reverse();
  let line = freshLine(0);

  while (stack.length > 0) {
    // Non-null: the `while` guard above already guarantees the stack is non-empty.
    const token = stack.pop() as Token;
    const tokenLength = graphemeLength(token.content);
    const lineHasContent = line.parts.length > 0;

    if (!lineHasContent) {
      if (tokenLength <= budget) {
        line.parts.push(token.content);
        line.cellCount += tokenLength;
        line.consumedEnd = token.end;
        continue;
      }

      // The token alone exceeds the budget: hard-split at the budget boundary and requeue the rest.
      const splitAt = utf16LengthOfFirstGraphemes(token.content, budget);
      const head = token.content.slice(0, splitAt);
      const tail = token.content.slice(splitAt);
      emit({
        startOffset: token.start,
        parts: [head],
        cellCount: budget,
        consumedEnd: token.start + splitAt,
      });
      stack.push({
        content: tail,
        start: token.start + splitAt,
        end: token.end,
        isWhitespace: token.isWhitespace,
      });
      line = freshLine(token.start + splitAt);
      continue;
    }

    if (line.cellCount + tokenLength <= budget) {
      line.parts.push(token.content);
      line.cellCount += tokenLength;
      line.consumedEnd = token.end;
      continue;
    }

    if (token.isWhitespace) {
      // The break point: this whitespace run is consumed by the line break, not rendered.
      line.consumedEnd = token.end;
      emit(line);
      line = freshLine(token.end);
      continue;
    }

    // A word that doesn't fit moves to the next line in its entirety.
    emit(line);
    line = freshLine(line.consumedEnd);
    stack.push(token);
  }

  if (lines.length === 0 || line.parts.length > 0) {
    emit(line);
  }

  return lines;
}

/**
 * `character` and `transition` have no `characters` figure in `ELEMENT_INDENTS` — plan.md states
 * wrap budgets directly only for action, scene heading, shot (60), dialogue (35), and
 * parenthetical (20). Leaving the other two unwrapped would let an over-long cue or transition
 * run past the right margin and off the page, silently corrupting the PDF: the worst failure
 * mode available. Their budgets are not missing, they are implied by the same geometry every
 * other element's budget already projects from character cells: no element may cross the right
 * margin at `PAGE_WIDTH_IN - MARGIN_RIGHT_IN` (7.5 in).
 *
 * This derivation multiplies by `NOMINAL_CHARACTERS_PER_INCH` — the specified nominal 10-pitch
 * grid every measurement in pageFormat.ts is written in terms of — and never
 * `MEASURED_COURIER_PRIME_ADVANCE_EM`, which is the one constant this engine must never read.
 * `Math.round` only absorbs binary floating-point noise in the inch subtraction (e.g.
 * `7.5 - 3.7`); both results are exact integers by specification and are pinned by tests.
 */

/** `character` starts at `ELEMENT_INDENTS.character.leftIn` (3.7 in) and runs to the right margin. */
const CHARACTER_CUE_LEFT_IN = ELEMENT_INDENTS.character.leftIn;
if (CHARACTER_CUE_LEFT_IN === undefined) {
  throw new Error(
    'ELEMENT_INDENTS.character.leftIn is unset; the character wrap-budget derivation is stale.',
  );
}

/** Derived, not normative: `(7.5 - 3.7) in * 10 chars/in = 38 characters`. */
export const CHARACTER_WRAP_BUDGET = Math.round(
  (PAGE_WIDTH_IN - MARGIN_RIGHT_IN - CHARACTER_CUE_LEFT_IN) * NOMINAL_CHARACTERS_PER_INCH,
);

/**
 * `transition` is right-aligned at the same right margin as the body and, per plan.md, may
 * extend left to the same left margin as the body — so its budget is exactly the body width in
 * characters. Reusing `BODY_WIDTH_CHARACTERS` avoids a second inch calculation for a figure the
 * specification already states directly.
 */
export const TRANSITION_WRAP_BUDGET = BODY_WIDTH_CHARACTERS;

/**
 * Wraps one block's authored text according to its element's page-format budget — the direct
 * `ELEMENT_INDENTS` figure where one exists, or the derived `character`/`transition` budget
 * above otherwise. Every `ScreenplayElementKind` has a budget; none is left unwrapped.
 */
export function wrapBlock(
  blockId: string,
  element: ScreenplayElementKind,
  text: string,
): AuthoredLine[] {
  const budget =
    element === 'character'
      ? CHARACTER_WRAP_BUDGET
      : element === 'transition'
        ? TRANSITION_WRAP_BUDGET
        : ELEMENT_INDENTS[element].characters;
  if (budget === undefined) {
    throw new Error(`No wrap budget is available for element "${element}".`);
  }
  return wrapBlockText(blockId, element, text, budget);
}

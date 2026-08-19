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
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@finaler-draft/screenplay';
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

/**
 * Fast path for the common case: text made entirely of printable ASCII, `\x20` (space) through
 * `\x7E` (`~`).
 *
 * This is not merely "usually true", it is safe by construction. Every code point in this range
 * is, on its own, a full extended grapheme cluster under UAX #29: none of them is a combining
 * mark, a variation selector, a ZWJ, a regional indicator, or any other character that extends or
 * joins with a neighbor. So within this range, and only within it, one code point is always
 * exactly one grapheme, which means grapheme count is exactly `String.length` (UTF-16 code
 * units) and no `Intl.Segmenter` iteration is needed to get that count.
 *
 * The range is deliberately `\x20`-`\x7E`, not the full 7-bit `\x00`-`\x7F`: it excludes every
 * C0 control character, and in particular CR (`\x0D`) and LF (`\x0A`). `\r\n` is the one ASCII
 * sequence where two code units form a single grapheme cluster (UAX #29's explicit CR x LF
 * boundary rule) -- a range that admitted control characters would silently mis-split it. Because
 * `\r` and `\n` fall outside this range, any text containing `\r\n` fails this test and falls
 * through to the `Intl.Segmenter` path below unchanged, which handles it correctly.
 *
 * Everything outside `\x20`-`\x7E` -- every non-ASCII character, and every ASCII control
 * character -- always falls through to `Intl.Segmenter` too; this path never runs for them.
 */
const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;

function graphemeLength(text: string): number {
  if (ASCII_PRINTABLE.test(text)) {
    return text.length;
  }
  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _segment of GRAPHEME_SEGMENTER.segment(text)) {
    count += 1;
  }
  return count;
}

/** The UTF-16 length of the first `count` graphemes of `text`. `text` must have >= `count` graphemes. */
function utf16LengthOfFirstGraphemes(text: string, count: number): number {
  // Safe by the same reasoning as `graphemeLength` above: within \x20-\x7E, one code point is
  // one grapheme, so the first `count` graphemes are exactly the first `count` code units.
  if (ASCII_PRINTABLE.test(text)) {
    return Math.min(count, text.length);
  }
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
 * parenthetical (20, itself `parentheticalWidthIn * NOMINAL_CHARACTERS_PER_INCH` at the
 * specification's default 2.0 in width). Leaving `character`/`transition` unwrapped would let an
 * over-long cue or transition run past the right margin and off the page, silently corrupting the
 * PDF: the worst failure mode available. Their budgets are not missing, they are implied by the
 * same geometry every other element's budget already projects from character cells: no element
 * may cross the right margin at `PAGE_WIDTH_IN - MARGIN_RIGHT_IN` (7.5 in).
 *
 * `character` and `parenthetical` are, per plan.md's "Document settings" section, the two
 * elements whose geometry a document setting may move (indent for both, width for parenthetical
 * too) — every other element's budget above is specification, not a setting, and stays fixed.
 * Both derivations below multiply by `NOMINAL_CHARACTERS_PER_INCH` — the specified nominal
 * 10-pitch grid every measurement in pageFormat.ts is written in terms of — and never
 * `MEASURED_COURIER_PRIME_ADVANCE_EM`, which is the one constant this engine must never read.
 * `Math.round` only absorbs binary floating-point noise in the inch arithmetic (e.g. `7.5 - 3.7`);
 * every result at the specification's default settings is an exact integer, pinned by tests.
 */

/** `character` starts at its (adjustable) indent and runs to the right margin. */
function characterWrapBudgetFor(characterIndentIn: number): number {
  return Math.round(
    (PAGE_WIDTH_IN - MARGIN_RIGHT_IN - characterIndentIn) * NOMINAL_CHARACTERS_PER_INCH,
  );
}

/** `parenthetical`'s budget is its (adjustable) width, in characters at the nominal pitch. */
function parentheticalWrapBudgetFor(parentheticalWidthIn: number): number {
  return Math.round(parentheticalWidthIn * NOMINAL_CHARACTERS_PER_INCH);
}

/**
 * Derived at the specification's default settings, not normative on their own: `(7.5 - 3.7) in *
 * 10 chars/in = 38 characters`. Retained as a plain constant (rather than requiring every caller
 * to invoke `characterWrapBudgetFor(DEFAULT_DOCUMENT_SETTINGS.characterIndentIn)`) because it is
 * still what a caller gets when no document settings are supplied, and existing tests pin it by
 * name.
 */
export const CHARACTER_WRAP_BUDGET = characterWrapBudgetFor(
  DEFAULT_DOCUMENT_SETTINGS.characterIndentIn,
);

/**
 * `transition` is right-aligned at the same right margin as the body and, per plan.md, may
 * extend left to the same left margin as the body — so its budget is exactly the body width in
 * characters. Reusing `BODY_WIDTH_CHARACTERS` avoids a second inch calculation for a figure the
 * specification already states directly. Not adjustable: `transition` is not among the elements
 * plan.md's "Document settings" section lists.
 */
export const TRANSITION_WRAP_BUDGET = BODY_WIDTH_CHARACTERS;

/**
 * Wraps one block's authored text according to its element's page-format budget: the direct
 * `ELEMENT_INDENTS` figure for the elements whose budget is fixed specification, or a budget
 * derived from `geometry` for `character`/`parenthetical` (adjustable) and `transition` (fixed,
 * but likewise implied rather than tabulated — see the module comment above). Every
 * `ScreenplayElementKind` has a budget; none is left unwrapped.
 *
 * `geometry` defaults to the specification's current fixed values, so every caller that predates
 * document settings — including every existing test in this package — keeps producing identical
 * output unchanged.
 */
export function wrapBlock(
  blockId: string,
  element: ScreenplayElementKind,
  text: string,
  geometry: Pick<
    DocumentSettings,
    'characterIndentIn' | 'parentheticalWidthIn'
  > = DEFAULT_DOCUMENT_SETTINGS,
): AuthoredLine[] {
  const budget =
    element === 'character'
      ? characterWrapBudgetFor(geometry.characterIndentIn)
      : element === 'transition'
        ? TRANSITION_WRAP_BUDGET
        : element === 'parenthetical'
          ? parentheticalWrapBudgetFor(geometry.parentheticalWidthIn)
          : ELEMENT_INDENTS[element].characters;
  if (budget === undefined) {
    throw new Error(`No wrap budget is available for element "${element}".`);
  }
  return wrapBlockText(blockId, element, text, budget);
}

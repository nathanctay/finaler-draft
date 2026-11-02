import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { ScreenplayBlock } from '@finaler-draft/screenplay';
import type { LocalScreenplayProjection } from './screenplayEditor.js';

/**
 * Dash runs that separate two thoughts rather than joining one word: an em dash, an en dash, or
 * the typewriter double hyphen screenplays conventionally use for an interruption. These are
 * replaced with a space before splitting, so `turned--she` and `turned\u2014she` count as two words.
 *
 * A **single** hyphen between word characters is deliberately absent: it is the joining case
 * (`Spider-Man`, `mother-in-law`, `same-origin`), which every dictionary and both Word and Google
 * Docs treat as one word. The owner's instinct was to break on every dash, on the reasoning that
 * the two-thoughts use is the more common one; measured against his own test screenplay that is
 * true of the *category* and not of the single hyphen -- the document held 1 intra-word hyphen and
 * 0 em dashes or double hyphens, and breaking every dash would push this count *above* Word's
 * rather than closer to it. Narrowed to the separator forms on that evidence.
 */
const THOUGHT_SEPARATING_DASHES = /--+|[\u2013\u2014]+/gu;

/**
 * A token that is nothing but dash characters -- what " - " in `INT. APARTMENT - MORNING` leaves
 * behind once whitespace splitting is done. Not a word.
 *
 * Deliberately this narrow, rather than "any token containing no letter or digit". The broader rule
 * was built first and measured against the owner's own test screenplay: it removed 22 tokens where
 * this one removes 3, the extra 19 being `#` markers and divider lines from configuration text
 * pasted into that document. Word counts those as words, so the broad rule moved *away* from Word
 * (a gap of 31 against 12) on the strength of content no real screenplay contains. The narrow rule
 * is also exactly what the owner approved; the broader one remains available if a lone `...` as a
 * beat of dialogue should ever stop counting, which is a separate judgement about prose, not
 * punctuation hygiene.
 */
const DASH_ONLY_TOKEN = /^[-\u2013\u2014]+$/u;

/**
 * The one word-splitting rule used everywhere a word count is reported in this app: replace
 * thought-separating dash runs with a space, split on runs of Unicode whitespace, and keep only
 * the tokens that actually contain a letter or digit. `wordsInProjection` below (the status bar's
 * own count, and the document side of the Tools > Word count dialog's "Words" line) and
 * `countWordsAndCharactersInRange` (that dialog's selection-aware side) both call this rather than
 * each writing its own split -- two independent word-splitting implementations in one product is
 * exactly the defect `progress/menus-slice-2.md` records this module exists to rule out. See
 * `wordCount.test.ts`'s own whole-document invariant: a selection spanning the entire document
 * must count exactly as many words as `wordsInProjection` reports for that same document, which
 * only holds because both paths end here.
 *
 * The `DASH_ONLY_TOKEN` filter is what stops a standalone dash counting as a word -- the ` - ` in
 * a `INT. PLACE - TIME` scene heading, which essentially every scene heading carries, so this
 * lowers a real script's count by one per heading. Found because the owner's count read 9 below
 * Word's on the same text; 3 of those were these hyphens, and the remaining 6 were URL and `.env`
 * strings this tokenizer keeps whole and Word splits on `/` and `:` -- an artifact of that test
 * document rather than something to tune for. Parity with Word was never the target; not counting
 * a dash as a word is correct on its own terms.
 */
export function countWords(text: string): number {
  const separated = text.replace(THOUGHT_SEPARATING_DASHES, ' ').trim();
  if (separated === '') {
    return 0;
  }
  return separated.split(/\s+/u).filter((token) => !DASH_ONLY_TOKEN.test(token)).length;
}

/**
 * The document's total word count -- the one the status bar has always shown (`App.tsx`'s
 * `wordCount`, unchanged by this move) and the one the Word count dialog's "Words" line reports as
 * the document side of its Docs-style "N of M" framing. Moved here, verbatim, from `App.tsx` so
 * both callers import the identical function rather than each carrying their own copy that could
 * silently drift apart.
 *
 * `page_break` and `dual_dialogue` blocks carry no `text` field at all (see `packages/screenplay`'s
 * `screenplayBlockSchema`, a discriminated union) and are skipped rather than counted. This is moot
 * for any screenplay the text-block editor can actually open: `editorContentFromScreenplay` refuses
 * either feature closed, falling the whole document back to read-only with no `editor` selection to
 * count in the first place. It still matters for the read-only revision comparison's own
 * `projectDocumentScreenplay`, which both block types reach, and which is why the skip stays rather
 * than being dropped as dead code.
 */
export function wordsInProjection(projection: LocalScreenplayProjection): number {
  if (!projection.valid) {
    return 0;
  }

  return projection.screenplay.blocks.reduce((total: number, block: ScreenplayBlock) => {
    if (block.type === 'page_break' || block.type === 'dual_dialogue') {
      return total;
    }
    return total + countWords(block.text);
  }, 0);
}

/**
 * The document's total character count, read the same shape `wordsInProjection` above uses --
 * same per-block skip for `page_break`/`dual_dialogue`, same `reduce` -- so the two totals can
 * never disagree about what "the document" is. Raw `.length`, not `.trim()`med: a character count
 * counts every character actually present, including interior whitespace, which is also what
 * makes it agree with `countWordsAndCharactersInRange`'s empty-separator concatenation below when
 * a selection spans the whole document -- no synthesized boundary character on either side.
 */
export function charactersInProjection(projection: LocalScreenplayProjection): number {
  if (!projection.valid) {
    return 0;
  }

  return projection.screenplay.blocks.reduce((total: number, block: ScreenplayBlock) => {
    if (block.type === 'page_break' || block.type === 'dual_dialogue') {
      return total;
    }
    return total + block.text.length;
  }, 0);
}

export interface RangeWordCount {
  readonly characters: number;
  readonly words: number;
}

/**
 * Words and characters in `[from, to)` of a ProseMirror doc -- the Tools > Word count dialog's
 * selection-aware half (Docs-style "Words: 12 of 345"). Two different `doc.textBetween` calls,
 * deliberately, not one reused for both:
 *
 * - Words: blocks joined with `'\n'`, the identical separator `copySelectionText` (App.tsx) already
 *   uses for Copy, run through the same `countWords` the document total calls. A block boundary has
 *   to introduce *some* separator here, or the last word of one block and the first word of the
 *   next would read as a single run-together word; `\s+`-splitting then collapses that separator
 *   (and any amount of real whitespace either side of it) exactly the way summing each block's own
 *   `countWords` already does, which is what lets this agree with `wordsInProjection` for a
 *   whole-document range -- see this module's own top comment and `wordCount.test.ts`.
 * - Characters: blocks concatenated with no separator at all. A block boundary is not itself a
 *   character, and introducing one here would make a multi-block selection's character count
 *   overcount relative to `charactersInProjection`'s own plain per-block `.length` sum -- the same
 *   drift this module exists to prevent, just for characters instead of words.
 */
export function countWordsAndCharactersInRange(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): RangeWordCount {
  return {
    characters: doc.textBetween(from, to, '').length,
    words: countWords(doc.textBetween(from, to, '\n')),
  };
}

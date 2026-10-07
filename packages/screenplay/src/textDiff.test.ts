import { describe, expect, it } from 'vitest';
import {
  MAX_WORD_DIFF_EDIT_DISTANCE,
  diffWords,
  textDiffHasMarks,
  tokenizeWords,
  type TextDiffSegment,
} from './textDiff.js';

/** The two reconstruction identities every result must satisfy, asserted on every comparison in
 * this file rather than only where a case looked risky: the `'equal'` plus `'removed'` segments
 * must rebuild `before` exactly, and the `'equal'` plus `'added'` segments must rebuild `after`
 * exactly. Together they are what makes a segment list a *diff* of those two strings and not merely
 * a plausible-looking set of marks -- a marking bug that drops, duplicates, or re-spaces a word
 * fails here even when the mark positions look right. */
function expectRoundTrip(
  segments: readonly TextDiffSegment[],
  before: string,
  after: string,
): void {
  const rebuild = (kind: 'removed' | 'added'): string =>
    segments
      .filter((segment) => segment.kind === 'equal' || segment.kind === kind)
      .map((segment) => segment.text)
      .join('');
  expect(rebuild('removed')).toBe(before);
  expect(rebuild('added')).toBe(after);
}

function diff(before: string, after: string): TextDiffSegment[] {
  const segments = diffWords(before, after);
  expectRoundTrip(segments, before, after);
  // Canonical form: no empty segment, and no two adjacent segments sharing a kind.
  for (const [index, segment] of segments.entries()) {
    expect(segment.text.length).toBeGreaterThan(0);
    if (index > 0) expect(segments[index - 1]!.kind).not.toBe(segment.kind);
  }
  return segments;
}

/** The marked words only, as a readable summary -- what a reader would actually see struck through
 * or marked as added, with the untouched text excluded. */
function marked(segments: readonly TextDiffSegment[]): string[] {
  return segments
    .filter((segment) => segment.kind !== 'equal')
    .map((segment) => `${segment.kind === 'removed' ? '-' : '+'}${segment.text}`);
}

describe('tokenizeWords', () => {
  it('preserves every code unit, so tokens always rejoin into the original text', () => {
    for (const text of [
      '',
      'one',
      'two words',
      '  leading and trailing  ',
      'tabs\tand\nnewlines',
      'double  spaced  words',
    ]) {
      expect(tokenizeWords(text).join('')).toBe(text);
    }
  });

  it('carries trailing whitespace with its own word, with a leading run as its own token', () => {
    expect(tokenizeWords('a  b')).toEqual(['a  ', 'b']);
    expect(tokenizeWords(' a')).toEqual([' ', 'a']);
    expect(tokenizeWords('')).toEqual([]);
    expect(tokenizeWords('   ')).toEqual(['   ']);
  });
});

describe('diffWords', () => {
  it('produces no marks at all for identical text', () => {
    const segments = diff('INT. HOUSE - DAY', 'INT. HOUSE - DAY');
    expect(segments).toEqual([{ kind: 'equal', text: 'INT. HOUSE - DAY' }]);
    expect(textDiffHasMarks(segments)).toBe(false);
    expect(marked(segments)).toEqual([]);
  });

  it('produces nothing at all for two empty strings', () => {
    expect(diff('', '')).toEqual([]);
    expect(textDiffHasMarks([])).toBe(false);
  });

  /**
   * The property this whole module exists for, and the one the redesign's first mutation test
   * breaks: a one-word change inside a long speech marks exactly that one word, leaving every other
   * word unmarked. The surrounding text is asserted to be `'equal'` explicitly -- not merely absent
   * from the marks -- so a "mark everything" regression cannot pass by happening to also contain the
   * changed word.
   */
  it('marks exactly one word for a one-word change, leaving the rest of a long speech untouched', () => {
    const before =
      'I have been standing in this doorway since Tuesday and nobody has said a single word to me.';
    const after =
      'I have been standing in this doorway since Thursday and nobody has said a single word to me.';
    const segments = diff(before, after);

    expect(marked(segments)).toEqual(['-Tuesday ', '+Thursday ']);
    expect(segments).toEqual([
      { kind: 'equal', text: 'I have been standing in this doorway since ' },
      { kind: 'removed', text: 'Tuesday ' },
      { kind: 'added', text: 'Thursday ' },
      { kind: 'equal', text: 'and nobody has said a single word to me.' },
    ]);
    // Measured, not assumed: the overwhelming majority of the text is reported unchanged.
    const equalLength = segments
      .filter((segment) => segment.kind === 'equal')
      .reduce((total, segment) => total + segment.text.length, 0);
    expect(equalLength).toBeGreaterThan(before.length * 0.8);
  });

  it('marks a one-word change at the very start and at the very end of a line', () => {
    expect(marked(diff('Tuesday came and went.', 'Thursday came and went.'))).toEqual([
      '-Tuesday ',
      '+Thursday ',
    ]);
    expect(marked(diff('It came and went.', 'It came and stayed.'))).toEqual([
      '-went.',
      '+stayed.',
    ]);
  });

  it('marks the whole line, as one span each side, when the whole line was rewritten', () => {
    const before = 'She waits beside a window.';
    const after = 'He bolts toward the stairwell.';
    const segments = diff(before, after);
    // No word survives, so nothing is equal -- and each side is one continuous span, not a string of
    // fragments broken apart by the spaces between the words.
    expect(segments).toEqual([
      { kind: 'removed', text: before },
      { kind: 'added', text: after },
    ]);
  });

  it('marks only the inserted words for an insertion within a line', () => {
    const segments = diff('The quick fox jumps.', 'The quick brown fox jumps.');
    expect(marked(segments)).toEqual(['+brown ']);
    expect(segments[0]).toEqual({ kind: 'equal', text: 'The quick ' });
    expect(segments.some((segment) => segment.kind === 'removed')).toBe(false);
  });

  it('marks only the deleted words for a deletion within a line', () => {
    const segments = diff('The quick brown fox jumps.', 'The quick fox jumps.');
    expect(marked(segments)).toEqual(['-brown ']);
    expect(segments.some((segment) => segment.kind === 'added')).toBe(false);
  });

  it('marks an insertion at the end and a deletion at the start without touching the rest', () => {
    expect(marked(diff('Hold the line', 'Hold the line now'))).toEqual(['-line', '+line now']);
    expect(marked(diff('Well, hold the line', 'hold the line'))).toEqual(['-Well, ']);
  });

  it('reports a replacement as the removal first, then the addition', () => {
    const segments = diff('one two three', 'one TWO three');
    expect(marked(segments)).toEqual(['-two ', '+TWO ']);
    const kinds = segments.map((segment) => segment.kind);
    expect(kinds.indexOf('removed')).toBeLessThan(kinds.indexOf('added'));
  });

  it('marks two separate word changes separately rather than as one span covering the middle', () => {
    const segments = diff(
      'The red door opens onto the blue hallway.',
      'The green door opens onto the yellow hallway.',
    );
    expect(marked(segments)).toEqual(['-red ', '+green ', '-blue ', '+yellow ']);
    // The words between the two changes stay equal -- the point of word granularity.
    expect(segments.some((s) => s.kind === 'equal' && s.text.includes('door opens onto the'))).toBe(
      true,
    );
  });

  it('treats a word only re-cased as a changed word, since a reader sees the difference', () => {
    expect(marked(diff('she waits.', 'She waits.'))).toEqual(['-she ', '+She ']);
  });

  /** The stated cost of carrying trailing whitespace with its word (`tokenizeWords`'s own comment):
   * a spacing-only change marks the word the spacing follows. Asserted so the trade-off is recorded
   * in a test rather than only in a comment. */
  it('marks a spacing-only change as a change to the word the spacing follows', () => {
    expect(marked(diff('one two', 'one  two'))).toEqual(['-one ', '+one  ']);
  });

  it('handles an empty side in either direction as a pure addition or a pure removal', () => {
    expect(diff('', 'Brand new line.')).toEqual([{ kind: 'added', text: 'Brand new line.' }]);
    expect(diff('Line that went away.', '')).toEqual([
      { kind: 'removed', text: 'Line that went away.' },
    ]);
  });

  it('marks a word-order swap as the minimal pair of edits, not as a rewrite of the line', () => {
    const segments = diff('she turns and leaves', 'and she turns leaves');
    expect(segments.some((segment) => segment.kind === 'equal')).toBe(true);
    const markedText = segments
      .filter((segment) => segment.kind !== 'equal')
      .reduce((total, segment) => total + segment.text.length, 0);
    expect(markedText).toBeLessThan('she turns and leaves'.length);
  });

  /**
   * The cap's own behaviour, asserted rather than assumed (`MAX_WORD_DIFF_EDIT_DISTANCE`): two texts
   * far enough apart that the search is abandoned degrade to a wholesale replacement of the
   * non-shared middle -- and, importantly, still never claim that the *shared* prefix changed. A
   * degraded answer that over-reported would be the exact readability failure this module exists to
   * remove, so the trim must survive the fallback.
   */
  it('degrades to a wholesale replacement past the edit-distance cap, still keeping the shared ends equal', () => {
    const shared = 'IDENTICAL OPENING WORDS ';
    const wordCount = MAX_WORD_DIFF_EDIT_DISTANCE * 2;
    const before = `${shared}${Array.from({ length: wordCount }, (_, i) => `alpha${i}`).join(' ')} TAIL`;
    const after = `${shared}${Array.from({ length: wordCount }, (_, i) => `omega${i}`).join(' ')} TAIL`;
    const segments = diff(before, after);
    expect(segments[0]).toEqual({ kind: 'equal', text: 'IDENTICAL OPENING WORDS ' });
    expect(segments[segments.length - 1]).toEqual({ kind: 'equal', text: 'TAIL' });
    expect(segments.filter((segment) => segment.kind === 'removed')).toHaveLength(1);
    expect(segments.filter((segment) => segment.kind === 'added')).toHaveLength(1);
  });

  it('stays fast on a one-word change inside a very long block, because cost tracks the change', () => {
    const body = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(' ');
    const before = `${body} end`;
    const after = `${body} END`;
    const started = performance.now();
    const segments = diff(before, after);
    const elapsedMs = performance.now() - started;
    expect(marked(segments)).toEqual(['-end', '+END']);
    expect(segments[0]!.kind).toBe('equal');
    // Generous by two orders of magnitude over what this actually measures, so this asserts the
    // complexity claim (cost tracks the change, not the text) without being a timing flake.
    expect(elapsedMs).toBeLessThan(500);
  });
});

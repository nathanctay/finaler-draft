import { describe, expect, it } from 'vitest';
import { CHARACTER_WRAP_BUDGET, TRANSITION_WRAP_BUDGET, wrapBlock, wrapBlockText } from './wrap.js';

const BLOCK_ID = 'b1';

/** Reassembles the gapless offset chain and checks it covers `text` exactly once, in order. */
function assertGapless(lines: readonly { startOffset: number; endOffset: number }[], text: string) {
  expect(lines[0]?.startOffset ?? 0).toBe(0);
  for (let i = 0; i < lines.length - 1; i += 1) {
    expect(lines[i]?.endOffset).toBe(lines[i + 1]?.startOffset);
  }
  expect(lines.at(-1)?.endOffset).toBe(text.length);
}

describe('wrapBlockText', () => {
  it('keeps text that fits the budget on a single line, verbatim', () => {
    const text = 'INT. UNION STATION - NIGHT';
    const lines = wrapBlockText(BLOCK_ID, 'scene_heading', text, 60);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text, startOffset: 0, endOffset: text.length });
    assertGapless(lines, text);
  });

  it('preserves interior double spaces exactly (no whitespace normalisation)', () => {
    const text = 'Rain falls  hard on the roof.';
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 60);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(text);
  });

  it('wraps at a word boundary and swallows the breaking space from rendered text', () => {
    // "1234567890" is exactly the 10-character budget, so the following space has no room left
    // (10 + 1 > 10) and is swallowed by the break; a space that DID fit would legitimately render
    // (see the "preserves interior double spaces" and "space fits before the wrap" cases).
    const text = '1234567890 abcde';
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 10);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('1234567890');
    expect(lines[1]?.text).toBe('abcde');
    // The breaking space is consumed into line 0's span but is not part of its rendered text.
    expect(lines[0]?.startOffset).toBe(0);
    expect(lines[0]?.endOffset).toBe(11); // covers "1234567890 " including the space
    expect(text.slice(lines[0]!.startOffset, lines[0]!.endOffset)).not.toBe(lines[0]!.text);
    expect(text.slice(lines[0]!.startOffset, lines[0]!.endOffset)).toBe('1234567890 ');
    assertGapless(lines, text);
  });

  it('renders a space normally when it fits before the word that forces the wrap', () => {
    // "1234567890" (10) + " " (1) = 11 <= budget 11, so the space is real rendered content; only
    // "abcde" is pushed to the next line. This is the direct contrast with the swallowed case
    // above: whether a space renders depends solely on whether it fits, not on its role.
    const text = '1234567890 abcde';
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 11);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('1234567890 ');
    expect(lines[1]?.text).toBe('abcde');
    expect(text.slice(lines[0]!.startOffset, lines[0]!.endOffset)).toBe(lines[0]!.text);
    assertGapless(lines, text);
  });

  it('hard-splits a single word longer than the budget, with no hyphen', () => {
    const text = 'Supercalifragilisticexpialidocious';
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 10);
    expect(lines.map((l) => l.text)).toEqual(['Supercalif', 'ragilistic', 'expialidoc', 'ious']);
    expect(lines.map((l) => l.text).join('')).toBe(text);
    assertGapless(lines, text);
  });

  it('hard-splits a long word embedded among short ones at the correct boundary', () => {
    const text = 'go Supercalifragilisticexpialidocious now';
    // Budget 2 is exactly "go"'s length, leaving no room for the following space (swallowed);
    // the long word then doesn't fit AT ALL on a fresh 2-wide line and is hard-split repeatedly.
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 2);
    expect(lines[0]?.text).toBe('go');
    // No non-whitespace character is lost, however individual spaces were distributed.
    expect(
      lines
        .map((l) => l.text)
        .join('')
        .replace(/\s+/g, ''),
    ).toBe(text.replace(/\s+/g, ''));
    assertGapless(lines, text);
  });

  it('counts graphemes, not UTF-16 code units: an astral emoji is one cell', () => {
    // U+1F600 GRINNING FACE is one grapheme but two UTF-16 code units.
    const emoji = '\u{1F600}';
    const text = emoji.repeat(12); // 12 graphemes, 24 UTF-16 code units
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 12);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(text);
    expect(lines[0]?.endOffset).toBe(text.length); // 24 UTF-16 units, not 12
  });

  it('counts a combining-mark sequence as a single grapheme cell', () => {
    // 'e' + COMBINING ACUTE ACCENT (U+0301) is one grapheme, two UTF-16 code units.
    const combining = 'é';
    const text = combining.repeat(13); // 13 graphemes; budget 12 forces a wrap
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 12);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe(combining.repeat(12));
    expect(lines[1]?.text).toBe(combining.repeat(1));
    assertGapless(lines, text);
  });

  it('fits text exactly at the measure onto one line', () => {
    const text = 'x'.repeat(60);
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 60);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(text);
  });

  it('wraps text one character over the measure (single long token hard-splits)', () => {
    const text = 'x'.repeat(61);
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 60);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('x'.repeat(60));
    expect(lines[1]?.text).toBe('x');
  });

  it('wraps a normal sentence one character over the measure at the word boundary', () => {
    // The first word exactly fills the 60-character budget, so the following space has no room
    // (60 + 1 > 60) and is swallowed; "abcde" starts a fresh second line.
    const text = `${'x'.repeat(60)} abcde`;
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 60);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('x'.repeat(60));
    expect(lines[1]?.text).toBe('abcde');
    assertGapless(lines, text);
  });

  it('produces exactly one empty line for empty text', () => {
    const lines = wrapBlockText(BLOCK_ID, 'action', '', 60);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: '', startOffset: 0, endOffset: 0 });
  });

  it('produces a single line for whitespace-only text without a spurious trailing empty line', () => {
    const text = '   ';
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 60);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(text);
    assertGapless(lines, text);
  });

  it('does not leave a spurious trailing empty line when trailing whitespace overflows the budget', () => {
    const text = 'hello   '; // "hello" (5) + 3 spaces = 8 graphemes; budget 6
    const lines = wrapBlockText(BLOCK_ID, 'action', text, 6);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('hello');
    assertGapless(lines, text); // endOffset still covers the swallowed trailing spaces
  });

  it('is deterministic across repeated runs on the same input', () => {
    const text = 'The quick brown fox jumps over the lazy dog, again and again and again.';
    const first = wrapBlockText(BLOCK_ID, 'action', text, 20);
    const second = wrapBlockText(BLOCK_ID, 'action', text, 20);
    expect(second).toEqual(first);
  });
});

describe('wrapBlock', () => {
  it('derives the character wrap budget as 38, from the 3.7 in indent to the 7.5 in right margin', () => {
    expect(CHARACTER_WRAP_BUDGET).toBe(38);
  });

  it('derives the transition wrap budget as 60, the full body width', () => {
    expect(TRANSITION_WRAP_BUDGET).toBe(60);
  });

  it('does not wrap a character cue within its 38-character budget', () => {
    const text = 'ADA (V.O.)';
    const lines = wrapBlock(BLOCK_ID, 'character', text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text, startOffset: 0, endOffset: text.length });
  });

  it('wraps a character cue that exceeds its 38-character budget, rather than letting it run off the page', () => {
    const text = 'A VERY LONG CHARACTER NAME WITH AN EXTENSION (V.O.) THAT EXCEEDS THE BUDGET';
    const lines = wrapBlock(BLOCK_ID, 'character', text);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.text.length).toBeLessThanOrEqual(CHARACTER_WRAP_BUDGET);
    }
    expect(
      lines
        .map((l) => l.text)
        .join(' ')
        .replace(/\s+/g, ' '),
    ).toBe(text.replace(/\s+/g, ' '));
  });

  it('does not wrap a transition within its 60-character budget', () => {
    const text = 'CUT TO:';
    const lines = wrapBlock(BLOCK_ID, 'transition', text);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(text);
  });

  it('wraps a transition that exceeds its 60-character budget, rather than letting it run off the page', () => {
    const text = 'x'.repeat(65);
    const lines = wrapBlock(BLOCK_ID, 'transition', text);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('x'.repeat(60));
    expect(lines[1]?.text).toBe('x'.repeat(5));
  });

  it('wraps dialogue at the 35-character budget', () => {
    const text = 'x'.repeat(36);
    const lines = wrapBlock(BLOCK_ID, 'dialogue', text);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('x'.repeat(35));
  });

  it('wraps parenthetical at the 20-character budget', () => {
    const text = 'x'.repeat(21);
    const lines = wrapBlock(BLOCK_ID, 'parenthetical', text);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('x'.repeat(20));
  });
});

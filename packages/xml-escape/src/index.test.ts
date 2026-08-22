import { describe, expect, it } from 'vitest';
import { escapeXmlText } from './index.js';

describe('escapeXmlText', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXmlText('<')).toBe('&lt;');
    expect(escapeXmlText('>')).toBe('&gt;');
    expect(escapeXmlText('&')).toBe('&amp;');
    expect(escapeXmlText('"')).toBe('&quot;');
    expect(escapeXmlText("'")).toBe('&apos;');
  });

  it('escapes a mix in running text without leaving any raw metacharacter behind', () => {
    const input = `She said "run" & didn't <stop>.`;
    const output = escapeXmlText(input);
    expect(output).toBe('She said &quot;run&quot; &amp; didn&apos;t &lt;stop&gt;.');
    // The strongest form of this assertion: none of the five raw characters survive escaping,
    // rather than merely checking that the expected escaped substrings are present (which a
    // no-op passthrough could also satisfy if the input happened to already contain them).
    expect(output).not.toMatch(/[<>"']|&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('escapes & before the other replacements, so a real entity is not double-escaped', () => {
    // A lone `&` sitting next to a real entity: naive escaping run in the wrong order (escaping
    // `<` etc. before `&`, or running the `&` replacement more than once) would turn the `&lt;`
    // that this input's own escaping produces into `&amp;lt;`.
    expect(escapeXmlText('&<')).toBe('&amp;&lt;');
    expect(escapeXmlText('&')).not.toBe('&amp;amp;');
  });

  it('leaves ]]> as literal escaped text, not a CDATA terminator', () => {
    // Not special in ordinary XML text (only inside a CDATA section, which neither consumer of
    // this helper ever emits), but escaping `>` here still renders it inert either way.
    expect(escapeXmlText(']]>')).toBe(']]&gt;');
  });

  it('escapes text that already looks like XML markup as inert text', () => {
    const input = '<Paragraph Type="Character"><Text>FAKE</Text></Paragraph>';
    const output = escapeXmlText(input);
    expect(output).toBe(
      '&lt;Paragraph Type=&quot;Character&quot;&gt;&lt;Text&gt;FAKE&lt;/Text&gt;&lt;/Paragraph&gt;',
    );
    expect(output).not.toContain('<Paragraph');
  });

  it('strips XML-invalid control characters while keeping tab, newline, and carriage return', () => {
    // NUL, BEL, and ESC are not valid XML 1.0 characters at all (section 2.2), escaped or not.
    expect(escapeXmlText('a\x00b\x07c\x1Bd')).toBe('abcd');
    expect(escapeXmlText('line one\nline two\ttabbed\rreturn')).toBe(
      'line one\nline two\ttabbed\rreturn',
    );
  });

  it('strips an unpaired surrogate but keeps a well-formed astral character', () => {
    expect(escapeXmlText('\uD800')).toBe('');
    expect(escapeXmlText('emoji: \u{1F3AC}')).toBe('emoji: \u{1F3AC}');
  });

  it('passes non-ASCII text through unchanged', () => {
    expect(escapeXmlText('café résumé')).toBe('café résumé');
    expect(escapeXmlText('日本語')).toBe('日本語');
  });

  it('leaves empty text unchanged', () => {
    expect(escapeXmlText('')).toBe('');
  });
});

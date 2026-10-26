import * as fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  childElements,
  directText,
  firstChildElement,
  FdxXmlError,
  MAX_FDX_ELEMENT_COUNT,
  MAX_FDX_ELEMENT_DEPTH,
  MAX_FDX_SOURCE_CHARACTERS,
  parseFdxXml,
  rejectDoctypeOrDtd,
} from './xmlParser.js';

describe('parseFdxXml: ordinary document shapes', () => {
  it('parses nested elements, attributes, and text content', () => {
    const root = parseFdxXml(
      '<FinalDraft Version="6"><Content><Paragraph Type="Action"><Text>Hello</Text></Paragraph></Content></FinalDraft>',
    );
    expect(root.tag).toBe('FinalDraft');
    expect(root.attrs.Version).toBe('6');
    const content = firstChildElement(root, 'Content')!;
    const paragraph = firstChildElement(content, 'Paragraph')!;
    expect(paragraph.attrs.Type).toBe('Action');
    const text = firstChildElement(paragraph, 'Text')!;
    expect(directText(text)).toBe('Hello');
  });

  it('parses self-closing elements with no children', () => {
    const root = parseFdxXml('<Root><Empty Type="Character" id="x"/></Root>');
    const empty = firstChildElement(root, 'Empty')!;
    expect(empty.children).toHaveLength(0);
    expect(empty.attrs.id).toBe('x');
  });

  it('decodes the five predefined entities and numeric character references', () => {
    const root = parseFdxXml('<Root>&amp;&lt;&gt;&quot;&apos; &#65;&#x42; &#x1F3AC;</Root>');
    expect(directText(root)).toBe(`&<>"' AB \u{1F3AC}`);
  });

  it('decodes entities inside attribute values', () => {
    const root = parseFdxXml(`<Root Number="1&amp;2"/>`);
    expect(root.attrs.Number).toBe('1&2');
  });

  it('accepts single- and double-quoted attribute values', () => {
    const root = parseFdxXml(`<Root a="x" b='y'/>`);
    expect(root.attrs.a).toBe('x');
    expect(root.attrs.b).toBe('y');
  });

  it('skips the XML declaration, comments, and processing instructions', () => {
    const root = parseFdxXml(
      '<?xml version="1.0" encoding="UTF-8"?><!-- a comment --><Root><!-- inner --><?pi data?><Child/></Root>',
    );
    expect(root.tag).toBe('Root');
    expect(childElements(root)).toHaveLength(1);
  });

  it('treats a CDATA section as literal text with no entity decoding inside it', () => {
    const root = parseFdxXml('<Root><![CDATA[<not-a-tag> & &amp;]]></Root>');
    expect(directText(root)).toBe('<not-a-tag> & &amp;');
  });

  it('parses the real FD13 reference fixture into a tree with no error', () => {
    const path = new URL('../fixtures/final-draft-13-reference.fdx', import.meta.url);
    const source = fs.readFileSync(path, 'utf8');
    const root = parseFdxXml(source);
    expect(root.tag).toBe('FinalDraft');
  });
});

describe('parseFdxXml: malformed input is rejected, not guessed at', () => {
  it('rejects a mismatched closing tag', () => {
    expect(() => parseFdxXml('<Root><a></b></Root>')).toThrow(FdxXmlError);
  });

  it('rejects an unterminated start tag', () => {
    expect(() => parseFdxXml('<Root><a')).toThrow(FdxXmlError);
  });

  it('rejects more than one root element', () => {
    expect(() => parseFdxXml('<Root/><Root/>')).toThrow(FdxXmlError);
  });

  it('rejects a document with no root element at all, as "not_xml"', () => {
    try {
      parseFdxXml('hello world, not xml at all');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxXmlError);
      expect((error as FdxXmlError).code).toBe('not_xml');
    }
  });

  it('rejects an empty document', () => {
    expect(() => parseFdxXml('')).toThrow(FdxXmlError);
  });

  it('rejects a duplicate attribute on the same element', () => {
    expect(() => parseFdxXml('<Root a="1" a="2"/>')).toThrow(/Duplicate attribute/);
  });

  it('rejects an attribute value with no quotes', () => {
    expect(() => parseFdxXml('<Root a=1/>')).toThrow(FdxXmlError);
  });

  it('rejects an unknown (non-predefined) entity reference, independent of the DOCTYPE guard', () => {
    // No DOCTYPE anywhere in this input -- this proves the tokenizer itself has no notion of a
    // custom entity, as defense in depth beyond `rejectDoctypeOrDtd`.
    try {
      parseFdxXml('<Root>&customEntity;</Root>');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxXmlError);
      expect((error as FdxXmlError).code).toBe('not_xml');
      expect((error as Error).message).toContain('Unknown entity reference');
    }
  });

  it('rejects an invalid numeric character reference', () => {
    expect(() => parseFdxXml('<Root>&#xFFFFFFFF;</Root>')).toThrow(FdxXmlError);
  });

  it('rejects an unterminated entity reference (no closing semicolon)', () => {
    expect(() => parseFdxXml('<Root>&amp</Root>')).toThrow(/Unterminated entity reference/);
  });

  it('rejects a markup declaration other than DOCTYPE/ENTITY as unsupported, as defense in depth', () => {
    // No DOCTYPE/ENTITY keyword here, so `rejectDoctypeOrDtd`'s pre-scan does not fire -- this
    // exercises the tokenizer's own fallback refusal of any other `<!...>` construct.
    expect(() => parseFdxXml('<Root><!ELEMENT foo ANY></Root>')).toThrow(
      /Unsupported markup declaration/,
    );
  });

  it('rejects an unterminated comment, CDATA section, and processing instruction', () => {
    expect(() => parseFdxXml('<Root><!-- never closed</Root>')).toThrow(FdxXmlError);
    expect(() => parseFdxXml('<Root><![CDATA[never closed</Root>')).toThrow(FdxXmlError);
    expect(() => parseFdxXml('<?xml never closed')).toThrow(FdxXmlError);
  });

  it('rejects non-whitespace text sitting outside the root element', () => {
    expect(() => parseFdxXml('stray<Root/>')).toThrow(FdxXmlError);
  });

  it('rejects an unclosed element at end of input', () => {
    expect(() => parseFdxXml('<Root><a>')).toThrow(FdxXmlError);
  });
});

describe('parseFdxXml: security guards', () => {
  it('rejects a DOCTYPE declaration before parsing, with a clear, specific error', () => {
    try {
      parseFdxXml('<?xml version="1.0"?><!DOCTYPE foo><foo/>');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxXmlError);
      expect((error as FdxXmlError).code).toBe('doctype_rejected');
      expect((error as Error).message).toContain('DOCTYPE');
    }
  });

  it('rejects a bare ENTITY declaration even with no surrounding DOCTYPE keyword', () => {
    try {
      parseFdxXml('<!ENTITY xxe "oops"><foo/>');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxXmlError);
      expect((error as FdxXmlError).code).toBe('doctype_rejected');
    }
  });

  it('rejects an XXE payload using a SYSTEM file:// external entity, never resolving it', () => {
    // `vi.spyOn(fs, 'readFileSync')` is not possible here -- Node's ESM module namespace for a
    // built-in is non-configurable, so Vitest cannot wrap it (confirmed: this throws "Cannot
    // redefine property" when attempted). `fetch` is a plain global, not a frozen module
    // namespace, so it remains spy-able and gives the same evidence for the network half of XXE;
    // the filesystem half of "never resolved" rests on `xmlParser.ts`'s own doc comment and the
    // fact that grepping this module's source for `readFile`/`require` finds nothing -- there is
    // no code path here that could read a file even if this guard were bypassed by a different
    // bug, which the "no DOCTYPE guard" mutation (see progress/fdx-import.md) confirms directly
    // by showing what *does* happen when this specific check is removed.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch must never be called while parsing FDX');
    });
    const payload =
      '<?xml version="1.0"?>\n' +
      '<!DOCTYPE foo [\n' +
      '  <!ENTITY xxe SYSTEM "file:///etc/passwd">\n' +
      ']>\n' +
      '<foo>&xxe;</foo>';
    let thrown: unknown;
    try {
      parseFdxXml(payload);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FdxXmlError);
    expect((thrown as FdxXmlError).code).toBe('doctype_rejected');
    expect((thrown as Error).message).not.toContain('root:');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects an XXE payload using a parameter entity, never resolving it', () => {
    const payload =
      '<!DOCTYPE foo [\n' +
      '  <!ENTITY % remote SYSTEM "file:///etc/passwd">\n' +
      '  %remote;\n' +
      ']>\n' +
      '<foo/>';
    try {
      parseFdxXml(payload);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxXmlError);
      expect((error as FdxXmlError).code).toBe('doctype_rejected');
    }
  });

  it('rejects a billion-laughs entity-expansion payload on the limit, not as an out-of-memory failure', () => {
    const lines = ['<!DOCTYPE lolz [', '<!ENTITY lol0 "lol">'];
    for (let level = 1; level <= 9; level += 1) {
      const previous = `lol${level - 1}`;
      lines.push(
        `<!ENTITY lol${level} "${Array.from({ length: 10 }, () => `&${previous};`).join('')}">`,
      );
    }
    lines.push(']>', '<lolz>&lol9;</lolz>');
    const payload = lines.join('\n');

    const start = performance.now();
    let thrown: unknown;
    try {
      parseFdxXml(payload);
    } catch (error) {
      thrown = error;
    }
    const elapsedMs = performance.now() - start;

    expect(thrown).toBeInstanceOf(FdxXmlError);
    expect((thrown as FdxXmlError).code).toBe('doctype_rejected');
    // Rejected on the cheap pre-parse scan, not after attempting any expansion -- this should
    // take single-digit milliseconds, not the seconds-to-minutes a real expansion would cost.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('bounds input size before parsing, rather than discovering the limit as an out-of-memory failure', () => {
    const oversized = 'a'.repeat(MAX_FDX_SOURCE_CHARACTERS + 1);
    try {
      parseFdxXml(oversized);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxXmlError);
      expect((error as FdxXmlError).code).toBe('too_large');
    }
  });

  it('accepts input exactly at the size limit', () => {
    // A budget is a ceiling, not an exclusive one -- mirrors check-bundle-budget.mjs's own
    // documented convention for its budgets.
    const atLimit = `<Root>${'a'.repeat(MAX_FDX_SOURCE_CHARACTERS - 13)}</Root>`;
    expect(atLimit.length).toBe(MAX_FDX_SOURCE_CHARACTERS);
    expect(() => parseFdxXml(atLimit)).not.toThrow();
  });

  it('bounds element nesting depth, failing as soon as the limit is exceeded rather than at the end of input', () => {
    const depth = MAX_FDX_ELEMENT_DEPTH + 5;
    const nested = '<r>'.repeat(depth) + '</r>'.repeat(depth);
    try {
      parseFdxXml(nested);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxXmlError);
      expect((error as Error).message).toContain('nesting depth');
    }
  });

  it('accepts nesting exactly at the depth limit', () => {
    const depth = MAX_FDX_ELEMENT_DEPTH;
    const nested = '<r>'.repeat(depth) + '</r>'.repeat(depth);
    expect(() => parseFdxXml(nested)).not.toThrow();
  });

  it('bounds total element count, rejecting a wide-but-shallow document', () => {
    const siblings = MAX_FDX_ELEMENT_COUNT + 5;
    const payload = `<Root>${'<a/>'.repeat(siblings)}</Root>`;
    try {
      parseFdxXml(payload);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FdxXmlError);
      expect((error as Error).message).toContain('element count');
    }
  });

  it('rejectDoctypeOrDtd is case-insensitive and matches anywhere in the source', () => {
    expect(() => rejectDoctypeOrDtd('prefix text <!doctype Foo> suffix')).toThrow(FdxXmlError);
    expect(() => rejectDoctypeOrDtd('<!EnTiTy foo "bar">')).toThrow(FdxXmlError);
    expect(() => rejectDoctypeOrDtd('<Root>no doctype here</Root>')).not.toThrow();
  });
});

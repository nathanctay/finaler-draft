/**
 * A minimal, hand-written XML parser scoped to exactly the subset of XML that a Final Draft
 * `.fdx` document uses, built for `packages/fdx`'s FDX-import slice (`plan.md`'s "Importing
 * untrusted files"). This is the security-critical choice this slice makes, so its reasoning is
 * recorded here rather than assumed.
 *
 * **Why a hand-written parser instead of a third-party XML library.** `packages/fdx` is
 * deliberately pure -- no DOM, no filesystem, no network (`index.ts`'s own doc comment) -- so it
 * can be unit-tested in Node and reused by a future server-side caller exactly as `screenplayToFdx`
 * already is. Reaching for a browser-only `DOMParser` would force an injected-parser seam just to
 * keep the package Node-testable, and reaching for an npm XML library would mean trusting that
 * library's own entity/DTD handling -- several have shipped XXE or entity-expansion CVEs that
 * required a non-default configuration flag to avoid, which is exactly the kind of "trust the
 * documentation" risk `plan.md` says this slice must not take ("assert its safety properties in a
 * test rather than trusting its documentation"). Writing a parser with no DOCTYPE, ENTITY, or
 * external-reference grammar *at all* makes those properties structural rather than configured:
 * there is no flag to misconfigure, because the vulnerable feature was never implemented. The
 * tradeoff this buys: full XML (namespaces, processing-instruction targets other than skipping,
 * exotic whitespace handling) is not supported, which is acceptable because the only input this
 * parser ever sees is a Final Draft document, not arbitrary XML.
 *
 * **What is deliberately unsupported, and why that is the security property, not a gap:**
 * - No `<!DOCTYPE` and no `<!ENTITY` (or any other markup declaration) -- rejected before this
 *   parser ever runs, see `rejectDoctypeOrDtd` in `import.ts`, and rejected a second time here
 *   (`<!` other than a comment or CDATA section fails to parse) as defense in depth if that
 *   pre-scan is ever bypassed or weakened.
 * - No custom entity references. Only the five predefined XML entities (`&amp; &lt; &gt; &quot;
 *   &apos;`) and numeric character references (`&#NN;`, `&#xHH;`) decode; anything else
 *   (`&whatever;`) is a parse error. Decoding is a single left-to-right pass over the *original*
 *   source that never re-scans its own output, so there is no recursive expansion to bound in the
 *   first place -- "billion laughs" has no grammar production to exploit here, independent of the
 *   DOCTYPE rejection.
 * - No network or filesystem access of any kind -- this module performs no I/O; it is a pure
 *   string-to-tree function. External entities (`SYSTEM`/`PUBLIC`) are not a feature this parser
 *   has, so there is nothing that could resolve one.
 */

/** Discriminated tree node this parser produces. No DOM type anywhere in this module. */
export type XmlNode =
  | {
      readonly kind: 'element';
      readonly tag: string;
      readonly attrs: Readonly<Record<string, string>>;
      readonly children: readonly XmlNode[];
    }
  | { readonly kind: 'text'; readonly value: string };

export type XmlElement = XmlNode & { readonly kind: 'element' };

export function isXmlElement(node: XmlNode): node is XmlElement {
  return node.kind === 'element';
}

/**
 * Every element child of `element`, in document order -- the thing nearly every caller in
 * `import.ts` wants, since FDX's meaningful structure (`Content`, `TitlePage`, paragraphs,
 * `DualDialogue`) is entirely element-nested; the stray whitespace text nodes XML allows between
 * tags are never semantically significant here.
 */
export function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter(isXmlElement);
}

/** The first child element with the given tag, or `undefined` if none exists. */
export function firstChildElement(element: XmlElement, tag: string): XmlElement | undefined {
  return childElements(element).find((child) => child.tag === tag);
}

/**
 * The concatenation of every direct text-node child's value, in document order. Final Draft never
 * mixes element and text children within a `<Text>` (confirmed against the reference fixture --
 * every `<Text>` element's only children are text nodes), so "concatenate the text children" is
 * exactly "the text this element carries," not an approximation.
 */
export function directText(element: XmlElement): string {
  return element.children
    .filter((child): child is XmlNode & { kind: 'text' } => child.kind === 'text')
    .map((child) => child.value)
    .join('');
}

export type FdxXmlErrorCode = 'too_large' | 'doctype_rejected' | 'not_xml';

export class FdxXmlError extends Error {
  constructor(
    readonly code: FdxXmlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FdxXmlError';
  }
}

/**
 * Input-size bound, enforced before a single character is tokenized (`plan.md`: "Bound... input
 * size before parsing. Reject the file on the limit rather than discovering it as an
 * out-of-memory failure"). 10,000,000 UTF-16 code units (~10-20MB on disk depending on how much
 * of the document is outside the ASCII range) was chosen against the one genuine reference this
 * package has: `final-draft-13-reference.fdx` is one page of body content plus Final Draft's
 * full metadata shell (macros, revision colors, character traits, SmartType lists, display
 * boards) and is already a representative *floor* for a real file's non-content overhead at
 * about 26KB. A feature-length (110-120 page) screenplay's `Content` adds a few hundred KB of
 * text at most -- screenplay pages are sparse, roughly 55 lines of up to 60 characters -- so even
 * a long script with the same metadata shell lands in the low hundreds of KB to a few MB. 10M
 * characters gives roughly two orders of magnitude of headroom over that, which is enough to admit
 * any real screenplay a writer could produce while still bounding worst-case memory for a hostile
 * upload to a fixed, small multiple of the limit itself (this parser never buffers more than a
 * handful of copies of the source: the raw string, and the tree it builds, which can only be
 * *smaller* than the source since there is no entity expansion to grow it).
 */
export const MAX_FDX_SOURCE_CHARACTERS = 10_000_000;

/**
 * Element-nesting-depth bound (`plan.md`: "Bound... nesting depth... before parsing"), enforced
 * incrementally as each open tag is pushed onto the parser's explicit stack -- never recursively,
 * so there is no call-stack depth to exhaust either. A genuine Final Draft document's deepest
 * nesting is shallow: the deepest path in the reference fixture is five elements
 * (`FinalDraft > DisplayBoards > DisplayBoard > Lanes > Lane`, or `FinalDraft > Content >
 * Paragraph > DualDialogue > Paragraph` for a dual-dialogue block's inner paragraphs). 100 gives
 * generous headroom for any real document shape while bounding the cost of a hostile
 * `<a><a><a>...` chain to a fixed, small amount of work rather than however deep an attacker cares
 * to nest.
 */
export const MAX_FDX_ELEMENT_DEPTH = 100;

/**
 * Total-element-count bound, defense in depth beyond the size and depth limits above: a document
 * could stay shallow and under the character budget while still containing an enormous number of
 * siblings (`<a/><a/><a/>...`), which costs real time and memory to tokenize and tree-build even
 * though no single guard above catches it. 200,000 is chosen with headroom over the reference
 * fixture's own element count (in the low hundreds) and well above what the `screenplaySchema`
 * boundary could ever accept afterward (`MAX_CANONICAL_NODES` is 25,000, and FDX's own
 * non-canonical scaffolding -- macros, actors, revision colors -- adds at most a few hundred more
 * elements in any real file), while still refusing a multi-hundred-thousand-sibling document
 * before the cost of building its tree is paid.
 */
export const MAX_FDX_ELEMENT_COUNT = 200_000;

const DOCTYPE_OR_DTD_PATTERN = /<!\s*(DOCTYPE|ENTITY)/i;

/**
 * The single string-level rule `plan.md` calls "stronger than configuring a parser": reject any
 * `DOCTYPE` or DTD construct before a single character is tokenized. No DOCTYPE means no internal
 * entity definitions (entity-expansion / "billion laughs" is impossible with nothing to define
 * entities) and no external entity (XXE) either, since that also requires a DOCTYPE. Checked
 * against the raw source with a simple substring/regex scan -- deliberately not deferred to the
 * tokenizer below, so this guard is a single, independently removable piece of code a mutation
 * test can target (see `import.test.ts`'s "security guards" suite), separate from whatever
 * incidental protection the tokenizer's own lack of DOCTYPE grammar would otherwise provide.
 */
export function rejectDoctypeOrDtd(source: string): void {
  const match = DOCTYPE_OR_DTD_PATTERN.exec(source);
  if (match) {
    throw new FdxXmlError(
      'doctype_rejected',
      `The file contains a "<!${match[1]}" declaration, which is not permitted. Final Draft ` +
        'does not write one, and accepting one would allow entity-expansion and external-entity ' +
        'attacks. Re-export the file from Final Draft and try again.',
    );
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeNumericCharacterReference(body: string, context: string): string {
  const isHex = body.startsWith('#x') || body.startsWith('#X');
  const digits = isHex ? body.slice(2) : body.slice(1);
  const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    digits.length === 0
  ) {
    throw new FdxXmlError(
      'not_xml',
      `Invalid numeric character reference "&${body};" in ${context}.`,
    );
  }
  // No try/catch needed here: the guard above already rejects every input value for which
  // `String.fromCodePoint` could throw (non-integer, negative, or beyond the last valid code
  // point), so by this point `codePoint` is always a value it accepts.
  return String.fromCodePoint(codePoint);
}

/**
 * Decodes XML entity references in one left-to-right pass over `raw`, the *original* source
 * slice -- never re-scanning any text this function itself produced. Only the five predefined XML
 * entities and numeric character references are recognized; any other `&name;` is a hard parse
 * error. This is what makes recursive entity expansion structurally impossible rather than merely
 * bounded: there is no notion of a user-defined entity anywhere in this module, so there is
 * nothing for a "billion laughs" payload to expand.
 */
function decodeEntities(raw: string, context: string): string {
  let out = '';
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char !== '&') {
      out += char;
      index += 1;
      continue;
    }
    const semicolon = raw.indexOf(';', index + 1);
    if (semicolon === -1) {
      throw new FdxXmlError('not_xml', `Unterminated entity reference in ${context}.`);
    }
    const body = raw.slice(index + 1, semicolon);
    if (body.startsWith('#')) {
      out += decodeNumericCharacterReference(body, context);
    } else if (Object.hasOwn(NAMED_ENTITIES, body)) {
      out += NAMED_ENTITIES[body];
    } else {
      throw new FdxXmlError(
        'not_xml',
        `Unknown entity reference "&${body};" in ${context}. Only the five predefined XML ` +
          'entities and numeric character references are supported; Final Draft does not write ' +
          'custom entities.',
      );
    }
    index = semicolon + 1;
  }
  return out;
}

const WHITESPACE_PATTERN = /\s/;
const NAME_TERMINATOR_PATTERN = /[\s/>]/;
const ATTR_NAME_TERMINATOR_PATTERN = /[\s=/>]/;

type OpenElement = { tag: string; attrs: Record<string, string>; children: XmlNode[] };

/**
 * Parses `source` into a single root `XmlElement`. Applies every bound documented on the
 * constants above, in order, before doing any real work: size, then the DOCTYPE/DTD rejection,
 * then element count and nesting depth incrementally as tokenizing proceeds. Throws `FdxXmlError`
 * (code `'not_xml'`) on any malformed input -- unterminated tags, mismatched close tags, stray
 * `<!` constructs other than comments and CDATA, more than one root element -- rather than
 * guessing at a recovery.
 */
export function parseFdxXml(source: string): XmlElement {
  if (source.length > MAX_FDX_SOURCE_CHARACTERS) {
    throw new FdxXmlError(
      'too_large',
      `The file is ${source.length.toLocaleString()} characters, which exceeds the ` +
        `${MAX_FDX_SOURCE_CHARACTERS.toLocaleString()}-character import limit. A feature-length ` +
        'screenplay is a few hundred kilobytes; this file is far larger than any real screenplay ' +
        'and was rejected before parsing.',
    );
  }
  rejectDoctypeOrDtd(source);

  const length = source.length;
  let pos = 0;
  let elementCount = 0;
  const stack: OpenElement[] = [];
  let root: XmlElement | undefined;

  function fail(message: string): never {
    throw new FdxXmlError('not_xml', `${message} (character offset ${pos}).`);
  }

  function skipWhitespace(): void {
    while (pos < length && WHITESPACE_PATTERN.test(source[pos]!)) pos += 1;
  }

  function appendNode(node: XmlNode): void {
    if (stack.length === 0) {
      if (node.kind === 'text') {
        if (node.value.trim().length > 0) fail('Unexpected text outside the root element');
        return;
      }
      if (root !== undefined) fail('A document may have only one root element');
      root = node;
      return;
    }
    stack[stack.length - 1]!.children.push(node);
  }

  while (pos < length) {
    if (source[pos] !== '<') {
      const nextLt = source.indexOf('<', pos);
      const textEnd = nextLt === -1 ? length : nextLt;
      const rawText = source.slice(pos, textEnd);
      pos = textEnd;
      if (rawText.length > 0) {
        const context =
          stack.length > 0 ? `text content of <${stack[stack.length - 1]!.tag}>` : 'document text';
        const decoded = decodeEntities(rawText, context);
        if (decoded.length > 0) appendNode({ kind: 'text', value: decoded });
      }
      continue;
    }

    if (source.startsWith('<?', pos)) {
      const end = source.indexOf('?>', pos + 2);
      if (end === -1) fail('Unterminated processing instruction');
      pos = end + 2;
      continue;
    }

    if (source.startsWith('<!--', pos)) {
      const end = source.indexOf('-->', pos + 4);
      if (end === -1) fail('Unterminated comment');
      pos = end + 3;
      continue;
    }

    if (source.startsWith('<![CDATA[', pos)) {
      const end = source.indexOf(']]>', pos + 9);
      if (end === -1) fail('Unterminated CDATA section');
      const value = source.slice(pos + 9, end);
      pos = end + 3;
      if (value.length > 0) appendNode({ kind: 'text', value });
      continue;
    }

    if (source.startsWith('<!', pos)) {
      // Defense in depth: `rejectDoctypeOrDtd` above already refuses `<!DOCTYPE` and `<!ENTITY`
      // anywhere in the source, but this also refuses every other markup-declaration shape
      // (`<!ELEMENT`, `<!ATTLIST`, `<!NOTATION`) rather than silently matching nothing and
      // falling through to a confusing downstream error.
      fail('Unsupported markup declaration');
    }

    if (source.startsWith('</', pos)) {
      const end = source.indexOf('>', pos + 2);
      if (end === -1) fail('Unterminated closing tag');
      const closeTag = source.slice(pos + 2, end).trim();
      pos = end + 1;
      const top = stack.pop();
      if (!top) fail(`Unexpected closing tag "</${closeTag}>" with no open element`);
      if (top.tag !== closeTag) {
        fail(`Mismatched closing tag: expected "</${top.tag}>", found "</${closeTag}>"`);
      }
      appendNode({ kind: 'element', tag: top.tag, attrs: top.attrs, children: top.children });
      continue;
    }

    // An opening or self-closing tag: "<Tag attr="value" ...>" or "<Tag attr="value" .../>".
    elementCount += 1;
    if (elementCount > MAX_FDX_ELEMENT_COUNT) {
      fail(`Exceeded the maximum element count (${MAX_FDX_ELEMENT_COUNT.toLocaleString()})`);
    }

    pos += 1; // consume '<'
    const tagStart = pos;
    while (pos < length && !NAME_TERMINATOR_PATTERN.test(source[pos]!)) pos += 1;
    const tag = source.slice(tagStart, pos);
    if (tag.length === 0) fail('Empty tag name');

    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      skipWhitespace();
      if (pos >= length) fail(`Unterminated start tag "<${tag}"`);
      if (source[pos] === '/' && source[pos + 1] === '>') {
        pos += 2;
        selfClosing = true;
        break;
      }
      if (source[pos] === '>') {
        pos += 1;
        break;
      }
      const nameStart = pos;
      while (pos < length && !ATTR_NAME_TERMINATOR_PATTERN.test(source[pos]!)) pos += 1;
      const name = source.slice(nameStart, pos);
      if (name.length === 0) fail(`Malformed attribute in "<${tag}>"`);
      skipWhitespace();
      if (source[pos] !== '=') fail(`Expected "=" after attribute name "${name}" in "<${tag}>"`);
      pos += 1;
      skipWhitespace();
      const quote = source[pos];
      if (quote !== '"' && quote !== "'") {
        fail(`Expected a quoted value for attribute "${name}" in "<${tag}>"`);
      }
      pos += 1;
      const valueStart = pos;
      const quoteEnd = source.indexOf(quote, valueStart);
      if (quoteEnd === -1) fail(`Unterminated value for attribute "${name}" in "<${tag}>"`);
      const rawValue = source.slice(valueStart, quoteEnd);
      pos = quoteEnd + 1;
      if (Object.hasOwn(attrs, name)) fail(`Duplicate attribute "${name}" in "<${tag}>"`);
      attrs[name] = decodeEntities(rawValue, `attribute "${name}" of <${tag}>`);
    }

    if (selfClosing) {
      appendNode({ kind: 'element', tag, attrs, children: [] });
    } else {
      if (stack.length >= MAX_FDX_ELEMENT_DEPTH) {
        fail(`Exceeded the maximum element nesting depth (${MAX_FDX_ELEMENT_DEPTH})`);
      }
      stack.push({ tag, attrs, children: [] });
    }
  }

  if (stack.length > 0) fail(`Unclosed element "<${stack[stack.length - 1]!.tag}>"`);
  if (root === undefined) fail('No root element found');
  return root;
}

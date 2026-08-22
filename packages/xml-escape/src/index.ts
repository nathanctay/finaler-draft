/**
 * The single audited XML-escaping helper shared by every exporter in this repository that emits
 * XML. Originally `packages/fdx/src/escape.ts`'s `escapeFdxText`, extracted here per
 * `progress/docx-export.md`: FDX and WordprocessingML (`.docx`) are both XML 1.0 documents with
 * identical escaping rules, so there is no format-specific reason for two copies to exist, and
 * "security-relevant code that exists twice is two things to audit and two things to drift"
 * (`progress/docx-export.md`, item 8). `packages/fdx` and `packages/docx` both import this rather
 * than defining their own -- there is no second escaping path anywhere in this repository to
 * audit or to fall out of sync with this one.
 *
 * Authored screenplay text is arbitrary user input that ends up in a file someone else's copy of
 * Final Draft or Word opens. Escapes all five XML metacharacters unconditionally, not only the
 * ones strictly required by context (element text technically only requires escaping `&` and
 * `<`; attribute values also need the surrounding quote character escaped). Escaping all five
 * everywhere means this one function is correct everywhere it's called -- FDX's `Text` content and
 * `Number` attribute, and DOCX's `<w:t>` run text -- with no second variant to keep in sync. This
 * matches the policy a production Final-Draft-compatible exporter uses for the same reason (Beat's
 * `escapeString`, github.com/lmparppei/Beat -- see progress/fdx-export.md for how the FDX mapping
 * was sourced).
 *
 * Also strips characters outside XML 1.0's valid-character ranges (`#x9 | #xA | #xD |
 * [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]`, XML 1.0 section 2.2). These characters
 * -- stray C0 control codes, unpaired surrogates -- have no representation in an XML document at
 * all, escaped or not: `packages/screenplay`'s authored-text schema does not reject them (see
 * progress/fdx-export.md's known-limitations note recommending that as a future, separate schema
 * change), so dropping them here is the only correct handling available to an exporter. This is a
 * deliberate, tested behavior -- see `index.test.ts` -- not an incidental side effect of the
 * regex below.
 */
const INVALID_XML_CHARACTERS = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

export function escapeXmlText(value: string): string {
  return (
    value
      .replace(INVALID_XML_CHARACTERS, '')
      .replace(/&/g, '&amp;') // Must run before the other replacements: none of them introduce a
      // literal `&`, but running this one later would double-escape the `&amp;` they'd have left.
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

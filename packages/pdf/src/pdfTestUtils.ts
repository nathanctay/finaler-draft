/**
 * Test infrastructure for parsing this package's own PDF output back into text, so tests can
 * assert "a known line lands on the page the layout model says it does" rather than merely that
 * bytes were produced -- `progress/pdf-export.md`'s explicit verification bar. Not part of the
 * package's public API and excluded from coverage (see vitest.config.ts).
 *
 * `pdf-lib` has no text-extraction API (it is a PDF *writer*, not a reader), so this decodes each
 * page's own content stream and regex-parses the text-showing operators directly -- a small,
 * bounded task because this package only ever emits what its own `painter.ts` writes: a single
 * un-embedded standard font, one `Tj`/`TJ` call per `drawText`, no images, no annotations, no
 * object streams. This is deliberately still "reload with pdf-lib" in spirit (the scope's own
 * suggestion) -- it uses `pdf-lib`'s public `PDFDocument.load`, `PDFArray`/`PDFRawStream` object
 * model, and `decodePDFRawStream`, not a byte-level PDF parser of this package's own.
 *
 * `PDFFont.encodeText` (see `encoding.ts`) returns a `PDFHexString`, so `drawText` emits hex
 * string literals (`<...>Tj`), not the parenthesized ASCII literals (`(...)Tj`) PDF also allows --
 * only the hex form is parsed here. Decoded as Latin-1: correct for every WinAnsiEncoding byte in
 * the ASCII range (0x20-0x7E), which is every fixture and every ordinary screenplay line this
 * package's own encoding boundary admits in the first place (see `encoding.ts`'s WinAnsi note) --
 * not a general WinAnsi-to-Unicode decoder, and not meant to be one.
 */
import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFPage,
} from 'pdf-lib';

function asRawStream(stream: PDFStream): PDFRawStream {
  // `PDFContext.lookup` has no `PDFRawStream`-typed overload (only the more general `PDFStream`),
  // even though a freshly `PDFDocument.load`-ed document's stream objects are always the raw,
  // undecoded form at this layer. Narrowed here, once, rather than casting at every call site.
  if (!(stream instanceof PDFRawStream)) {
    throw new Error(`Expected a PDFRawStream, got ${stream.constructor.name}.`);
  }
  return stream;
}

function resolveContentStreams(pdfDoc: PDFDocument, page: PDFPage): PDFRawStream[] {
  const contents = page.node.Contents();
  if (contents === undefined) {
    return [];
  }
  if (contents instanceof PDFArray) {
    const streams: PDFRawStream[] = [];
    for (let index = 0; index < contents.size(); index += 1) {
      streams.push(contents.lookup(index, PDFRawStream));
    }
    return streams;
  }
  if (contents instanceof PDFRawStream) {
    return [contents];
  }
  if (contents instanceof PDFRef) {
    return [asRawStream(pdfDoc.context.lookup(contents, PDFStream))];
  }
  throw new Error(`Unexpected Contents type on a parsed PDF page: ${contents.constructor.name}`);
}

function decodedContentString(pdfDoc: PDFDocument, page: PDFPage): string {
  const streams = resolveContentStreams(pdfDoc, page);
  return streams
    .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
    .join('\n');
}

const HEX_RUN_IN_ARRAY = /<([0-9A-Fa-f]*)>/g;

// One combined pattern, matched left to right in a single pass so runs come out in true document
// order regardless of which operator `pdf-lib` chose for a given call: group 1 is a `TJ` array's
// body (possibly several hex runs interleaved with numeric kerning adjustments), group 2 is a
// plain `Tj`/`'`/`"` call's single hex string. The two alternatives never overlap -- a `TJ`
// array's own `<hex>` runs are consumed as part of the first alternative, never re-matched by the
// second -- so this needs no separate blank-out pass.
const SHOW_TEXT_OPERATOR =
  /\[((?:<[0-9A-Fa-f]*>|-?\d+(?:\.\d+)?|\s)*)\]\s*TJ|<([0-9A-Fa-f]*)>\s*(?:Tj|'|")/g;

function hexToLatin1(hex: string): string {
  return Buffer.from(hex, 'hex').toString('latin1');
}

/**
 * Every string this package's own `painter.ts` drew on one page, in the order the content stream
 * shows them -- one entry per `drawText` call. `Tj`/`'`/`"` each show one hex string directly;
 * `TJ` shows an array possibly containing several (`pdf-lib` may split a single `drawText` call's
 * text across array entries around numeric kerning adjustments), so every hex run inside a `TJ`
 * array is treated as belonging to that one call and concatenated into a single entry -- matching
 * "one call, one string" regardless of which operator `pdf-lib` chose to emit.
 */
export function extractPageTextRuns(pdfDoc: PDFDocument, pageIndex: number): string[] {
  const page = pdfDoc.getPages()[pageIndex];
  if (page === undefined) {
    throw new Error(`No page at index ${pageIndex}; the document has ${pdfDoc.getPageCount()}.`);
  }
  const content = decodedContentString(pdfDoc, page);
  const runs: string[] = [];

  for (const match of content.matchAll(SHOW_TEXT_OPERATOR)) {
    const arrayBody = match[1];
    if (arrayBody !== undefined) {
      const hexRuns = Array.from(arrayBody.matchAll(HEX_RUN_IN_ARRAY), (m) => m[1] ?? '');
      runs.push(hexRuns.map(hexToLatin1).join(''));
    } else {
      runs.push(hexToLatin1(match[2] ?? ''));
    }
  }

  return runs;
}

/** All text runs on one page, joined with a space -- for a simple `toContain` assertion. */
export function extractPageText(pdfDoc: PDFDocument, pageIndex: number): string {
  return extractPageTextRuns(pdfDoc, pageIndex).join(' ');
}

export type PositionedRun = { readonly text: string; readonly x: number; readonly y: number };

// Confirmed empirically (not merely inferred from the spec) against this package's own painter:
// every `drawText` call `painter.ts` makes -- no special options, no word-wrapping -- produces
// its own `q BT ... 1 0 0 1 x y Tm <hex> Tj T* ET Q` block, one call per block, the position
// always the text matrix's translation component (the fifth and sixth numbers). This is a
// narrower, more exact pattern than `SHOW_TEXT_OPERATOR` above (it does not attempt to handle a
// `TJ` array, which this package's own output never produces) -- used only where a test needs the
// position `painter.ts` actually chose, not merely the text, so a mutation that draws correct
// text at the wrong coordinate is still caught.
const POSITIONED_SHOW_TEXT =
  /[\d.+-]+ [\d.+-]+ [\d.+-]+ [\d.+-]+ ([\d.+-]+) ([\d.+-]+) Tm\s*<([0-9A-Fa-f]*)>\s*Tj/g;

export function extractPageRuns(pdfDoc: PDFDocument, pageIndex: number): PositionedRun[] {
  const page = pdfDoc.getPages()[pageIndex];
  if (page === undefined) {
    throw new Error(`No page at index ${pageIndex}; the document has ${pdfDoc.getPageCount()}.`);
  }
  const content = decodedContentString(pdfDoc, page);
  return Array.from(content.matchAll(POSITIONED_SHOW_TEXT), (match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
    text: hexToLatin1(match[3] ?? ''),
  }));
}

/** Loads this package's own output back with `pdf-lib`, per the scope's own suggested check. */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes);
}

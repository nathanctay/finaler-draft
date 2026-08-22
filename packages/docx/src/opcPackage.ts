import { strToU8, zipSync } from 'fflate';

/**
 * The five OPC parts a WordprocessingML package needs to be a valid `.docx` -- content types,
 * the package's own root relationships, the document part, the document part's own relationships,
 * and styles -- per `progress/docx-export.md` item 3: "Emit the minimal set of parts that makes a
 * valid document... include in full; do not include parts Word merely happens to write." No
 * `docProps/core.xml`/`app.xml` (metadata Word writes but does not require to open a file), no
 * theme/font-table/settings parts, no headers or footers -- none of them are required by the Open
 * Packaging Conventions (ECMA-376 Part 2) or by WordprocessingML itself for a document to open.
 *
 * Content type strings and relationship type URIs below are the values every real `.docx`
 * producer emits (independently confirmed via the MS-OE376 interoperability notes and multiple
 * ECMA-376 secondary mirrors during this package's checkpoint-1 research); this package has no
 * genuine Word-saved file to diff them against the way `packages/fdx` has its FD13 reference, so
 * this progress entry states that plainly as a limitation rather than a confirmed fact.
 */
const CONTENT_TYPES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n` +
  `  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n` +
  `  <Default Extension="xml" ContentType="application/xml"/>\n` +
  `  <Override PartName="/word/document.xml"` +
  ` ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n` +
  `  <Override PartName="/word/styles.xml"` +
  ` ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>\n` +
  `</Types>\n`;

const ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
  `  <Relationship Id="rId1"` +
  ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"` +
  ` Target="word/document.xml"/>\n` +
  `</Relationships>\n`;

const DOCUMENT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
  `  <Relationship Id="rId1"` +
  ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"` +
  ` Target="styles.xml"/>\n` +
  `</Relationships>\n`;

/**
 * The zip's per-file modification time, fixed rather than defaulted to the current time.
 * `fflate.zipSync` stamps every entry's `mtime` at call time unless told otherwise (confirmed
 * directly from `fflate`'s own README, github.com/101arrowz/fflate, whose own top-level example
 * passes an identical fixed date as a global option for the identical reason) -- an unfixed
 * timestamp would make `screenplayToDocx` non-deterministic while looking pure, which defeats the
 * entire reason this function (like `screenplayToFdx`) is pure in the first place: a future
 * server-side export of a *historical revision* needs the same screenplay to always produce
 * byte-identical output, not output that merely looks the same. `1980-01-01` is the DOS
 * timestamp format's own minimum representable date and the same year `fflate`'s README uses in
 * its example -- an unambiguous, well-precedented choice rather than an arbitrary one.
 *
 * Noon UTC, not midnight: `fflate` encodes the DOS date/time from the `Date`'s *local* calendar
 * fields and rejects a year outside 1980-2099 (confirmed empirically -- midnight UTC on
 * 1980-01-01 throws "date not in range 1980-2099" in any timezone west of UTC, where the local
 * calendar date rolls back into 1979). Noon UTC stays within 1980 in every real-world UTC offset
 * (-12 through +14), so the exact moment is timezone-independent -- important because this
 * package's output must be identical no matter where `screenplayToDocx` runs.
 */
const DETERMINISTIC_ZIP_MTIME = new Date(Date.UTC(1980, 0, 1, 12, 0, 0));

/**
 * Zips the five OPC parts into a `.docx` archive. `fflate` (0.8.3) is approved for zipping only
 * (`progress/docx-export.md`) -- every byte of every XML part above and in `documentXml.ts`/
 * `styles.ts` is hand-built; this function's only job is packing already-complete XML strings
 * into a ZIP container, the one piece of this format this package does not write by hand because
 * hand-rolling ZIP central directories and CRC32 would be a worse risk than one small,
 * dependency-free library doing exactly that and nothing else.
 */
export function buildDocxPackage(documentXml: string, stylesXml: string): Uint8Array {
  return zipSync(
    // Flat paths, not nested objects: `fflate` writes an explicit directory entry (e.g. `word/`)
    // for every object level in a nested `Zippable`, confirmed empirically during this package's
    // development -- entries this format has no use for and that would contradict "exactly the
    // minimal set of parts" (`progress/docx-export.md` item 3). A flat key already containing the
    // full slash-separated path produces only the five real parts.
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES_XML),
      '_rels/.rels': strToU8(ROOT_RELS_XML),
      'word/document.xml': strToU8(documentXml),
      'word/styles.xml': strToU8(stylesXml),
      'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELS_XML),
    },
    { mtime: DETERMINISTIC_ZIP_MTIME },
  );
}

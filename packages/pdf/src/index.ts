import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Screenplay } from '@finaler-draft/screenplay';
import { paginateScreenplay } from '@finaler-draft/layout';
import { paintBodyPages, paintTitlePage } from './painter.js';

export { computeSceneNumberLabels } from './sceneNumbers.js';
export { formatPageNumber } from './pageNumberFormat.js';

/**
 * Serializes a canonical `Screenplay` (`packages/screenplay`) to PDF bytes, painting
 * `packages/layout`'s precomputed page-and-line model directly rather than re-deriving layout --
 * see `progress/pdf-export.md` for why headless Chromium (plan.md's originally specified
 * approach) was dropped in favour of this. Pure by design, the same contract
 * `screenplayToFdx`/`screenplayToDocx` hold and for the same reason: the same function must later
 * serve a server-side export of a historical revision. Determinism is asserted directly in
 * `index.test.ts` (serialize twice, require identical bytes) rather than assumed.
 *
 * **Deliberately `async`, unlike its FDX/DOCX siblings.** `pdf-lib`'s entire document API --
 * `PDFDocument.create`, `embedFont`, and `save` -- returns a `Promise` even for this package's
 * zero-I/O, standard-font-only usage; there is no synchronous path through the library this
 * scope approved (`progress/pdf-export.md` item 2 rejects hand-rolling PDF bytes directly, which
 * is the only way to stay synchronous). Flagged explicitly at checkpoint 2: this package's scope
 * document states a synchronous return type, and this is the one place the actual signature had
 * to diverge from it. Every other property "pure" is meant to guarantee here -- determinism, no
 * I/O, no randomness, no reads of the system clock -- still holds for a function that merely
 * returns a `Promise`; see `DETERMINISTIC_CREATE_OPTIONS` below for the one genuine
 * time-dependency `pdf-lib` has and how it is neutralized.
 */
export async function screenplayToPdf(screenplay: Screenplay): Promise<Uint8Array> {
  const layout = paginateScreenplay(screenplay.blocks, screenplay.documentSettings);

  const pdfDoc = await PDFDocument.create(DETERMINISTIC_CREATE_OPTIONS);

  // Embedding is isolated to this one call so that swapping in an embedded Courier Prime later
  // (the owner's stated next step for this format, once export moves server-side) touches one
  // line, not every draw site -- the "keep the typeface a parameter, not an assumption" note from
  // this package's checkpoint-1 design.
  const font = await pdfDoc.embedFont(StandardFonts.Courier);

  paintTitlePage(pdfDoc, font, screenplay);
  paintBodyPages(pdfDoc, font, layout, screenplay);

  return pdfDoc.save();
}

/**
 * `PDFDocument.create()` defaults to `updateMetadata: true`, which stamps the PDF's Info
 * dictionary with `ModificationDate` (and `CreationDate`, if unset) from `new Date()` --
 * confirmed directly in `pdf-lib`'s own source (`PDFDocument.prototype.updateInfoDict`), not
 * inferred from its typings. Left as the default, this function would read the system clock on
 * every call, which breaks the determinism this package must guarantee (the same failure class
 * `packages/docx`'s `DETERMINISTIC_ZIP_MTIME` exists to prevent for its own ZIP container, see
 * `progress/docx-export.md`). `updateMetadata: false` skips that call entirely rather than
 * substituting a fixed date: a PDF with no `Producer`/`Creator`/`CreationDate`/`ModDate` is fully
 * valid, and omitting them avoids picking an arbitrary constant date that would need its own
 * justification. (`pdf-lib`'s object-ID and resource-name allocation, the other place a naive PDF
 * writer might introduce nondeterminism, is already seeded rather than random --
 * `PDFContext`'s `SimpleRNG.withSeed(1)` -- so it needed no override here; verified empirically by
 * `index.test.ts`'s own byte-identity assertion, not merely by reading the source.)
 */
const DETERMINISTIC_CREATE_OPTIONS = { updateMetadata: false };

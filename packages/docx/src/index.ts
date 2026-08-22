import type { Screenplay } from '@finaler-draft/screenplay';
import { renderDocumentXml } from './documentXml.js';
import { buildDocxPackage } from './opcPackage.js';
import { renderStylesXml } from './styles.js';

export { renderDocumentXml } from './documentXml.js';
export { renderStylesXml } from './styles.js';
export { halfPointsFromPoints, twipsFromInches } from './units.js';

/**
 * Serializes a canonical `Screenplay` (`packages/screenplay`) to a `.docx` (OOXML WordprocessingML)
 * package. Pure by design -- no DOM, filesystem, network, or server -- per this package's scope
 * (`progress/docx-export.md`, mirroring `packages/fdx`'s identical reasoning): the same function
 * must later serve a server-side export of a historical revision, so building it pure now means
 * that later slice adds a caller rather than a rewrite. Purity here also means deterministic
 * bytes, not just a DOM-free call signature -- see `opcPackage.ts`'s `DETERMINISTIC_ZIP_MTIME` for
 * why the ZIP container itself needed a fixed timestamp to actually satisfy that.
 *
 * Takes **canonical** input, not editor input, exactly like `screenplayToFdx`: every canonical
 * block type is handled explicitly (`documentXml.ts`'s `renderBody` `switch` is exhaustive over
 * `ScreenplayBlock`'s discriminated union; its `default` branch throws rather than silently
 * skipping a block type the schema grows before this package is updated), and `dual_dialogue`,
 * `page_break`, and more than one title page -- all of which the editor refuses but the canonical
 * schema allows -- are handled rather than assumed unreachable.
 *
 * Annotations are never read: `screenplay.annotations` does not appear anywhere in this call
 * graph, not filtered out but simply untouched, per plan.md's "must never enter PDF, DOCX, or FDX
 * screenplay flow by accident."
 *
 * Built from the OOXML specification (ECMA-376 / ISO/IEC 29500), not from a genuine Word-saved
 * reference file -- unlike `packages/fdx`, which was rebuilt against a real Final Draft 13 file
 * after its first, third-party-sourced version was rejected outright. OOXML's public
 * specification makes a spec-first approach legitimate here in a way it was not for FDX (see
 * `progress/docx-export.md`'s "Read the FDX slice's log first" section); every structural
 * decision this package makes cites the specification clause it comes from in `progress/docx-
 * export.md`, not "every example does it this way." The owner opening this file in Word is still
 * the real acceptance test this package's own tests cannot substitute for.
 */
export function screenplayToDocx(screenplay: Screenplay): Uint8Array {
  const documentXml = renderDocumentXml(screenplay);
  const stylesXml = renderStylesXml(screenplay.documentSettings);
  return buildDocxPackage(documentXml, stylesXml);
}

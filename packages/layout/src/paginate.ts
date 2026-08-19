import {
  DEFAULT_DOCUMENT_SETTINGS,
  type DocumentSettings,
  type ScreenplayBlock,
} from '@finaler-draft/screenplay';
import type { LayoutResult } from './model.js';
import { buildGroups } from './groups.js';
import { layoutGroups } from './pageBreak.js';

/**
 * Paginates a canonical screenplay's blocks into a deterministic page-and-line model — see
 * `model.ts` for the output shape. Pure: no DOM, no Canvas, no browser API, no I/O, no `Date`, no
 * randomness, and the same input always produces a byte-identical result (for a fixed
 * `documentSettings` — see below).
 *
 * Takes `blocks` directly rather than a whole `Screenplay`, because this slice never reads
 * `titlePages`, `annotations`, `id`, `title`, or `schemaVersion` — title pages never paginate
 * with the body and are not counted, and a signature that accepted an object and silently
 * ignored most of it would misdescribe what the function does. `documentSettings` is threaded
 * through separately for the same reason: it is not part of the block sequence, and defaults to
 * the specification's current fixed values, so every existing caller keeps producing identical
 * output unchanged.
 *
 * Throws `UnsupportedBlockError` if `blocks` contains a `dual_dialogue` block: its column
 * geometry is unsettled in plan.md, and this engine refuses to guess at layout rather than
 * silently producing a plausible-looking but wrong page count.
 */
export function paginateScreenplay(
  blocks: readonly ScreenplayBlock[],
  documentSettings: DocumentSettings = DEFAULT_DOCUMENT_SETTINGS,
): LayoutResult {
  const groups = buildGroups(blocks, documentSettings);
  return layoutGroups(groups, documentSettings);
}

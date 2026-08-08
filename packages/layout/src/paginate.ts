import type { ScreenplayBlock } from '@finaler-draft/screenplay';
import type { LayoutResult } from './model.js';
import { buildGroups } from './groups.js';
import { layoutGroups } from './pageBreak.js';

/**
 * Paginates a canonical screenplay's blocks into a deterministic page-and-line model — see
 * `model.ts` for the output shape. Pure: no DOM, no Canvas, no browser API, no I/O, no `Date`, no
 * randomness, and the same input always produces a byte-identical result.
 *
 * Takes `blocks` directly rather than a whole `Screenplay`, because this slice never reads
 * `titlePages`, `annotations`, `id`, `title`, or `schemaVersion` — title pages never paginate
 * with the body and are not counted, and a signature that accepted an object and silently
 * ignored most of it would misdescribe what the function does.
 *
 * Throws `UnsupportedBlockError` if `blocks` contains a `dual_dialogue` block: its column
 * geometry is unsettled in plan.md, and this engine refuses to guess at layout rather than
 * silently producing a plausible-looking but wrong page count.
 */
export function paginateScreenplay(blocks: readonly ScreenplayBlock[]): LayoutResult {
  const groups = buildGroups(blocks);
  return layoutGroups(groups);
}

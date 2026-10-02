import { deriveScenes } from './index.js';
import type { Screenplay, ScreenplayBlock } from './index.js';

/**
 * Collaboration slice 4a's "major structural change" trigger (plan.md's "Collaboration, history,
 * and restoration"): a revision creation trigger measurable purely from two canonical projections,
 * not a vibe. Lives here, in `@finaler-draft/screenplay`, rather than in `apps/collab` (the only
 * place that decides *whether* to create a revision from it) because `apps/api`'s own named/export
 * revision creation needs the identical block/scene counting for `previewMetadata`
 * (`computeRevisionPreviewMetadata` below) -- one definition of "how many blocks/scenes does this
 * screenplay have," not two that could quietly drift apart between the two processes that write
 * `document_revisions`.
 */

/**
 * Any scene added or removed counts as structural on its own, with no proportion involved.
 * plan.md's own wording lists "scenes added or removed" as a condition in its own right, distinct
 * from "some proportion of blocks changed" -- and a screenplay's scene list is its skeleton: adding
 * or cutting even one scene changes what the document *is*, in a way no amount of line-editing
 * within existing scenes does. `1` is not a tuned threshold; it is the literal reading of "added or
 * removed."
 */
export const STRUCTURAL_CHANGE_MIN_SCENE_DELTA = 1;

/**
 * The proportion of a screenplay's blocks (by stable id, across scene headings, action, dialogue,
 * and every other element kind, dual-dialogue columns flattened into their constituent blocks) that
 * must have been added, removed, or edited since the last revision before that alone -- with no
 * scene added or removed -- counts as a major structural change.
 *
 * **Why 25%, not a smaller or larger number.** An ordinary editing session -- polishing a line of
 * dialogue, tightening one action paragraph, fixing a typo -- touches a handful of blocks: at full
 * feature length (`MAX_ROOT_BLOCKS` allows up to 10,000, and a typical 110-page screenplay runs
 * somewhere in the hundreds to low thousands once dialogue and action are both counted as
 * individual blocks), a few edited blocks is already comfortably under 5% of the total, usually
 * closer to a fraction of a percent for a single sitting's worth of polish. A quarter of the
 * document changing in one debounced save cycle is a different kind of event entirely -- a large
 * paste (an imported act, a scene reordering that regenerates many block ids), a broad rewrite pass
 * across a whole sequence, or restructuring dialogue voice throughout a scene -- exactly the kind of
 * change a writer would want a checkpoint recorded for before continuing. 25% sits with comfortable
 * margin above what routine editing ever produces and comfortably below "the whole document was
 * retyped" (100%), so it triggers reliably on genuine large-scale rewrites without tripping on
 * ordinary polish.
 */
export const STRUCTURAL_CHANGE_BLOCK_RATIO_THRESHOLD = 0.25;

export interface StructuralChangeMeasure {
  sceneCountBefore: number;
  sceneCountAfter: number;
  /** Absolute value: a scene removed counts exactly the same as a scene added for triggering a
   * revision -- either way, the document's shape changed. */
  sceneCountDelta: number;
  /** 0 to 1: the fraction of the union of both projections' block ids that were added, removed, or
   * had their content change. */
  blockChangeRatio: number;
  isMajor: boolean;
}

/**
 * Root-level blocks with `dual_dialogue` expanded into its own `left`/`right` column blocks, so a
 * dual-dialogue exchange is counted the same way as the same lines would be if they were not
 * paired -- one block per line of dialogue, not one opaque unit regardless of how much of it
 * changed. `page_break` has no nested content and passes through unchanged.
 */
function flattenScreenplayBlocks(blocks: readonly ScreenplayBlock[]): ScreenplayBlock[] {
  const flat: ScreenplayBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'dual_dialogue') {
      flat.push(...block.left.blocks, ...block.right.blocks);
    } else {
      flat.push(block);
    }
  }
  return flat;
}

/**
 * A content fingerprint for one (already-flattened) block -- two blocks with the same `id` compare
 * equal here exactly when nothing about them that a reader would notice has changed. Exhaustive
 * over every post-flatten block kind; `dual_dialogue` cannot reach this function (flattened away by
 * `flattenScreenplayBlocks` before this is ever called), so its branch exists only so this function
 * stays total over `ScreenplayBlock`, not partial.
 */
function blockSignature(block: ScreenplayBlock): string {
  switch (block.type) {
    case 'page_break':
      return 'page_break';
    case 'scene_heading':
      return `scene_heading:${block.sceneNumber ?? ''}:${block.text}`;
    case 'dual_dialogue':
      return `dual_dialogue:${block.id}`;
    default:
      return `${block.type}:${block.text}`;
  }
}

/**
 * Compares two canonical projections and reports whether the change between them counts as
 * "major" per this module's own two thresholds above. `before` is `undefined` for a screenplay's
 * very first structural measurement (no revision exists yet to compare against) -- treated as an
 * empty screenplay (zero scenes, zero blocks), so the first time any real content exists, it always
 * measures as structural (any scene at all is a scene "added" relative to none) and a screenplay
 * therefore always ends up with at least one revision once it has any content, with no separate
 * "genesis" trigger needed.
 */
export function measureStructuralChange(
  before: Pick<Screenplay, 'blocks'> | undefined,
  after: Pick<Screenplay, 'blocks'>,
): StructuralChangeMeasure {
  const beforeBlocks = before ? flattenScreenplayBlocks(before.blocks) : [];
  const afterBlocks = flattenScreenplayBlocks(after.blocks);

  const sceneCountBefore = before ? deriveScenes(before.blocks).length : 0;
  const sceneCountAfter = deriveScenes(after.blocks).length;
  const sceneCountDelta = Math.abs(sceneCountAfter - sceneCountBefore);

  const beforeById = new Map(beforeBlocks.map((block) => [block.id, blockSignature(block)]));
  const afterById = new Map(afterBlocks.map((block) => [block.id, blockSignature(block)]));

  let changed = 0;
  for (const [id, signature] of afterById) {
    if (beforeById.get(id) !== signature) changed++;
  }
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) changed++;
  }
  const unionSize = new Set([...beforeById.keys(), ...afterById.keys()]).size;
  const blockChangeRatio = unionSize === 0 ? 0 : changed / unionSize;

  return {
    sceneCountBefore,
    sceneCountAfter,
    sceneCountDelta,
    blockChangeRatio,
    isMajor:
      sceneCountDelta >= STRUCTURAL_CHANGE_MIN_SCENE_DELTA ||
      blockChangeRatio >= STRUCTURAL_CHANGE_BLOCK_RATIO_THRESHOLD,
  };
}

export interface RevisionPreviewMetadata {
  sceneCount: number;
  blockCount: number;
}

/** The small, denormalized summary `document_revisions.preview_metadata` stores -- see that
 * column's own comment in `packages/database/src/schema.ts`. Shared by every revision writer
 * (`apps/collab/src/revisions.ts` for automatic revisions, `apps/api/src/revisions.ts` for
 * named/export ones) so a revision list never shows a block count computed two different ways
 * depending on which process happened to write the row. */
export function computeRevisionPreviewMetadata(
  screenplay: Pick<Screenplay, 'blocks'>,
): RevisionPreviewMetadata {
  return {
    sceneCount: deriveScenes(screenplay.blocks).length,
    blockCount: flattenScreenplayBlocks(screenplay.blocks).length,
  };
}

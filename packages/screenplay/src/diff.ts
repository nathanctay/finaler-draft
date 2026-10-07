import { deriveScenes, flattenScreenplayBlocks, blockSignature } from './index.js';
import type { DocumentSettings, Screenplay, ScreenplayBlock, TitlePage } from './index.js';

/**
 * Collaboration slice 4b's screenplay-aware diff: a pure function comparing two canonical
 * projections -- any two revisions, or a revision against the live document (`plan.md`'s restore
 * flow, step 1: "An authorized owner/editor previews a screenplay-aware diff and confirms the
 * target revision" -- both sides of that comparison are ordinary `Screenplay` values, so nothing
 * here special-cases "the live one"). Reuses `revisions.ts`'s `flattenScreenplayBlocks` and
 * `blockSignature` -- the identical dual-dialogue flattening and per-block fingerprint
 * `measureStructuralChange` already established -- rather than a second, independently-written
 * notion of "what counts as one block" or "what counts as changed."
 *
 * **Why this is not a text diff.** `plan.md`'s stable scene and block IDs exist specifically so
 * that "revision diffs... keep working even when content is reordered" -- a line-based text diff
 * reports a move as a deletion plus an unrelated insertion, which is the wrong answer for a writer
 * asking what changed in their script. Every comparison below is keyed by stable id, never by
 * position or text content, so a block (or a whole scene) that moved is reported as having moved,
 * not as having been deleted and a coincidentally similar one added elsewhere.
 *
 * **Complexity.** Every step here (flattening, map construction, the LIS-based move detector,
 * scene derivation and grouping) is linear or `O(n log n)` in the total number of flattened blocks
 * across both screenplays. There is no step that is quadratic in block count. `diff.performance.
 * test.ts` exercises a fixture near `MAX_ROOT_BLOCKS` (10,000) to confirm this holds in practice,
 * not just in the asymptotic reasoning above.
 */

/**
 * Finds one longest strictly-increasing subsequence of `values`, returned as the subsequence's
 * indices into `values`, in ascending order. Standard patience-sorting construction: `tails[k]`
 * holds the index (into `values`) of the smallest possible tail value for an increasing
 * subsequence of length `k + 1` found so far, kept sorted by value so each new element's placement
 * is a binary search; `predecessors` reconstructs one actual subsequence by walking backward from
 * wherever the longest run ended. `O(n log n)`, not `O(n^2)` -- the only property this function's
 * own correctness depends on for this module to hold its stated complexity at feature length.
 */
function longestIncreasingSubsequenceIndices(values: readonly number[]): number[] {
  const tails: number[] = [];
  const predecessors: number[] = new Array(values.length).fill(-1);

  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    // Binary search for the first tail whose value is >= value (strictly increasing, so a tie
    // replaces rather than extends).
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) predecessors[i] = tails[lo - 1]!;
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }

  const result: number[] = [];
  let cursor = tails.length > 0 ? tails[tails.length - 1]! : -1;
  while (cursor !== -1) {
    result.push(cursor);
    cursor = predecessors[cursor]!;
  }
  return result.reverse();
}

/**
 * The move-detection primitive every move-aware comparison in this module is built on (block-level
 * and scene-level both call this, rather than each having its own copy of the same idea).
 *
 * Given the ids common to both sequences, in before-order, and each one's position in the after
 * sequence: the longest increasing subsequence (by after-position) of that before-ordered list is
 * the largest possible subset of common ids whose *relative* order is identical in both sequences
 * -- the maximal "nothing here moved relative to anything else in this set" backbone. Every common
 * id excluded from that backbone is reported as moved. This is the minimal-reordering explanation,
 * not "did this item's position change since the exact same index" (which would flag nearly
 * everything after a single insertion near the start) -- inserting one new scene at the front
 * moves nothing by this definition, because every existing scene's order relative to every other
 * existing scene is unchanged.
 */
function computeMovedIds(
  commonIdsInBeforeOrder: readonly string[],
  afterPositionById: ReadonlyMap<string, number>,
): ReadonlySet<string> {
  const afterPositions = commonIdsInBeforeOrder.map((id) => afterPositionById.get(id)!);
  const backboneIndices = longestIncreasingSubsequenceIndices(afterPositions);
  const backbone = new Set(backboneIndices.map((index) => commonIdsInBeforeOrder[index]!));
  const moved = new Set<string>();
  for (const id of commonIdsInBeforeOrder) {
    if (!backbone.has(id)) moved.add(id);
  }
  return moved;
}

export type IdentifiedDiffStatus = 'added' | 'removed' | 'matched';

/** One entry in a move-aware diff of an ordered, id-keyed sequence -- the generic shape both the
 * block-level and title-page diffs below are built from. `status: 'matched'` covers every id
 * present on both sides, whether or not it changed or moved; `changed`/`moved` are what actually
 * say so. A `'matched'` entry with `moved: false` and `changed: false` is, by definition, entirely
 * unaffected -- callers that only want "what's interesting" filter on that. */
export interface IdentifiedDiffEntry<T> {
  id: string;
  status: IdentifiedDiffStatus;
  /** `true` when this id exists on both sides but its position changed relative to the stable
   * backbone of everything that did not move -- see `computeMovedIds`'s own comment. Always
   * `false` for `'added'`/`'removed'`. */
  moved: boolean;
  /** `true` when this id exists on both sides and `isEqual` found a difference. Always `false`
   * for `'added'`/`'removed'` (there is nothing to compare one side against). */
  changed: boolean;
  beforeIndex: number | undefined;
  afterIndex: number | undefined;
  before: T | undefined;
  after: T | undefined;
}

/**
 * Diffs one ordered, id-keyed sequence against another: which ids were added, removed, moved, or
 * (per the caller's own `isEqual`) changed. Used for both `ScreenplayBlock[]` (flattened) and
 * `TitlePage[]` below -- one generic implementation of "diff an ordered list of identified things"
 * rather than two near-identical copies, since both are exactly that question with a different
 * payload type and a different notion of "equal."
 *
 * Entries are returned in a single deterministic order: primarily by `afterIndex` (so the result
 * reads in the shape of the newer document), with a `'removed'` entry (which has no `afterIndex`)
 * placed by its own `beforeIndex` instead. This interleaves removed items near where they used to
 * sit rather than grouping them separately, which is the more readable default for a UI rendering
 * this list top to bottom; it is a readability heuristic, not a claim of perfect positional
 * interleaving when several items were both removed and reordered in the same edit.
 */
export function diffIdentifiedSequence<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  isEqual: (before: T, after: T) => boolean,
): IdentifiedDiffEntry<T>[] {
  const beforeIndexed = before.map((item, index) => ({ index, item }));
  const afterIndexed = after.map((item, index) => ({ index, item }));
  const beforeById = new Map(beforeIndexed.map((entry) => [entry.item.id, entry]));
  const afterById = new Map(afterIndexed.map((entry) => [entry.item.id, entry]));

  const commonIdsInBeforeOrder = beforeIndexed
    .map((entry) => entry.item.id)
    .filter((id) => afterById.has(id));
  const afterPositionById = new Map(
    commonIdsInBeforeOrder.map((id) => [id, afterById.get(id)!.index]),
  );
  const movedIds = computeMovedIds(commonIdsInBeforeOrder, afterPositionById);

  const entries: IdentifiedDiffEntry<T>[] = [];
  for (const [id, beforeEntry] of beforeById) {
    const afterEntry = afterById.get(id);
    if (!afterEntry) {
      entries.push({
        after: undefined,
        afterIndex: undefined,
        before: beforeEntry.item,
        beforeIndex: beforeEntry.index,
        changed: false,
        id,
        moved: false,
        status: 'removed',
      });
      continue;
    }
    entries.push({
      after: afterEntry.item,
      afterIndex: afterEntry.index,
      before: beforeEntry.item,
      beforeIndex: beforeEntry.index,
      changed: !isEqual(beforeEntry.item, afterEntry.item),
      id,
      moved: movedIds.has(id),
      status: 'matched',
    });
  }
  for (const [id, afterEntry] of afterById) {
    if (beforeById.has(id)) continue;
    entries.push({
      after: afterEntry.item,
      afterIndex: afterEntry.index,
      before: undefined,
      beforeIndex: undefined,
      changed: false,
      id,
      moved: false,
      status: 'added',
    });
  }

  entries.sort(
    (a, b) => (a.afterIndex ?? a.beforeIndex ?? 0) - (b.afterIndex ?? b.beforeIndex ?? 0),
  );
  return entries;
}

/** One flattened block's diff entry, with the type/text distinction broken out of `changed`
 * (`diffIdentifiedSequence`'s generic `changed` flag) explicitly: `plan.md`'s screenplay-aware
 * diff must treat "a line moved from `action` to `dialogue` with identical text" as a change in
 * its own right, not fold it into an undifferentiated "something changed" bit a writer cannot
 * tell apart from a typo fix. */
export interface ScreenplayBlockDiffEntry extends IdentifiedDiffEntry<ScreenplayBlock> {
  /** `before.type !== after.type` for a matched entry; always `false` for `'added'`/`'removed'`. */
  elementTypeChanged: boolean;
  /** The matched entry's comparable text (or, for `scene_heading`, text plus scene number)
   * differs, independent of whether the element type also changed. Always `false` for
   * `'added'`/`'removed'`. */
  textChanged: boolean;
}

function toBlockDiffEntry(entry: IdentifiedDiffEntry<ScreenplayBlock>): ScreenplayBlockDiffEntry {
  if (entry.status !== 'matched' || !entry.before || !entry.after) {
    return { ...entry, elementTypeChanged: false, textChanged: false };
  }
  const elementTypeChanged = entry.before.type !== entry.after.type;
  // `blockSignature` already encodes both type and comparable text; a signature difference with
  // an unchanged type can only mean the text differs, so this never needs its own duplicate text
  // extraction -- it is answered in terms of the same `changed` flag `diffIdentifiedSequence`
  // already computed via `blockSignature`.
  const textChanged = entry.changed && !elementTypeChanged;
  return { ...entry, elementTypeChanged, textChanged };
}

/** Diffs two already-flattened block sequences -- `ScreenplayDiff.blocks` below, and the raw
 * material every scene's own `blocks` grouping is projected from. Exported for direct unit
 * testing of block-level move/change detection independent of scene grouping. */
export function diffScreenplayBlocks(
  before: readonly ScreenplayBlock[],
  after: readonly ScreenplayBlock[],
): ScreenplayBlockDiffEntry[] {
  return diffIdentifiedSequence(
    before,
    after,
    (a, b) => blockSignature(a) === blockSignature(b),
  ).map(toBlockDiffEntry);
}

function isEntryInteresting(entry: {
  status: IdentifiedDiffStatus;
  moved: boolean;
  changed: boolean;
}): boolean {
  return entry.status !== 'matched' || entry.moved || entry.changed;
}

/** One scene's diff -- `plan.md`'s "a screenplay's scene list is its skeleton"
 * (`revisions.ts`'s own `measureStructuralChange` comment) is exactly why this diff groups at
 * scene level rather than presenting an undifferentiated flat list of block changes: a writer who
 * reordered a sequence of scenes wants to read "Scene 4 moved after Scene 9," not reconstruct that
 * fact from forty individually-moved action and dialogue blocks. Keyed by the scene heading
 * block's own stable id -- `plan.md`: "scene-heading block IDs are scene/storyboard anchors" --
 * the identical anchor `deriveScenes` already uses, so a scene's identity in this diff is the same
 * one every other scene-aware feature in this codebase already relies on. */
export interface ScreenplaySceneDiffEntry {
  /** The scene heading block's stable id, or `'preamble'` for the pseudo-scene covering any
   * blocks before the first scene heading (`deriveScenes`'s own documented behavior: "blocks
   * before the first scene heading do not belong to a derived scene"). `'preamble'` can never
   * collide with a real scene id -- scene ids are block UUIDs. */
  id: string;
  area: 'scene' | 'preamble';
  status: IdentifiedDiffStatus;
  /** Scene-level move, from the heading-id sequence's own LIS -- independent of, but in the
   * ordinary case agreeing with, any individual block inside it also being flagged `moved` at the
   * block level (see `ScreenplayDiff.blocks`'s own comment on why the two can, deliberately,
   * disagree for a block that relocates to a *different* scene without that scene itself moving). */
  moved: boolean;
  beforeIndex: number | undefined;
  afterIndex: number | undefined;
  /** The heading's own display text (`INT. HOUSE - DAY`, without any scene-number suffix) on each
   * side, or `undefined` for the preamble (which has no heading) or a side where the scene does
   * not exist. */
  beforeHeadingText: string | undefined;
  afterHeadingText: string | undefined;
  beforeSceneNumber: string | undefined;
  afterSceneNumber: string | undefined;
  headingTextChanged: boolean;
  /**
   * This scene's own blocks, diffed *independently, against only this scene's own before/after
   * body* -- deliberately not a slice of the document-wide `ScreenplayDiff.blocks` list filtered
   * by id. The distinction matters for exactly the case this diff exists to get right: when a
   * whole scene relocates elsewhere in the document with nothing inside it touched, every block
   * inside it is, correctly, flagged `moved` in the document-wide list (its position in the whole
   * document changed) -- but restating all of them here too would bury "this scene moved" under a
   * pile of individually-flagged lines that, *relative to each other, inside this scene*, moved
   * nowhere at all. Running the identical move-aware block diff (`diffScreenplayBlocks`) on just
   * this scene's own two body arrays answers the question this field exists to answer -- "what
   * changed within this scene's own boundary" -- and naturally falls out of the same primitive
   * everything else in this module is built from, rather than a bespoke per-scene rule.
   *
   * One real consequence: a block that relocates to a *different* scene is reported here as
   * `'removed'` from its old scene and `'added'` to its new one, even though the document-wide
   * `blocks` entry for the same id correctly says `'matched', moved: true` (it survived, just not
   * in this scene). The two views intentionally answer different questions and are expected to
   * disagree in exactly that case.
   *
   * Only "interesting" entries are included (see `isEntryInteresting`) -- a scene with no
   * interesting internal change has an empty array here, not every unchanged line restated.
   */
  blocks: ScreenplayBlockDiffEntry[];
}

/** Blocks before the first scene heading, matching `deriveScenes`'s own "blocks before the first
 * scene heading do not belong to a derived scene." */
function preambleBlocks(blocks: readonly ScreenplayBlock[]): ScreenplayBlock[] {
  const firstHeadingIndex = blocks.findIndex((block) => block.type === 'scene_heading');
  return firstHeadingIndex === -1 ? [...blocks] : blocks.slice(0, firstHeadingIndex);
}

/** One scene's (or the preamble's) own `blocks` entry -- see `ScreenplaySceneDiffEntry.blocks`'s
 * own comment for why this is an independent, scene-scoped diff rather than a projection of the
 * document-wide one. `body` is the scene's un-flattened root-level blocks (`DerivedScene.body`, or
 * the raw preamble slice); flattening happens here, identically to every other block-level
 * comparison in this module. */
function sceneLocalBlocks(
  beforeBody: readonly ScreenplayBlock[],
  afterBody: readonly ScreenplayBlock[],
): ScreenplayBlockDiffEntry[] {
  return diffScreenplayBlocks(
    flattenScreenplayBlocks(beforeBody),
    flattenScreenplayBlocks(afterBody),
  ).filter(isEntryInteresting);
}

function headingDisplayText(heading: Extract<ScreenplayBlock, { type: 'scene_heading' }>): string {
  return heading.text;
}

/**
 * Builds the scene-grouped view: one entry per scene heading id present on either side (via
 * `diffIdentifiedSequence` over the heading sequence itself, for scene-level move detection), plus
 * one `'preamble'` entry when either side has blocks before its first scene heading.
 */
function diffScenes(before: Screenplay, after: Screenplay): ScreenplaySceneDiffEntry[] {
  const beforeScenes = deriveScenes(before.blocks);
  const afterScenes = deriveScenes(after.blocks);

  const headingEntries = diffIdentifiedSequence(
    beforeScenes.map((scene) => scene.heading),
    afterScenes.map((scene) => scene.heading),
    (a, b) => a.text === b.text && a.sceneNumber === b.sceneNumber,
  );

  const beforeSceneByHeadingId = new Map(beforeScenes.map((scene) => [scene.id, scene]));
  const afterSceneByHeadingId = new Map(afterScenes.map((scene) => [scene.id, scene]));

  const scenes: ScreenplaySceneDiffEntry[] = headingEntries.map((entry) => {
    const beforeScene = beforeSceneByHeadingId.get(entry.id);
    const afterScene = afterSceneByHeadingId.get(entry.id);
    return {
      area: 'scene',
      afterHeadingText: entry.after ? headingDisplayText(entry.after) : undefined,
      afterIndex: entry.afterIndex,
      afterSceneNumber: entry.after?.sceneNumber,
      beforeHeadingText: entry.before ? headingDisplayText(entry.before) : undefined,
      beforeIndex: entry.beforeIndex,
      beforeSceneNumber: entry.before?.sceneNumber,
      blocks: sceneLocalBlocks(beforeScene?.body ?? [], afterScene?.body ?? []),
      headingTextChanged: entry.changed,
      id: entry.id,
      moved: entry.moved,
      status: entry.status,
    };
  });

  const beforePreamble = preambleBlocks(before.blocks);
  const afterPreamble = preambleBlocks(after.blocks);
  if (beforePreamble.length > 0 || afterPreamble.length > 0) {
    const blocks = sceneLocalBlocks(beforePreamble, afterPreamble);
    if (blocks.length > 0) {
      scenes.unshift({
        area: 'preamble',
        afterHeadingText: undefined,
        afterIndex: undefined,
        afterSceneNumber: undefined,
        beforeHeadingText: undefined,
        beforeIndex: undefined,
        beforeSceneNumber: undefined,
        blocks,
        headingTextChanged: false,
        id: 'preamble',
        moved: false,
        status: 'matched',
      });
    }
  }

  // Only scenes with something interesting to report -- a scene untouched on either side (not
  // added, not removed, not moved, heading unchanged, no interesting blocks) contributes nothing
  // to the diff. This is what keeps a feature-length script's diff proportional to the actual
  // amount of change rather than restating every unchanged scene.
  return scenes.filter(
    (scene) =>
      scene.area === 'preamble' ||
      scene.status !== 'matched' ||
      scene.moved ||
      scene.headingTextChanged ||
      scene.blocks.length > 0,
  );
}

export type TitlePageDiffEntry = IdentifiedDiffEntry<TitlePage>;

function titlePagesEqual(a: TitlePage, b: TitlePage): boolean {
  // `TitlePage` is a flat object of optional strings and string arrays (title/authors/credit/
  // source/draftDate/contact) with no nested structure a key-order-sensitive comparison could get
  // wrong -- `screenplaySchema.parse` always builds it in the schema's own declared key order
  // (zod's `ZodObject` parse constructs output by iterating the shape definition, not the input's
  // own key order), so both sides compare consistently regardless of how each JSONB blob happened
  // to serialize its keys.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One field of `documentSettings` differing between the two screenplays -- plan.md: "These
 * values are document state... and travel with it through export and import," so they can differ
 * between any two revisions (or a revision and the live document) exactly as any other canonical
 * content can. Reported field by field, not as one opaque "settings changed" boolean, since a
 * writer comparing revisions can tell at a glance whether e.g. only `sceneNumbersEnabled` flipped
 * versus the whole settings block having been touched. */
export interface DocumentSettingsDiffEntry {
  field: keyof DocumentSettings;
  before: DocumentSettings[keyof DocumentSettings];
  after: DocumentSettings[keyof DocumentSettings];
}

function diffDocumentSettings(
  before: DocumentSettings,
  after: DocumentSettings,
): DocumentSettingsDiffEntry[] {
  const fields = Object.keys(before) as (keyof DocumentSettings)[];
  const entries: DocumentSettingsDiffEntry[] = [];
  for (const field of fields) {
    if (before[field] !== after[field]) {
      entries.push({ field, before: before[field], after: after[field] });
    }
  }
  return entries;
}

export interface ScreenplayDiff {
  titleChanged: boolean;
  titleBefore: string;
  titleAfter: string;
  documentSettingsChanges: DocumentSettingsDiffEntry[];
  /** Only title pages that were added, removed, moved, or changed -- see `diffIdentifiedSequence`'s
   * own ordering comment. An unaffected title page contributes nothing here. */
  titlePages: TitlePageDiffEntry[];
  /**
   * The document-wide, move-aware block diff -- every flattened block in either screenplay, keyed
   * by id, with `'matched'` entries limited to the interesting ones (added/removed/moved/changed;
   * see `isEntryInteresting`). This is the one list capable of truthfully saying "this specific
   * block moved" or "this block's element type changed with identical text" independent of which
   * scene(s) it belongs to on either side -- `scenes[].blocks` is a *projection* of this list onto
   * each scene's own local membership, built from this same data, and the two are expected to
   * disagree for a block that relocates across a scene boundary (see `ScreenplaySceneDiffEntry.
   * blocks`'s own comment).
   */
  blocks: ScreenplayBlockDiffEntry[];
  /** Scene-grouped summary -- see `diffScenes`'s own comment for why scene grouping exists as a
   * first-class layer rather than leaving a reader to reconstruct "this scene moved" from a flat
   * block list. Only scenes (and the preamble, if either side has unassigned leading blocks) with
   * something interesting to report are included. */
  scenes: ScreenplaySceneDiffEntry[];
  /** `true` exactly when nothing above differs at all -- two identical canonical screenplays
   * produce `isEmpty: true` and otherwise-empty arrays throughout. */
  isEmpty: boolean;
}

/**
 * Diffs two canonical screenplays. Pure, synchronous, and symmetric in its inputs only insofar as
 * the caller decides which is `before` and which is `after` -- callers comparing two revisions by
 * timestamp (`apps/api/src/revisions.ts`'s `getRevisionDiff`) pass the earlier one as `before`, so
 * "moved from position 3 to 7" and "added"/"removed" read in forward chronological order; nothing
 * about this function itself requires that ordering.
 */
export function diffScreenplays(before: Screenplay, after: Screenplay): ScreenplayDiff {
  const beforeFlatBlocks = flattenScreenplayBlocks(before.blocks);
  const afterFlatBlocks = flattenScreenplayBlocks(after.blocks);
  const blocks = diffScreenplayBlocks(beforeFlatBlocks, afterFlatBlocks);

  const scenes = diffScenes(before, after);
  const documentSettingsChanges = diffDocumentSettings(
    before.documentSettings,
    after.documentSettings,
  );
  const titlePagesAll = diffIdentifiedSequence(
    before.titlePages,
    after.titlePages,
    titlePagesEqual,
  );
  const titlePages = titlePagesAll.filter(isEntryInteresting);
  const titleChanged = before.title !== after.title;

  const interestingBlocks = blocks.filter(isEntryInteresting);

  const isEmpty =
    !titleChanged &&
    documentSettingsChanges.length === 0 &&
    titlePages.length === 0 &&
    interestingBlocks.length === 0 &&
    scenes.length === 0;

  return {
    blocks: interestingBlocks,
    documentSettingsChanges,
    isEmpty,
    scenes,
    titleAfter: after.title,
    titleBefore: before.title,
    titleChanged,
    titlePages,
  };
}

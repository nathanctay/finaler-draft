import {
  diffWords,
  flattenScreenplayBlocks,
  type Screenplay,
  type ScreenplayBlock,
  type TextDiffSegment,
} from '@finaler-draft/screenplay';
import type { ScreenplayElementKind } from '@finaler-draft/screenplay/pageFormat';
import type {
  RevisionDiffResult,
  ScreenplayBlockDiffEntry,
  ScreenplaySceneDiffEntry,
} from './api.js';

/**
 * Turns a `RevisionDiffResult` into **the screenplay, in document order, with every change marked
 * where it happened** -- the render model the inline diff view draws.
 *
 * This replaced a nested-list change *report* (document settings, then title page, then a `<ul>` of
 * scenes, each with a `<ul>` of changed blocks). The owner's objection to that view was that it "is
 * not something that is easily readable by a person," and he was right about why: a report of changes
 * makes the reader rebuild the screenplay in their head before they can understand what happened to
 * it. Google Docs' suggested-edits view and GitHub's unified diff both answer the same question the
 * opposite way round -- show the document, mark the changes in it, let the reader read once -- and
 * that is what this module's output is for.
 *
 * **Why this is a web-app module and not part of `@finaler-draft/screenplay`.** `diffScreenplays` is
 * the source of truth for *what changed* and is deliberately untouched by this redesign: move
 * detection, scene grouping, and per-block classification all still come from it. What belongs here
 * is *what the reader sees* -- which side becomes the spine, where a deleted line is re-inserted for
 * reading, whether a moved scene's individual lines should each announce their own move. Those are
 * presentation decisions, they differ per view, and keeping them out of the domain package is what
 * lets the diff engine stay one verified answer rather than acquiring a second, view-shaped one.
 *
 * **The after side is the spine.** Document order means the *newer* document's order: that is the
 * screenplay as it now stands, which is what a reader is trying to understand. Removed content is
 * re-inserted into that spine immediately after the surviving line it used to follow
 * (`precedingSurvivorAfterIndex`, below), the same way a unified diff shows a deleted line in the
 * position it occupied.
 *
 * **Pagination, deliberately not attempted.** Nothing here consults `@finaler-draft/layout`'s
 * `paginateScreenplay`, and the view draws no page boundaries. Showing removed content inline puts
 * more lines on the page than the document actually has, so any page boundary this view drew would be
 * a boundary that exists in no real document -- a page number a reader could quote at a collaborator
 * and be wrong. The page *geometry* (every element's indent, measure, and inter-element line spacing)
 * is still the real one, read from `@finaler-draft/screenplay/pageFormat` through
 * `pageGeometryCss.ts` exactly as the editor and the PDF path read it; only the page *break*
 * arithmetic is left out, because it is the one thing this view cannot truthfully compute.
 */

/** `'changed'` is a block present on both sides whose content differs -- its `segments` carry the
 * word-level detail. `'unchanged'` blocks are most of the document and are what makes this a
 * readable document rather than a list of fragments; a `'unchanged'` row may still carry
 * `moved: true`. */
export type InlineDiffMark = 'unchanged' | 'added' | 'removed' | 'changed';

/** One authored screenplay line (element) as the inline view renders it. `element` is what decides
 * its indent and measure, and is the element kind it has on the side it came from -- the newer one for
 * everything except a `'removed'` row, which only exists on the older side. */
export interface InlineDiffBlockRow {
  readonly kind: 'block';
  readonly key: string;
  readonly blockId: string;
  readonly element: ScreenplayElementKind;
  readonly mark: InlineDiffMark;
  /** Set only where the move is this block's own, never where it is merely a consequence of the
   * whole scene around it having moved -- see `movedSceneAfterBlockIds`. */
  readonly moved: boolean;
  readonly elementTypeChanged: boolean;
  readonly previousElement: ScreenplayElementKind | undefined;
  readonly sceneNumber: string | undefined;
  readonly previousSceneNumber: string | undefined;
  readonly sceneNumberChanged: boolean;
  /** The word-level comparison of this row's text (`diffWords`). An `'unchanged'` row carries one
   * `'equal'` segment; an `'added'`/`'removed'` row carries one segment of that kind; a `'changed'`
   * row carries the real word-level mix, which is the whole point of the word diff. */
  readonly segments: readonly TextDiffSegment[];
}

/** An authored forced page break. Carried as its own row kind because it has no text, no indent and
 * no measure -- it is a structural instruction, and rendering it as an empty line would make it
 * invisible exactly where a reader needs to see that one was added or removed. */
export interface InlineDiffPageBreakRow {
  readonly kind: 'page-break';
  readonly key: string;
  readonly blockId: string;
  readonly mark: InlineDiffMark;
}

/**
 * One end of a scene relocation: `'origin'` sits where the scene used to be, `'destination'` sits
 * immediately before the scene itself at its new position.
 *
 * **Why a move is rendered as a move, and not as a deletion plus an insertion.** A relocated scene is
 * the one thing this codebase's diff knows that neither reference tool does: `diffScreenplays`
 * detects it from stable block ids via a longest-increasing-subsequence backbone, and `plan.md`'s
 * stable scene and block ids exist specifically so "revision diffs... keep working even when content
 * is reordered." Rendering that as a deletion plus an insertion would throw the answer away and hand
 * the reader the harder problem instead: two large, unrelated-looking blocks of marked text that they
 * must read in full, and compare word by word, to discover they are the same scene. A pair of markers
 * costs two lines, names the scene, and states both positions -- the reader learns the scene is
 * intact and only its position changed, without reading it twice. The scene's own lines stay
 * unmarked, which is also *true*: nothing in them changed.
 */
export interface InlineDiffSceneMoveRow {
  readonly kind: 'scene-move';
  readonly key: string;
  readonly place: 'origin' | 'destination';
  readonly sceneId: string;
  readonly headingText: string;
  /** 1-based scene positions, in each side's own scene order. */
  readonly fromPosition: number;
  readonly toPosition: number;
}

export type InlineDiffRow = InlineDiffBlockRow | InlineDiffPageBreakRow | InlineDiffSceneMoveRow;

export interface InlineDiffCounts {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly movedBlocks: number;
  readonly movedScenes: number;
}

export interface InlineScreenplayDiff {
  readonly rows: readonly InlineDiffRow[];
  readonly counts: InlineDiffCounts;
  /** The document settings the view renders the geometry with: the newer side's, because the spine is
   * the newer document. A settings change between the two sides is reported separately (the view's own
   * document-level summary) rather than silently rendering half the page at each indent. */
  readonly documentSettings: Screenplay['documentSettings'];
  readonly isEmpty: boolean;
}

/** `page_break` carries no text of its own; `dual_dialogue` is flattened away before any of this runs
 * (`flattenScreenplayBlocks`). Returns `''` for either rather than repeating a type guard at each
 * call site. */
function blockText(block: ScreenplayBlock | undefined): string {
  return block && 'text' in block ? block.text : '';
}

/** A flattened block's element kind, or `undefined` for the two kinds that have no indent of their
 * own (`page_break`, and `dual_dialogue` which cannot appear post-flatten). */
function elementKind(block: ScreenplayBlock): ScreenplayElementKind | undefined {
  return block.type === 'page_break' || block.type === 'dual_dialogue' ? undefined : block.type;
}

/**
 * `result[i]` is the after-side index of the last block at or *before* before-index `i` that still
 * exists on the after side, or `undefined` when none does. One forward scan.
 *
 * This is the whole placement rule for removed content and for a moved scene's origin marker, and it
 * is the rule a unified diff already uses: a deleted line is shown immediately after the last line
 * common to both sides that preceded it. Anchoring to a surviving *neighbour* rather than to a raw
 * before-index is what keeps a deletion in the right place when content around it was also added,
 * removed or reordered -- a raw before-index means nothing in the after document's coordinates.
 *
 * Anchoring to the *preceding* survivor rather than the following one matters in exactly one case, and
 * it is a case this feature has to get right: when the block that followed a deletion is itself part of
 * a scene that was relocated to the far end of the document, the following-survivor rule drags the
 * deletion across the whole script to sit beside its old neighbour's new home. The preceding-survivor
 * rule leaves it where the reader expects -- just after the line it used to follow, which has not
 * moved.
 */
function precedingSurvivorAfterIndex(
  beforeBlocks: readonly ScreenplayBlock[],
  afterIndexById: ReadonlyMap<string, number>,
): (number | undefined)[] {
  const result: (number | undefined)[] = new Array(beforeBlocks.length).fill(undefined);
  let nearest: number | undefined;
  for (const [index, block] of beforeBlocks.entries()) {
    const afterIndex = afterIndexById.get(block.id);
    if (afterIndex !== undefined) nearest = afterIndex;
    result[index] = nearest;
  }
  return result;
}

/** The half-open before-side span `[start, end)` of each scene, keyed by its heading block id -- one
 * entry per `scene_heading`, ending where the next heading begins. Blocks before the first heading
 * belong to no scene (`deriveScenes`'s own documented behaviour) and appear in no span. */
function sceneSpans(
  blocks: readonly ScreenplayBlock[],
): Map<string, { start: number; end: number }> {
  const spans = new Map<string, { start: number; end: number }>();
  let openId: string | undefined;
  let openStart = 0;
  for (const [index, block] of blocks.entries()) {
    if (block.type !== 'scene_heading') continue;
    if (openId !== undefined) spans.set(openId, { start: openStart, end: index });
    openId = block.id;
    openStart = index;
  }
  if (openId !== undefined) spans.set(openId, { start: openStart, end: blocks.length });
  return spans;
}

/** 1-based scene position by heading id, in one side's own scene order. */
function scenePositions(blocks: readonly ScreenplayBlock[]): Map<string, number> {
  const positions = new Map<string, number>();
  let position = 0;
  for (const block of blocks) {
    if (block.type !== 'scene_heading') continue;
    position++;
    positions.set(block.id, position);
  }
  return positions;
}

/** The scenes `diffScreenplays` reports as relocated -- `moved` on a scene entry that exists on both
 * sides. An added or removed scene is not a move and is never one of these. */
function movedScenes(scenes: readonly ScreenplaySceneDiffEntry[]): ScreenplaySceneDiffEntry[] {
  return scenes.filter(
    (scene) => scene.area === 'scene' && scene.status === 'matched' && scene.moved,
  );
}

/**
 * One row for one after-side block, classified from its diff entry. `entry` is `undefined` for a block
 * `diffScreenplays` reported nothing about, which by that function's own contract means it is present
 * on both sides, unmoved and unchanged -- the ordinary case for most of a script.
 */
function afterBlockRow(
  block: ScreenplayBlock,
  entry: ScreenplayBlockDiffEntry | undefined,
  suppressMoved: boolean,
): InlineDiffBlockRow | InlineDiffPageBreakRow {
  const element = elementKind(block);
  const added = entry?.status === 'added';
  const changed = entry?.status === 'matched' && entry.changed;
  const mark: InlineDiffMark = added ? 'added' : changed ? 'changed' : 'unchanged';

  if (element === undefined) {
    return { kind: 'page-break', key: `after:${block.id}`, blockId: block.id, mark };
  }

  const afterText = blockText(block);
  const beforeText = blockText(entry?.before);
  const segments: readonly TextDiffSegment[] = added
    ? afterText.length === 0
      ? []
      : [{ kind: 'added', text: afterText }]
    : changed
      ? diffWords(beforeText, afterText)
      : afterText.length === 0
        ? []
        : [{ kind: 'equal', text: afterText }];

  const beforeSceneNumber =
    entry?.before && entry.before.type === 'scene_heading' ? entry.before.sceneNumber : undefined;
  const sceneNumber = block.type === 'scene_heading' ? block.sceneNumber : undefined;

  return {
    kind: 'block',
    key: `after:${block.id}`,
    blockId: block.id,
    element,
    mark,
    moved: !suppressMoved && entry?.status === 'matched' && entry.moved,
    elementTypeChanged: entry?.elementTypeChanged === true,
    previousElement: entry?.elementTypeChanged === true ? elementKind(entry.before!) : undefined,
    sceneNumber,
    previousSceneNumber: beforeSceneNumber,
    sceneNumberChanged: changed === true && beforeSceneNumber !== sceneNumber,
    segments,
  };
}

/** One row for a block that exists only on the older side. Its whole text is the removal -- there is
 * no newer text to compare it against word by word, and marking it in full is the truthful answer. */
function removedBlockRow(block: ScreenplayBlock): InlineDiffBlockRow | InlineDiffPageBreakRow {
  const element = elementKind(block);
  if (element === undefined) {
    return { kind: 'page-break', key: `before:${block.id}`, blockId: block.id, mark: 'removed' };
  }
  const text = blockText(block);
  return {
    kind: 'block',
    key: `before:${block.id}`,
    blockId: block.id,
    element,
    mark: 'removed',
    moved: false,
    elementTypeChanged: false,
    previousElement: undefined,
    sceneNumber: block.type === 'scene_heading' ? block.sceneNumber : undefined,
    previousSceneNumber: undefined,
    sceneNumberChanged: false,
    segments: text.length === 0 ? [] : [{ kind: 'removed', text }],
  };
}

/**
 * Builds the inline render model. Pure: same input, same rows, every time -- which is what lets the
 * placement rules above be asserted directly in unit tests rather than inferred from rendered DOM.
 */
export function buildInlineScreenplayDiff(result: RevisionDiffResult): InlineScreenplayDiff {
  const { diff, olderScreenplay, newerScreenplay } = result;
  const beforeBlocks = flattenScreenplayBlocks(olderScreenplay.blocks);
  const afterBlocks = flattenScreenplayBlocks(newerScreenplay.blocks);

  const entryById = new Map(diff.blocks.map((entry) => [entry.id, entry]));
  const afterIndexById = new Map(afterBlocks.map((block, index) => [block.id, index]));
  const precedingSurvivors = precedingSurvivorAfterIndex(beforeBlocks, afterIndexById);

  /** The after-side row that whatever used to sit at before-index `beforeIndex` should be emitted in
   * front of: one past its nearest preceding survivor, or the very top when it had none. `'end'` once
   * that lands past the last row. */
  const anchorForBeforeIndex = (beforeIndex: number): number | 'end' => {
    const preceding = beforeIndex === 0 ? undefined : precedingSurvivors[beforeIndex - 1];
    const anchor = preceding === undefined ? 0 : preceding + 1;
    return anchor >= afterBlocks.length ? 'end' : anchor;
  };

  // Removed blocks, grouped by the after-side row they should appear in front of, keeping their own
  // before-side order within each group.
  const removalsByAnchor = new Map<number | 'end', ScreenplayBlock[]>();
  for (const [index, block] of beforeBlocks.entries()) {
    if (afterIndexById.has(block.id)) continue;
    const anchor = anchorForBeforeIndex(index);
    const group = removalsByAnchor.get(anchor);
    if (group) group.push(block);
    else removalsByAnchor.set(anchor, [block]);
  }

  // Scene relocations: a marker at each end. The destination marker anchors to the scene's own heading
  // on the after side; the origin marker anchors to whatever still survives immediately after the
  // scene's old before-side span -- "the scene used to sit right here."
  const beforeSpans = sceneSpans(beforeBlocks);
  const beforePositions = scenePositions(beforeBlocks);
  const afterPositions = scenePositions(afterBlocks);
  const relocated = movedScenes(diff.scenes);
  const markersByAnchor = new Map<number | 'end', InlineDiffSceneMoveRow[]>();
  const addMarker = (anchor: number | 'end', marker: InlineDiffSceneMoveRow): void => {
    const group = markersByAnchor.get(anchor);
    if (group) group.push(marker);
    else markersByAnchor.set(anchor, [marker]);
  };
  for (const scene of relocated) {
    const headingText = scene.afterHeadingText ?? scene.beforeHeadingText ?? '';
    const fromPosition = beforePositions.get(scene.id) ?? 0;
    const toPosition = afterPositions.get(scene.id) ?? 0;
    const span = beforeSpans.get(scene.id);
    const originAnchor = span ? anchorForBeforeIndex(span.start) : 'end';
    addMarker(originAnchor, {
      kind: 'scene-move',
      key: `move-origin:${scene.id}`,
      place: 'origin',
      sceneId: scene.id,
      headingText,
      fromPosition,
      toPosition,
    });
    addMarker(afterIndexById.get(scene.id) ?? 'end', {
      kind: 'scene-move',
      key: `move-destination:${scene.id}`,
      place: 'destination',
      sceneId: scene.id,
      headingText,
      fromPosition,
      toPosition,
    });
  }

  // Every after-side block inside a scene that itself moved. Those blocks are all flagged `moved` in
  // the document-wide block diff -- correctly, their document positions did change -- but restating
  // that on each of them would bury "this scene moved" under a wall of individually-moved lines, which
  // is the same reasoning `ScreenplaySceneDiffEntry.blocks` is built on. The scene markers say it once.
  const afterSpans = sceneSpans(afterBlocks);
  const movedSceneAfterBlockIds = new Set<string>();
  for (const scene of relocated) {
    const span = afterSpans.get(scene.id);
    if (!span) continue;
    for (let index = span.start; index < span.end; index++) {
      movedSceneAfterBlockIds.add(afterBlocks[index]!.id);
    }
  }

  const rows: InlineDiffRow[] = [];
  const emitAnchored = (anchor: number | 'end'): void => {
    for (const block of removalsByAnchor.get(anchor) ?? []) rows.push(removedBlockRow(block));
    // Origin before destination at a shared anchor, so "moved from here" always reads before "moved
    // to here" when a scene happens to land next to its own former position.
    for (const marker of [...(markersByAnchor.get(anchor) ?? [])].sort((a, b) =>
      a.place === b.place ? 0 : a.place === 'origin' ? -1 : 1,
    )) {
      rows.push(marker);
    }
  };

  for (const [index, block] of afterBlocks.entries()) {
    emitAnchored(index);
    rows.push(afterBlockRow(block, entryById.get(block.id), movedSceneAfterBlockIds.has(block.id)));
  }
  emitAnchored('end');

  const counts: InlineDiffCounts = {
    added: rows.filter((row) => row.kind !== 'scene-move' && row.mark === 'added').length,
    removed: rows.filter((row) => row.kind !== 'scene-move' && row.mark === 'removed').length,
    changed: rows.filter((row) => row.kind !== 'scene-move' && row.mark === 'changed').length,
    movedBlocks: rows.filter((row) => row.kind === 'block' && row.moved).length,
    movedScenes: relocated.length,
  };

  return {
    rows,
    counts,
    documentSettings: newerScreenplay.documentSettings,
    isEmpty: diff.isEmpty,
  };
}

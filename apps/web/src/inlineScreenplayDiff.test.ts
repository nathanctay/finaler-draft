import { describe, expect, it } from 'vitest';
import { diffScreenplays, type Screenplay, type ScreenplayBlock } from '@finaler-draft/screenplay';
import { DEFAULT_DOCUMENT_SETTINGS } from '@finaler-draft/screenplay/pageFormat';
import type { RevisionDiffResult, ScreenplayDiff } from './api.js';
import {
  buildInlineScreenplayDiff,
  type InlineDiffBlockRow,
  type InlineDiffRow,
  type InlineDiffSceneMoveRow,
} from './inlineScreenplayDiff.js';

/**
 * Every case here drives the **real** `diffScreenplays` over two real screenplays rather than a
 * hand-written diff fixture. That is deliberate: the composition's whole job is to read that
 * function's actual output, and a hand-written `ScreenplayDiff` would let a wrong reading of a real
 * field (a `moved` flag the engine does not actually set, an `interesting`-only `blocks` array this
 * module forgot is filtered) pass while the view was broken in the browser.
 */
function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function action(index: number, text: string): ScreenplayBlock {
  return { id: uuidFor(index), type: 'action', text };
}

function dialogue(index: number, text: string): ScreenplayBlock {
  return { id: uuidFor(index), type: 'dialogue', text };
}

function character(index: number, text: string): ScreenplayBlock {
  return { id: uuidFor(index), type: 'character', text };
}

function sceneHeading(index: number, text: string, sceneNumber?: string): ScreenplayBlock {
  return {
    id: uuidFor(index),
    type: 'scene_heading',
    text,
    ...(sceneNumber ? { sceneNumber } : {}),
  };
}

function screenplay(blocks: ScreenplayBlock[], overrides: Partial<Screenplay> = {}): Screenplay {
  return {
    id: 'fixture',
    title: 'Fixture',
    schemaVersion: 1,
    titlePages: [],
    documentSettings: DEFAULT_DOCUMENT_SETTINGS,
    annotations: [],
    blocks,
    ...overrides,
  };
}

function diffResult(older: Screenplay, newer: Screenplay): RevisionDiffResult {
  return {
    screenplayId: uuidFor(999),
    older: { id: uuidFor(900), kind: 'named', label: 'Draft 1', createdAt: '2026-08-01T00:00:00Z' },
    newer: { id: 'current', kind: null, label: null, createdAt: null },
    // `diffScreenplays`'s own return type and this app's zod-inferred wire type are the same shape by
    // construction (`api.ts`'s schema mirrors it field for field); the cast is the assertion that they
    // still are, and fails to compile if either drifts.
    diff: diffScreenplays(older, newer) as ScreenplayDiff,
    olderScreenplay: older,
    newerScreenplay: newer,
  };
}

/**
 * The rendered reading order, as one compact string per row -- what a person would actually see going
 * down the page, which is the property most of these tests are about. Within a row, `[-...]` is marked
 * removed and `[+...]` is marked added, so an expectation states not only which rows appear in which
 * order but exactly which words inside them carry a mark.
 */
function readingOrder(rows: readonly InlineDiffRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === 'scene-move') return `move-${row.place}:${row.headingText}`;
    if (row.kind === 'page-break') return `page-break:${row.mark}`;
    const text = row.segments
      .map((segment) =>
        segment.kind === 'equal'
          ? segment.text
          : `[${segment.kind === 'removed' ? '-' : '+'}${segment.text}]`,
      )
      .join('');
    return `${row.mark}${row.moved ? '+moved' : ''}:${text}`;
  });
}

function blockRows(rows: readonly InlineDiffRow[]): InlineDiffBlockRow[] {
  return rows.filter((row): row is InlineDiffBlockRow => row.kind === 'block');
}

function moveRows(rows: readonly InlineDiffRow[]): InlineDiffSceneMoveRow[] {
  return rows.filter((row): row is InlineDiffSceneMoveRow => row.kind === 'scene-move');
}

describe('buildInlineScreenplayDiff: the document, not a change report', () => {
  it('renders every line of the newer document in document order, including the unchanged ones', () => {
    const blocks = [
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs a pot.'),
      character(3, 'ADA'),
      dialogue(4, 'It needs salt.'),
    ];
    const older = screenplay(blocks);
    const newer = screenplay(JSON.parse(JSON.stringify(blocks)) as ScreenplayBlock[]);

    const inline = buildInlineScreenplayDiff(diffResult(older, newer));

    // The point of the redesign: an unchanged screenplay still renders as the screenplay. The old
    // list view rendered nothing at all here, which is exactly why a reader could not read it.
    expect(readingOrder(inline.rows)).toEqual([
      'unchanged:INT. KITCHEN - DAY',
      'unchanged:Ada stirs a pot.',
      'unchanged:ADA',
      'unchanged:It needs salt.',
    ]);
    expect(inline.isEmpty).toBe(true);
    expect(inline.counts).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      movedBlocks: 0,
      movedScenes: 0,
    });
  });

  it('carries each row its element kind, so the renderer lays it out at the real screenplay indent', () => {
    const blocks = [
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      character(3, 'ADA'),
      dialogue(4, 'Salt.'),
    ];
    const inline = buildInlineScreenplayDiff(diffResult(screenplay(blocks), screenplay(blocks)));
    expect(blockRows(inline.rows).map((row) => row.element)).toEqual([
      'scene_heading',
      'action',
      'character',
      'dialogue',
    ]);
  });

  it('reports the newer side’s document settings, since the newer document is the spine', () => {
    const settings = { ...DEFAULT_DOCUMENT_SETTINGS, characterIndentIn: 4.1 };
    const inline = buildInlineScreenplayDiff(
      diffResult(
        screenplay([action(1, 'One.')]),
        screenplay([action(1, 'One.')], { documentSettings: settings }),
      ),
    );
    expect(inline.documentSettings.characterIndentIn).toBe(4.1);
  });
});

describe('buildInlineScreenplayDiff: added, removed and changed, marked in place', () => {
  it('marks an added line in place, with its whole text added and the lines around it untouched', () => {
    const older = screenplay([sceneHeading(1, 'INT. KITCHEN - DAY'), action(2, 'Ada stirs.')]);
    const newer = screenplay([
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      action(3, 'The pot boils over.'),
    ]);

    const inline = buildInlineScreenplayDiff(diffResult(older, newer));

    expect(readingOrder(inline.rows)).toEqual([
      'unchanged:INT. KITCHEN - DAY',
      'unchanged:Ada stirs.',
      'added:[+The pot boils over.]',
    ]);
    const addedRow = blockRows(inline.rows).find((row) => row.mark === 'added');
    expect(addedRow?.segments).toEqual([{ kind: 'added', text: 'The pot boils over.' }]);
    expect(inline.counts.added).toBe(1);
  });

  /**
   * Removed content is shown **where it used to be**, which is the half of "marked in place" a change
   * report cannot do at all. Anchored to the surviving line it used to sit in front of, so it reads as
   * a deletion from that spot rather than being swept to the end of the document.
   */
  it('re-inserts a removed line in front of the surviving line it used to precede', () => {
    const older = screenplay([
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      action(3, 'A cut beat.'),
      action(4, 'Ada tastes it.'),
    ]);
    const newer = screenplay([
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      action(4, 'Ada tastes it.'),
    ]);

    const inline = buildInlineScreenplayDiff(diffResult(older, newer));

    expect(readingOrder(inline.rows)).toEqual([
      'unchanged:INT. KITCHEN - DAY',
      'unchanged:Ada stirs.',
      'removed:[-A cut beat.]',
      'unchanged:Ada tastes it.',
    ]);
    expect(blockRows(inline.rows).find((row) => row.mark === 'removed')?.segments).toEqual([
      { kind: 'removed', text: 'A cut beat.' },
    ]);
    expect(inline.counts.removed).toBe(1);
  });

  it('places a removal with nothing surviving after it at the end, in its own original order', () => {
    const older = screenplay([action(1, 'Kept.'), action(2, 'Cut one.'), action(3, 'Cut two.')]);
    const newer = screenplay([action(1, 'Kept.')]);

    const inline = buildInlineScreenplayDiff(diffResult(older, newer));

    expect(readingOrder(inline.rows)).toEqual([
      'unchanged:Kept.',
      'removed:[-Cut one.]',
      'removed:[-Cut two.]',
    ]);
  });

  /**
   * The property the redesign exists for, at the composition layer: a one-word edit inside a speech
   * produces a row whose equal text dwarfs its marks. Mutation-tested (see
   * `progress/screenplay-diff.md`): replacing the word-level call with "mark the whole text" fails
   * here and in `packages/screenplay/src/textDiff.test.ts`.
   */
  it('marks only the changed words of a changed line, leaving the rest of the speech equal', () => {
    const older = screenplay([
      character(1, 'ADA'),
      dialogue(2, 'I waited by the window until the light went out.'),
    ]);
    const newer = screenplay([
      character(1, 'ADA'),
      dialogue(2, 'I waited by the doorway until the light went out.'),
    ]);

    const inline = buildInlineScreenplayDiff(diffResult(older, newer));
    const changed = blockRows(inline.rows).find((row) => row.mark === 'changed');

    expect(changed?.segments).toEqual([
      { kind: 'equal', text: 'I waited by the ' },
      { kind: 'removed', text: 'window ' },
      { kind: 'added', text: 'doorway ' },
      { kind: 'equal', text: 'until the light went out.' },
    ]);
    // Stated as a proportion, not just a shape: the overwhelming majority of the line is reported
    // unchanged. "Mark the whole text" cannot satisfy this however the segments are arranged.
    const total = changed!.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    const equal = changed!.segments
      .filter((segment) => segment.kind === 'equal')
      .reduce((sum, segment) => sum + segment.text.length, 0);
    expect(equal / total).toBeGreaterThan(0.7);
    expect(inline.counts.changed).toBe(1);
  });

  it('reports an element-type change on the row, with the previous element named', () => {
    const older = screenplay([{ id: uuidFor(1), type: 'action', text: 'Same words.' }]);
    const newer = screenplay([{ id: uuidFor(1), type: 'dialogue', text: 'Same words.' }]);

    const row = blockRows(buildInlineScreenplayDiff(diffResult(older, newer)).rows)[0]!;

    expect(row.mark).toBe('changed');
    expect(row.elementTypeChanged).toBe(true);
    expect(row.previousElement).toBe('action');
    expect(row.element).toBe('dialogue');
    // Identical words are still identical: an element change must not pretend the text changed too.
    expect(row.segments).toEqual([{ kind: 'equal', text: 'Same words.' }]);
  });

  it('reports a scene-number change on the heading row without marking its words', () => {
    const older = screenplay([sceneHeading(1, 'INT. KITCHEN - DAY', '4')]);
    const newer = screenplay([sceneHeading(1, 'INT. KITCHEN - DAY', '5')]);

    const row = blockRows(buildInlineScreenplayDiff(diffResult(older, newer)).rows)[0]!;

    expect(row.sceneNumberChanged).toBe(true);
    expect(row.previousSceneNumber).toBe('4');
    expect(row.sceneNumber).toBe('5');
    expect(row.segments).toEqual([{ kind: 'equal', text: 'INT. KITCHEN - DAY' }]);
  });

  it('renders an authored forced page break as its own row, marked when it was added or removed', () => {
    const older = screenplay([action(1, 'One.'), action(2, 'Two.')]);
    const newer = screenplay([
      action(1, 'One.'),
      { id: uuidFor(9), type: 'page_break' },
      action(2, 'Two.'),
    ]);

    expect(readingOrder(buildInlineScreenplayDiff(diffResult(older, newer)).rows)).toEqual([
      'unchanged:One.',
      'page-break:added',
      'unchanged:Two.',
    ]);
  });

  it('keeps an authored blank line as an unchanged row with no segments and no marks', () => {
    const blocks = [action(1, 'One.'), action(2, ''), action(3, 'Three.')];
    const rows = blockRows(
      buildInlineScreenplayDiff(diffResult(screenplay(blocks), screenplay(blocks))).rows,
    );
    expect(rows[1]!.segments).toEqual([]);
    expect(rows[1]!.mark).toBe('unchanged');
  });
});

describe('buildInlineScreenplayDiff: a move stays a move', () => {
  /**
   * The second property the redesign exists for. A relocated scene must read as one scene that moved,
   * not as a scene deleted here and an unrelated scene added there -- see
   * `InlineDiffSceneMoveRow`'s own comment for why that reading is strictly worse for a reader, and
   * `progress/screenplay-diff.md` for the mutation that proves these assertions actually guard it.
   */
  const olderThreeScenes = screenplay([
    sceneHeading(1, 'INT. KITCHEN - DAY'),
    action(2, 'Ada stirs.'),
    sceneHeading(3, 'EXT. GARDEN - DAY'),
    action(4, 'Rain starts.'),
    sceneHeading(5, 'INT. HALL - NIGHT'),
    action(6, 'A door closes.'),
  ]);
  // The garden scene, intact, relocated to the end. Nothing inside it is touched.
  const newerThreeScenes = screenplay([
    sceneHeading(1, 'INT. KITCHEN - DAY'),
    action(2, 'Ada stirs.'),
    sceneHeading(5, 'INT. HALL - NIGHT'),
    action(6, 'A door closes.'),
    sceneHeading(3, 'EXT. GARDEN - DAY'),
    action(4, 'Rain starts.'),
  ]);

  it('marks a relocated scene with a marker at each end and never as a deletion plus an insertion', () => {
    const inline = buildInlineScreenplayDiff(diffResult(olderThreeScenes, newerThreeScenes));

    // No row anywhere claims the relocated scene was added or removed. This is the assertion the
    // delete-plus-add mutation has to break, and it is stated over every row rather than over a
    // filtered subset so there is nowhere for such a rendering to hide.
    expect(
      blockRows(inline.rows).filter((row) => row.mark === 'added' || row.mark === 'removed'),
    ).toEqual([]);
    expect(inline.counts.added).toBe(0);
    expect(inline.counts.removed).toBe(0);

    // Instead: exactly two markers, one at the old position, one at the new, naming the same scene.
    const moves = moveRows(inline.rows);
    expect(moves).toHaveLength(2);
    expect(moves.map((move) => move.place)).toEqual(['origin', 'destination']);
    expect(new Set(moves.map((move) => move.sceneId))).toEqual(new Set([uuidFor(3)]));
    expect(moves.every((move) => move.headingText === 'EXT. GARDEN - DAY')).toBe(true);
    expect(moves.every((move) => move.fromPosition === 2 && move.toPosition === 3)).toBe(true);
    expect(inline.counts.movedScenes).toBe(1);
  });

  it('places the origin marker where the scene used to be and the destination marker at the scene itself', () => {
    const inline = buildInlineScreenplayDiff(diffResult(olderThreeScenes, newerThreeScenes));

    expect(readingOrder(inline.rows)).toEqual([
      'unchanged:INT. KITCHEN - DAY',
      'unchanged:Ada stirs.',
      // The garden scene used to sit here, immediately before the hall scene.
      'move-origin:EXT. GARDEN - DAY',
      'unchanged:INT. HALL - NIGHT',
      'unchanged:A door closes.',
      'move-destination:EXT. GARDEN - DAY',
      'unchanged:EXT. GARDEN - DAY',
      'unchanged:Rain starts.',
    ]);
  });

  it('leaves the relocated scene’s own lines unmarked, because nothing in them changed', () => {
    const inline = buildInlineScreenplayDiff(diffResult(olderThreeScenes, newerThreeScenes));
    const relocatedLines = blockRows(inline.rows).filter((row) =>
      [uuidFor(3), uuidFor(4)].includes(row.blockId),
    );
    expect(relocatedLines).toHaveLength(2);
    expect(relocatedLines.every((row) => row.mark === 'unchanged')).toBe(true);
    // And they do not each separately announce a move: the two markers already said it once.
    expect(relocatedLines.every((row) => row.moved === false)).toBe(true);
    expect(inline.counts.movedBlocks).toBe(0);
  });

  it('still reports a single line that moved on its own, where no scene moved around it', () => {
    const older = screenplay([
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(2, 'First beat.'),
      action(3, 'Second beat.'),
      action(4, 'Third beat.'),
    ]);
    const newer = screenplay([
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(3, 'Second beat.'),
      action(4, 'Third beat.'),
      action(2, 'First beat.'),
    ]);

    const inline = buildInlineScreenplayDiff(diffResult(older, newer));
    const moved = blockRows(inline.rows).filter((row) => row.moved);

    expect(moved.map((row) => row.segments.map((segment) => segment.text).join(''))).toEqual([
      'First beat.',
    ]);
    expect(moved.every((row) => row.mark === 'unchanged')).toBe(true);
    expect(inline.counts.movedBlocks).toBe(1);
    // Not a deletion and an insertion, here either.
    expect(inline.counts.added).toBe(0);
    expect(inline.counts.removed).toBe(0);
  });

  it('reports an added scene as added and a removed scene as removed, never as a move', () => {
    const older = screenplay([sceneHeading(1, 'INT. KITCHEN - DAY'), action(2, 'Ada stirs.')]);
    const newer = screenplay([
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      sceneHeading(7, 'EXT. ROOF - NIGHT'),
      action(8, 'Wind.'),
    ]);

    const inline = buildInlineScreenplayDiff(diffResult(older, newer));

    expect(moveRows(inline.rows)).toEqual([]);
    expect(inline.counts.movedScenes).toBe(0);
    expect(inline.counts.added).toBe(2);
  });
});

describe('buildInlineScreenplayDiff: an edit, an addition, a deletion and a relocated scene together', () => {
  it('reads as one document, in order, with each change marked where it happened', () => {
    const older = screenplay([
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs a pot.'),
      action(3, 'A beat that gets cut.'),
      sceneHeading(4, 'EXT. GARDEN - DAY'),
      action(5, 'Rain starts.'),
      sceneHeading(6, 'INT. HALL - NIGHT'),
      character(7, 'ADA'),
      dialogue(8, 'I waited by the window.'),
    ]);
    const newer = screenplay([
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs a pot.'),
      action(9, 'She adds salt.'),
      sceneHeading(6, 'INT. HALL - NIGHT'),
      character(7, 'ADA'),
      dialogue(8, 'I waited by the doorway.'),
      sceneHeading(4, 'EXT. GARDEN - DAY'),
      action(5, 'Rain starts.'),
    ]);

    const inline = buildInlineScreenplayDiff(diffResult(older, newer));

    expect(readingOrder(inline.rows)).toEqual([
      'unchanged:INT. KITCHEN - DAY',
      'unchanged:Ada stirs a pot.',
      // The cut line is shown immediately after the surviving line it used to follow, and the
      // relocated scene announces its old position right where it used to begin -- both of them in
      // the kitchen scene, which is where they belonged, not beside the garden scene's new home.
      'removed:[-A beat that gets cut.]',
      'move-origin:EXT. GARDEN - DAY',
      'added:[+She adds salt.]',
      'unchanged:INT. HALL - NIGHT',
      'unchanged:ADA',
      'changed:I waited by the [-window.][+doorway.]',
      'move-destination:EXT. GARDEN - DAY',
      'unchanged:EXT. GARDEN - DAY',
      'unchanged:Rain starts.',
    ]);
    expect(inline.counts).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      movedBlocks: 0,
      movedScenes: 1,
    });
    // The changed speech is marked at word granularity, not wholesale.
    const changed = blockRows(inline.rows).find((row) => row.mark === 'changed');
    expect(changed?.segments).toEqual([
      { kind: 'equal', text: 'I waited by the ' },
      { kind: 'removed', text: 'window.' },
      { kind: 'added', text: 'doorway.' },
    ]);
  });
});

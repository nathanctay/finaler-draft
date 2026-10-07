import { describe, expect, it } from 'vitest';
import { diffScreenplays, type Screenplay, type ScreenplayBlock } from '@finaler-draft/screenplay';
import { DEFAULT_DOCUMENT_SETTINGS } from '@finaler-draft/screenplay/pageFormat';
import { buildDiffNavigator } from './diffNavigator.js';
import type { RevisionDiffResult, ScreenplayDiff } from './api.js';

/**
 * The comparison Navigator's model. Every fixture is two real screenplays plus the **real**
 * `diffScreenplays` output, never a hand-written diff: the model's job is to read what that function
 * actually reports, and a hand-written diff would let a model that misreads a real field pass.
 */
function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function block(index: number, type: ScreenplayBlock['type'], text: string): ScreenplayBlock {
  return { id: uuidFor(index), type, text } as ScreenplayBlock;
}

const heading = (index: number, text: string) => block(index, 'scene_heading', text);
const action = (index: number, text: string) => block(index, 'action', text);
const character = (index: number, text: string) => block(index, 'character', text);
const dialogue = (index: number, text: string) => block(index, 'dialogue', text);

function screenplay(blocks: ScreenplayBlock[]): Screenplay {
  return {
    annotations: [],
    blocks,
    documentSettings: DEFAULT_DOCUMENT_SETTINGS,
    id: 'fixture',
    schemaVersion: 1,
    title: 'Fixture',
    titlePages: [],
  };
}

function diffResult(older: Screenplay, newer: Screenplay): RevisionDiffResult {
  return {
    diff: diffScreenplays(older, newer) as ScreenplayDiff,
    newer: { id: 'current', kind: null, label: null, createdAt: null },
    newerScreenplay: newer,
    older: {
      id: uuidFor(900),
      kind: 'named' as const,
      label: 'Draft 2',
      createdAt: '2026-08-06T15:04:00.000Z',
    },
    olderScreenplay: older,
    screenplayId: uuidFor(901),
  };
}

function clone(blocks: ScreenplayBlock[]): ScreenplayBlock[] {
  return JSON.parse(JSON.stringify(blocks)) as ScreenplayBlock[];
}

describe('comparison navigator: scenes', () => {
  it('lists every scene on either side, in the newer document’s order, numbered by the newer side', () => {
    const older = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      heading(3, 'EXT. ROOF - DAWN'),
      action(4, 'Wind lifts the tarp.'),
    ]);
    const newer = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      heading(3, 'EXT. ROOF - DAWN'),
      action(4, 'Wind lifts the tarp.'),
    ]);

    const { scenes, changedSceneCount } = buildDiffNavigator(diffResult(older, newer));

    expect(scenes.map((scene) => [scene.position, scene.headingText, scene.status])).toEqual([
      [1, 'INT. KITCHEN - DAY', 'unchanged'],
      [2, 'EXT. ROOF - DAWN', 'unchanged'],
    ]);
    expect(changedSceneCount).toBe(0);
    // The jump target is the heading block's own id, which is what every rendered row carries.
    expect(scenes.map((scene) => scene.blockId)).toEqual([uuidFor(1), uuidFor(3)]);
  });

  it('marks an added scene, counting its body as changed lines and not its heading', () => {
    const older = screenplay([heading(1, 'INT. KITCHEN - DAY'), action(2, 'Ada stirs.')]);
    const newer = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      heading(3, 'EXT. ROOF - DAWN'),
      action(4, 'Wind lifts the tarp.'),
    ]);

    const { scenes, changedSceneCount } = buildDiffNavigator(diffResult(older, newer));

    expect(scenes[1]).toMatchObject({
      blockId: uuidFor(3),
      // One, not two: the count is of the scene's body, which `deriveScenes` defines as the blocks
      // after the heading -- see `DiffNavigatorScene.changedLineCount`.
      changedLineCount: 1,
      headingText: 'EXT. ROOF - DAWN',
      moved: false,
      position: 2,
      status: 'added',
    });
    expect(changedSceneCount).toBe(1);
  });

  /** A removed scene has no position in the newer document and must not be given a borrowed one. */
  it('marks a removed scene and gives it no newer-side position', () => {
    const older = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      heading(3, 'EXT. ROOF - DAWN'),
      action(4, 'Wind lifts the tarp.'),
    ]);
    const newer = screenplay([heading(1, 'INT. KITCHEN - DAY'), action(2, 'Ada stirs.')]);

    const { scenes } = buildDiffNavigator(diffResult(older, newer));

    expect(scenes.map((scene) => scene.status)).toEqual(['unchanged', 'removed']);
    expect(scenes[1]?.position).toBeUndefined();
    expect(scenes[1]?.headingText).toBe('EXT. ROOF - DAWN');
    expect(scenes[1]?.changedLineCount).toBe(1);
  });

  it('marks a scene whose lines changed, and counts only the lines that changed', () => {
    const older = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs a pot.'),
      action(3, 'Steam rises.'),
    ]);
    const newer = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs a pan.'),
      action(3, 'Steam rises.'),
    ]);

    const { scenes } = buildDiffNavigator(diffResult(older, newer));

    expect(scenes[0]).toMatchObject({ changedLineCount: 1, moved: false, status: 'changed' });
  });

  it('marks a scene whose heading text changed, even with nothing else touched', () => {
    const older = screenplay([heading(1, 'INT. KITCHEN - DAY'), action(2, 'Ada stirs.')]);
    const newer = screenplay([heading(1, 'INT. KITCHEN - NIGHT'), action(2, 'Ada stirs.')]);

    const { scenes } = buildDiffNavigator(diffResult(older, newer));

    expect(scenes[0]?.status).toBe('changed');
    expect(scenes[0]?.headingText).toBe('INT. KITCHEN - NIGHT');
  });

  /**
   * A relocated scene with nothing inside it touched is `'moved'`, not `'changed'` -- which is exactly
   * what the manuscript's own two scene-move markers claim, and the property that makes a two-line
   * marker an adequate report of a move. Its lines are not counted as changed: they are not.
   */
  it('marks a relocated, otherwise untouched scene as moved, with no changed lines', () => {
    const olderBlocks = [
      heading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      heading(3, 'EXT. ROOF - DAWN'),
      action(4, 'Wind lifts the tarp.'),
      heading(5, 'INT. HALL - NIGHT'),
      action(6, 'A door closes.'),
    ];
    const older = screenplay(olderBlocks);
    const newer = screenplay([
      ...clone(olderBlocks.slice(0, 2)),
      ...clone(olderBlocks.slice(4, 6)),
      ...clone(olderBlocks.slice(2, 4)),
    ]);

    const { scenes, changedSceneCount } = buildDiffNavigator(diffResult(older, newer));

    const roof = scenes.find((scene) => scene.headingText === 'EXT. ROOF - DAWN');
    expect(roof).toMatchObject({ changedLineCount: 0, moved: true, status: 'moved' });
    expect(changedSceneCount).toBeGreaterThanOrEqual(1);
  });

  /** Both facts survive when a scene moved *and* was edited: `status` names the edit, because that is
   * what a reader has to go and read, and `moved` still reports the relocation. */
  it('reports both facts for a scene that moved and was edited, with the edit as its status', () => {
    const older = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      heading(3, 'EXT. ROOF - DAWN'),
      action(4, 'Wind lifts the tarp.'),
      heading(5, 'INT. HALL - NIGHT'),
      action(6, 'A door closes.'),
    ]);
    const newer = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      heading(5, 'INT. HALL - NIGHT'),
      action(6, 'A door closes.'),
      heading(3, 'EXT. ROOF - DAWN'),
      action(4, 'Wind tears the tarp.'),
    ]);

    const { scenes } = buildDiffNavigator(diffResult(older, newer));

    const roof = scenes.find((scene) => scene.headingText === 'EXT. ROOF - DAWN');
    expect(roof).toMatchObject({ changedLineCount: 1, moved: true, status: 'changed' });
  });

  /** `deriveScenes` puts blocks before the first heading in no scene at all, and the diff reports them
   * as a `'preamble'` pseudo-entry. The Navigator lists scenes, exactly as the editor's does. */
  it('lists no entry for the preamble pseudo-scene', () => {
    const older = screenplay([action(1, 'Before any heading.'), heading(2, 'INT. KITCHEN - DAY')]);
    const newer = screenplay([
      action(1, 'Before any heading at all.'),
      heading(2, 'INT. KITCHEN - DAY'),
    ]);

    const { scenes } = buildDiffNavigator(diffResult(older, newer));

    expect(scenes.map((scene) => scene.headingText)).toEqual(['INT. KITCHEN - DAY']);
  });
});

describe('comparison navigator: characters', () => {
  it('lists only characters whose own lines changed, never the whole cast', () => {
    const older = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      character(2, 'ADA'),
      dialogue(3, 'It needs salt.'),
      character(4, 'BEN'),
      dialogue(5, 'It needs nothing.'),
    ]);
    const newer = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      character(2, 'ADA'),
      dialogue(3, 'It needs pepper.'),
      character(4, 'BEN'),
      dialogue(5, 'It needs nothing.'),
    ]);

    const { characters } = buildDiffNavigator(diffResult(older, newer));

    expect(characters).toEqual([
      { blockId: uuidFor(3), changedLineCount: 1, name: 'ADA', status: 'changed' },
    ]);
  });

  it('marks a character who is new, and jumps to their first line', () => {
    const older = screenplay([heading(1, 'INT. KITCHEN - DAY'), action(2, 'Ada stirs.')]);
    const newer = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      action(2, 'Ada stirs.'),
      character(3, 'BEN'),
      dialogue(4, 'You are late.'),
    ]);

    const { characters } = buildDiffNavigator(diffResult(older, newer));

    expect(characters).toEqual([
      { blockId: uuidFor(3), changedLineCount: 2, name: 'BEN', status: 'added' },
    ]);
  });

  it('marks a character who is gone, and jumps to a line of theirs that was removed', () => {
    const older = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      character(2, 'ADA'),
      dialogue(3, 'It needs salt.'),
    ]);
    const newer = screenplay([heading(1, 'INT. KITCHEN - DAY')]);

    const { characters } = buildDiffNavigator(diffResult(older, newer));

    expect(characters).toEqual([
      { blockId: uuidFor(2), changedLineCount: 2, name: 'ADA', status: 'removed' },
    ]);
  });

  /** Counted once, not once per side: an edited line exists on both sides under one id, and reporting
   * it twice would tell a reader twice as much happened to that character as did. */
  it('counts an edited line once, and a replaced speech as the two changes it is', () => {
    const older = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      character(2, 'ADA'),
      dialogue(3, 'It needs salt.'),
      dialogue(4, 'A lot of salt.'),
    ]);
    const newer = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      character(2, 'ADA'),
      dialogue(3, 'It needs pepper.'),
      dialogue(5, 'Rather a lot.'),
    ]);

    const { characters } = buildDiffNavigator(diffResult(older, newer));

    // One edited line (id 3), one removed (id 4) and one added (id 5) -- three, not four.
    expect(characters).toEqual([
      { blockId: uuidFor(3), changedLineCount: 3, name: 'ADA', status: 'changed' },
    ]);
  });

  /** A speech that merely travelled with its scene is not a change to that character's lines. */
  it('lists nobody when every speech only moved', () => {
    const olderBlocks = [
      heading(1, 'INT. KITCHEN - DAY'),
      character(2, 'ADA'),
      dialogue(3, 'It needs salt.'),
      heading(4, 'EXT. ROOF - DAWN'),
      character(5, 'BEN'),
      dialogue(6, 'You are late.'),
    ];
    const older = screenplay(olderBlocks);
    const newer = screenplay([
      ...clone(olderBlocks.slice(3, 6)),
      ...clone(olderBlocks.slice(0, 3)),
    ]);

    const { characters } = buildDiffNavigator(diffResult(older, newer));

    expect(characters).toEqual([]);
  });

  /** `MARA` and `MARA (V.O.)` are one character (`DerivedCharacter.name`), exactly as the editor's own
   * Navigator groups them -- so a changed voice-over line attributes to the same row. */
  it('groups a character’s extensions into one row, as the editor’s navigator does', () => {
    const older = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      character(2, 'MARA'),
      dialogue(3, 'Here.'),
      character(4, 'MARA (V.O.)'),
      dialogue(5, 'And here.'),
    ]);
    const newer = screenplay([
      heading(1, 'INT. KITCHEN - DAY'),
      character(2, 'MARA'),
      dialogue(3, 'Here.'),
      character(4, 'MARA (V.O.)'),
      dialogue(5, 'And there.'),
    ]);

    const { characters } = buildDiffNavigator(diffResult(older, newer));

    expect(characters).toEqual([
      { blockId: uuidFor(5), changedLineCount: 1, name: 'MARA', status: 'changed' },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_SETTINGS } from './pageFormat.js';
import type { Screenplay, ScreenplayBlock } from './index.js';
import {
  STRUCTURAL_CHANGE_BLOCK_RATIO_THRESHOLD,
  STRUCTURAL_CHANGE_MIN_SCENE_DELTA,
  computeRevisionPreviewMetadata,
  measureStructuralChange,
} from './revisions.js';

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function action(index: number, text = 'x'): ScreenplayBlock {
  return { id: uuidFor(index), type: 'action', text };
}

function sceneHeading(index: number, text: string): ScreenplayBlock {
  return { id: uuidFor(index), type: 'scene_heading', text };
}

function dualDialogue(index: number): ScreenplayBlock {
  return {
    id: uuidFor(index),
    type: 'dual_dialogue',
    left: {
      id: uuidFor(index + 100),
      blocks: [
        { id: uuidFor(index + 101), type: 'character', text: 'ANNE' },
        { id: uuidFor(index + 102), type: 'dialogue', text: 'Left line.' },
      ],
    },
    right: {
      id: uuidFor(index + 200),
      blocks: [
        { id: uuidFor(index + 201), type: 'character', text: 'BEN' },
        { id: uuidFor(index + 202), type: 'dialogue', text: 'Right line.' },
      ],
    },
  };
}

function screenplay(blocks: ScreenplayBlock[]): Screenplay {
  return {
    id: 'fixture',
    title: 'Fixture',
    schemaVersion: 1,
    titlePages: [],
    documentSettings: DEFAULT_DOCUMENT_SETTINGS,
    annotations: [],
    blocks,
  };
}

describe('measureStructuralChange', () => {
  it('treats a missing baseline (no revision yet) as an empty screenplay', () => {
    const empty = screenplay([]);
    const measure = measureStructuralChange(undefined, empty);
    expect(measure.sceneCountBefore).toBe(0);
    expect(measure.sceneCountAfter).toBe(0);
    expect(measure.isMajor).toBe(false);
  });

  it('is major the first time any real content exists, with no revision to compare against yet', () => {
    const withOneScene = screenplay([sceneHeading(1, 'INT. KITCHEN - DAY'), action(2)]);
    const measure = measureStructuralChange(undefined, withOneScene);
    expect(measure.sceneCountDelta).toBe(1);
    expect(measure.isMajor).toBe(true);
  });

  it('is never major when nothing at all changed', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => action(i));
    const before = screenplay(blocks);
    const after = screenplay(blocks.map((block) => ({ ...block })));
    const measure = measureStructuralChange(before, after);
    expect(measure.sceneCountDelta).toBe(0);
    expect(measure.blockChangeRatio).toBe(0);
    expect(measure.isMajor).toBe(false);
  });

  it('is not major for an ordinary single-block edit, well under the block-ratio threshold', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => action(i));
    const before = screenplay(blocks);
    const edited = blocks.map((block, i) => (i === 0 ? { ...block, text: 'Edited.' } : block));
    const after = screenplay(edited);
    const measure = measureStructuralChange(before, after);
    expect(measure.blockChangeRatio).toBeCloseTo(1 / 20);
    expect(measure.blockChangeRatio).toBeLessThan(STRUCTURAL_CHANGE_BLOCK_RATIO_THRESHOLD);
    expect(measure.isMajor).toBe(false);
  });

  it('is major once the changed-block ratio crosses the threshold, with no scene added or removed', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => action(i));
    const before = screenplay(blocks);
    // 6 of 20 blocks rewritten -- 30%, above the 25% threshold.
    const edited = blocks.map((block, i) => (i < 6 ? { ...block, text: 'Rewritten.' } : block));
    const after = screenplay(edited);
    const measure = measureStructuralChange(before, after);
    expect(measure.blockChangeRatio).toBeCloseTo(6 / 20);
    expect(measure.sceneCountDelta).toBe(0);
    expect(measure.isMajor).toBe(true);
  });

  it('is exactly at the boundary: a ratio just below threshold is not major, just at or above is', () => {
    const blocks = Array.from({ length: 100 }, (_, i) => action(i));
    const before = screenplay(blocks);
    const just24 = screenplay(
      blocks.map((block, i) => (i < 24 ? { ...block, text: 'Rewritten.' } : block)),
    );
    const exactly25 = screenplay(
      blocks.map((block, i) => (i < 25 ? { ...block, text: 'Rewritten.' } : block)),
    );
    expect(measureStructuralChange(before, just24).isMajor).toBe(false);
    expect(measureStructuralChange(before, exactly25).isMajor).toBe(true);
  });

  it('is major when a scene is removed even if the block-ratio threshold is not otherwise crossed', () => {
    const before = screenplay([
      sceneHeading(1, 'INT. KITCHEN - DAY'),
      action(2),
      sceneHeading(3, 'EXT. GARDEN - DAY'),
      action(4),
    ]);
    const after = screenplay([sceneHeading(1, 'INT. KITCHEN - DAY'), action(2)]);
    const measure = measureStructuralChange(before, after);
    expect(measure.sceneCountDelta).toBeGreaterThanOrEqual(STRUCTURAL_CHANGE_MIN_SCENE_DELTA);
    expect(measure.isMajor).toBe(true);
  });

  it('flattens dual_dialogue so an edit inside one column counts as a changed block, not an opaque unit', () => {
    const before = screenplay([action(1), dualDialogue(2)]);
    const editedDual = dualDialogue(2);
    if (editedDual.type !== 'dual_dialogue') throw new Error('unreachable');
    editedDual.left.blocks[1] = { ...editedDual.left.blocks[1]!, text: 'Changed left line.' };
    const after = screenplay([action(1), editedDual]);
    const measure = measureStructuralChange(before, after);
    // 4 flattened dialogue-column blocks plus the one action block = 5 total; 1 changed.
    expect(measure.blockChangeRatio).toBeCloseTo(1 / 5);
  });
});

describe('computeRevisionPreviewMetadata', () => {
  it('counts scenes and flattened blocks, expanding dual_dialogue into its column blocks', () => {
    const metadata = computeRevisionPreviewMetadata(
      screenplay([sceneHeading(1, 'INT. KITCHEN - DAY'), action(2), dualDialogue(3)]),
    );
    expect(metadata.sceneCount).toBe(1);
    // scene heading + action + (character, dialogue) x2 for the dual-dialogue columns = 6.
    expect(metadata.blockCount).toBe(6);
  });

  it('reports zero scenes and zero blocks for an empty screenplay', () => {
    expect(computeRevisionPreviewMetadata(screenplay([]))).toEqual({
      sceneCount: 0,
      blockCount: 0,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_SETTINGS } from './pageFormat.js';
import { MAX_ROOT_BLOCKS } from './index.js';
import type { Screenplay, ScreenplayBlock } from './index.js';
import { diffScreenplays } from './diff.js';

/**
 * `diffScreenplays`'s own module comment states its complexity is linear/`O(n log n)` in the total
 * flattened block count across both screenplays, with no quadratic step. This is the test that
 * backs that claim with a real measurement rather than leaving it as an asserted-but-unverified
 * property: a near-feature-length-and-beyond fixture (close to `MAX_ROOT_BLOCKS`, the schema's own
 * ceiling, so this is at least as large a document as this codebase ever has to diff) with a
 * realistic mix of unchanged content, a block of edits, and a relocated run of scenes, diffed and
 * timed.
 *
 * The time budget is deliberately generous (seconds, not milliseconds) -- this guards against an
 * accidental quadratic-or-worse regression (which would blow well past it at this size), not
 * against ordinary machine-to-machine or CI-runner performance variance, which a tight budget
 * would make this test flaky for no correctness benefit.
 */
function sceneAt(index: number, blocksPerScene: number): ScreenplayBlock[] {
  const base = index * blocksPerScene;
  const blocks: ScreenplayBlock[] = [
    { id: uuid(base), type: 'scene_heading', text: `INT. LOCATION ${index} - DAY` },
  ];
  for (let i = 1; i < blocksPerScene; i++) {
    blocks.push({ id: uuid(base + i), type: 'action', text: `Beat ${index}.${i} of the story.` });
  }
  return blocks;
}

function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `10000000-0000-4000-8000-${hex}`;
}

function buildScreenplay(sceneCount: number, blocksPerScene: number): Screenplay {
  const blocks: ScreenplayBlock[] = [];
  for (let s = 0; s < sceneCount; s++) blocks.push(...sceneAt(s, blocksPerScene));
  return {
    id: 'large-fixture',
    title: 'Feature-Length Fixture',
    schemaVersion: 1,
    titlePages: [],
    documentSettings: DEFAULT_DOCUMENT_SETTINGS,
    annotations: [],
    blocks,
  };
}

describe('diffScreenplays: performance at feature length and beyond', () => {
  it('diffs a near-MAX_ROOT_BLOCKS screenplay, with a realistic edit and a relocated run of scenes, well within a generous time budget', () => {
    const blocksPerScene = 8;
    const sceneCount = Math.floor((MAX_ROOT_BLOCKS * 0.9) / blocksPerScene);
    const before = buildScreenplay(sceneCount, blocksPerScene);
    expect(before.blocks.length).toBeGreaterThan(5000);

    // A realistic mix of changes: edit a handful of blocks scattered through the document, and
    // relocate one contiguous run of scenes from the middle to the end -- the same shape of edit
    // `revisions.ts`'s own "major structural change" fixtures use, just at feature-length scale.
    const after = JSON.parse(JSON.stringify(before)) as Screenplay;
    for (let i = 0; i < 25; i++) {
      const target = after.blocks[i * 37 + 3];
      if (target && target.type === 'action') target.text = `${target.text} (revised)`;
    }
    const relocatedSceneCount = 5;
    const relocateFrom = Math.floor(sceneCount / 2);
    const relocatedBlocks = after.blocks.splice(
      relocateFrom * blocksPerScene,
      relocatedSceneCount * blocksPerScene,
    );
    after.blocks.push(...relocatedBlocks);

    const start = performance.now();
    const diff = diffScreenplays(before, after);
    const elapsedMs = performance.now() - start;

    // Correctness, not just speed: the relocated scenes show up as moved, not as a pile of
    // deletes and inserts, even at this scale.
    expect(diff.isEmpty).toBe(false);
    expect(diff.blocks.filter((b) => b.status === 'added' || b.status === 'removed')).toEqual([]);
    const movedScenes = diff.scenes.filter((scene) => scene.moved);
    expect(movedScenes.length).toBe(relocatedSceneCount);

    // The actual performance assertion. Generous on purpose -- see this file's own module
    // comment -- but well below what an O(n^2) implementation would take at this size (an n^2
    // scan over ~7,000 blocks is tens of millions of operations per comparison; the suite would
    // visibly stall, not just run slow, if the complexity regressed).
    expect(elapsedMs).toBeLessThan(5000);
  });
});

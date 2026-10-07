import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_SETTINGS } from './pageFormat.js';
import type { Screenplay, ScreenplayBlock, TitlePage } from './index.js';
import { diffIdentifiedSequence, diffScreenplays, type ScreenplaySceneDiffEntry } from './diff.js';

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function action(index: number, text = 'x'): ScreenplayBlock {
  return { id: uuidFor(index), type: 'action', text };
}

function dialogue(index: number, text = 'x'): ScreenplayBlock {
  return { id: uuidFor(index), type: 'dialogue', text };
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

function sceneAt(diff: ReturnType<typeof diffScreenplays>, id: string): ScreenplaySceneDiffEntry {
  const scene = diff.scenes.find((entry) => entry.id === id);
  if (!scene)
    throw new Error(`No scene entry found for id ${id}. Scenes: ${JSON.stringify(diff.scenes)}`);
  return scene;
}

describe('diffScreenplays: identical screenplays', () => {
  it('produces an empty diff for two structurally identical screenplays', () => {
    const blocks = [
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(2, 'Anne walks in.'),
      dialogue(3, 'Hello.'),
    ];
    const before = screenplay(blocks);
    // A fresh deep copy, not the same object reference -- proves comparison is by value, not
    // identity.
    const after = screenplay(JSON.parse(JSON.stringify(blocks)) as ScreenplayBlock[]);

    const diff = diffScreenplays(before, after);

    expect(diff.isEmpty).toBe(true);
    expect(diff.blocks).toEqual([]);
    expect(diff.scenes).toEqual([]);
    expect(diff.titlePages).toEqual([]);
    expect(diff.documentSettingsChanges).toEqual([]);
    expect(diff.titleChanged).toBe(false);
  });
});

describe('diffScreenplays: block-level add/remove/change/move', () => {
  it('reports a block present only in after as added', () => {
    const before = screenplay([sceneHeading(1, 'INT. HOUSE - DAY')]);
    const after = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'New action.')]);

    const diff = diffScreenplays(before, after);

    const entry = diff.blocks.find((b) => b.id === uuidFor(2));
    expect(entry).toMatchObject({ status: 'added', moved: false, changed: false });
    expect(diff.isEmpty).toBe(false);
  });

  it('reports a block present only in before as removed', () => {
    const before = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Gone soon.')]);
    const after = screenplay([sceneHeading(1, 'INT. HOUSE - DAY')]);

    const diff = diffScreenplays(before, after);

    const entry = diff.blocks.find((b) => b.id === uuidFor(2));
    expect(entry).toMatchObject({ status: 'removed', moved: false });
  });

  it('reports a content-only change (same element type) as changed, with textChanged true and elementTypeChanged false', () => {
    const before = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Original text.')]);
    const after = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Edited text.')]);

    const diff = diffScreenplays(before, after);

    const entry = diff.blocks.find((b) => b.id === uuidFor(2));
    expect(entry).toMatchObject({
      status: 'matched',
      changed: true,
      textChanged: true,
      elementTypeChanged: false,
      moved: false,
    });
  });

  it('reports an element-type change with identical text as a change, even though the text itself is untouched', () => {
    const before = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Same words.')]);
    const after = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), dialogue(2, 'Same words.')]);

    const diff = diffScreenplays(before, after);

    const entry = diff.blocks.find((b) => b.id === uuidFor(2));
    expect(entry).toMatchObject({
      status: 'matched',
      changed: true,
      elementTypeChanged: true,
      moved: false,
    });
    // The whole point of this case: text is byte-identical, so a naive "did the text change"
    // check alone would miss it entirely.
    expect(entry?.before?.type).toBe('action');
    expect(entry?.after?.type).toBe('dialogue');
  });

  it('is never major/changed when nothing at all changed for a given block', () => {
    const before = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Steady.')]);
    const after = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Steady.')]);

    const diff = diffScreenplays(before, after);

    expect(diff.blocks.find((b) => b.id === uuidFor(2))).toBeUndefined();
  });

  it('reports a pure reorder as a move, never as a delete plus an unrelated insert', () => {
    const before = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(2, 'First.'),
      action(3, 'Second.'),
      action(4, 'Third.'),
    ]);
    // Block 2 relocates to the end; 1, 3, and 4 keep their relative order, so the unique minimal
    // explanation is "2 moved" -- not "2 was deleted, and a new block with the same text was
    // inserted at the end." (Swapping two elements with no unique LIS would make the *which one
    // moved* assertion below ambiguous between equally-valid tie-breaks, so this fixture is
    // deliberately built to have one unambiguous answer.)
    const after = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(3, 'Second.'),
      action(4, 'Third.'),
      action(2, 'First.'),
    ]);

    const diff = diffScreenplays(before, after);

    // No id was added or removed -- every entry present in `before` is present in `after`.
    expect(diff.blocks.every((b) => b.status === 'matched')).toBe(true);
    expect(diff.blocks.map((b) => b.id)).toEqual([uuidFor(2)]);
    expect(diff.blocks[0]).toMatchObject({ status: 'matched', moved: true, changed: false });
  });

  it('reports a block that both moved and changed with both flags set', () => {
    const before = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(2, 'First.'),
      action(3, 'Second.'),
    ]);
    const after = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(3, 'Second.'),
      action(2, 'First, edited.'),
    ]);

    const diff = diffScreenplays(before, after);

    const entry = diff.blocks.find((b) => b.id === uuidFor(2));
    expect(entry).toMatchObject({ moved: true, changed: true, textChanged: true });
  });

  it('expands dual_dialogue so an edit inside one column is a changed block, not an opaque unit', () => {
    const before = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      {
        id: uuidFor(2),
        type: 'dual_dialogue',
        left: {
          id: uuidFor(10),
          blocks: [
            { id: uuidFor(11), type: 'character', text: 'ANNE' },
            { id: uuidFor(12), type: 'dialogue', text: 'Left line.' },
          ],
        },
        right: {
          id: uuidFor(20),
          blocks: [
            { id: uuidFor(21), type: 'character', text: 'BEN' },
            { id: uuidFor(22), type: 'dialogue', text: 'Right line.' },
          ],
        },
      },
    ]);
    const after = JSON.parse(JSON.stringify(before)) as Screenplay;
    const dual = after.blocks[1] as Extract<ScreenplayBlock, { type: 'dual_dialogue' }>;
    dual.right.blocks[1]!.text = 'Edited right line.';

    const diff = diffScreenplays(before, after);

    expect(diff.blocks).toHaveLength(1);
    expect(diff.blocks[0]).toMatchObject({ id: uuidFor(22), changed: true, textChanged: true });
  });
});

describe('diffScreenplays: scene-level grouping', () => {
  it('reports a realistic whole-scene relocation as "this scene moved," not a pile of deletes and inserts', () => {
    const sceneA = [
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(2, 'A beat.'),
      dialogue(3, 'A line.'),
    ];
    const sceneB = [sceneHeading(4, 'EXT. STREET - NIGHT'), action(5, 'B beat.')];
    const sceneC = [sceneHeading(6, 'INT. OFFICE - DAY'), action(7, 'C beat.')];

    const before = screenplay([...sceneA, ...sceneB, ...sceneC]);
    // Scene A relocates to the end, scenes B and C otherwise untouched and keep their own
    // relative order.
    const after = screenplay([...sceneB, ...sceneC, ...sceneA]);

    const diff = diffScreenplays(before, after);

    // The writer-facing answer: scene A (heading id 1) moved. Nothing in it changed.
    const movedScene = sceneAt(diff, uuidFor(1));
    expect(movedScene.status).toBe('matched');
    expect(movedScene.moved).toBe(true);
    expect(movedScene.headingTextChanged).toBe(false);
    expect(movedScene.blocks).toEqual([]);

    // Scenes B and C did not move relative to each other -- they are not even present in the
    // diff's scene list, because nothing about them changed.
    expect(diff.scenes.some((scene) => scene.id === uuidFor(4))).toBe(false);
    expect(diff.scenes.some((scene) => scene.id === uuidFor(6))).toBe(false);

    // Not a single block inside the relocated scene was reported as added or removed -- the
    // defining property this test exists to prove.
    const sceneAIds = new Set([uuidFor(1), uuidFor(2), uuidFor(3)]);
    for (const entry of diff.blocks) {
      if (sceneAIds.has(entry.id)) {
        expect(entry.status).toBe('matched');
        expect(entry.moved).toBe(true);
        expect(entry.changed).toBe(false);
      }
    }
    expect(diff.blocks.filter((b) => b.status === 'added' || b.status === 'removed')).toEqual([]);
  });

  it('reports an added scene', () => {
    const before = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Beat.')]);
    const after = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(2, 'Beat.'),
      sceneHeading(3, 'EXT. STREET - NIGHT'),
      action(4, 'New beat.'),
    ]);

    const diff = diffScreenplays(before, after);

    const scene = sceneAt(diff, uuidFor(3));
    expect(scene.status).toBe('added');
    expect(scene.afterHeadingText).toBe('EXT. STREET - NIGHT');
    expect(scene.beforeHeadingText).toBeUndefined();
  });

  it('reports a removed scene', () => {
    const before = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(2, 'Beat.'),
      sceneHeading(3, 'EXT. STREET - NIGHT'),
      action(4, 'Old beat.'),
    ]);
    const after = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Beat.')]);

    const diff = diffScreenplays(before, after);

    const scene = sceneAt(diff, uuidFor(3));
    expect(scene.status).toBe('removed');
    expect(scene.beforeHeadingText).toBe('EXT. STREET - NIGHT');
    expect(scene.afterHeadingText).toBeUndefined();
  });

  it('reports a changed heading text (not moved, not added/removed) with the scene marked matched', () => {
    const before = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Beat.')]);
    const after = screenplay([sceneHeading(1, 'INT. HOUSE - NIGHT'), action(2, 'Beat.')]);

    const diff = diffScreenplays(before, after);

    const scene = sceneAt(diff, uuidFor(1));
    expect(scene.status).toBe('matched');
    expect(scene.moved).toBe(false);
    expect(scene.headingTextChanged).toBe(true);
    expect(scene.beforeHeadingText).toBe('INT. HOUSE - DAY');
    expect(scene.afterHeadingText).toBe('INT. HOUSE - NIGHT');
  });

  it('groups a within-scene content edit under its own (unmoved) scene', () => {
    const before = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Original.')]);
    const after = screenplay([sceneHeading(1, 'INT. HOUSE - DAY'), action(2, 'Edited.')]);

    const diff = diffScreenplays(before, after);

    const scene = sceneAt(diff, uuidFor(1));
    expect(scene.status).toBe('matched');
    expect(scene.moved).toBe(false);
    expect(scene.blocks).toHaveLength(1);
    expect(scene.blocks[0]).toMatchObject({ id: uuidFor(2), changed: true, textChanged: true });
  });

  it('detects a reorder of blocks within one scene that itself did not move', () => {
    const before = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(2, 'First beat.'),
      action(3, 'Second beat.'),
      action(4, 'Third beat.'),
    ]);
    const after = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(3, 'Second beat.'),
      action(4, 'Third beat.'),
      action(2, 'First beat.'),
    ]);

    const diff = diffScreenplays(before, after);

    const scene = sceneAt(diff, uuidFor(1));
    expect(scene.status).toBe('matched');
    expect(scene.moved).toBe(false);
    expect(scene.blocks).toHaveLength(1);
    expect(scene.blocks[0]).toMatchObject({ id: uuidFor(2), status: 'matched', moved: true });
  });

  it('groups preamble blocks (before the first scene heading) separately, only when something about them changed', () => {
    const before = screenplay([action(1, 'Cold open.'), sceneHeading(2, 'INT. HOUSE - DAY')]);
    const afterUnchanged = screenplay([
      action(1, 'Cold open.'),
      sceneHeading(2, 'INT. HOUSE - DAY'),
    ]);
    expect(diffScreenplays(before, afterUnchanged).scenes.some((s) => s.area === 'preamble')).toBe(
      false,
    );

    const afterChanged = screenplay([
      action(1, 'Cold open, revised.'),
      sceneHeading(2, 'INT. HOUSE - DAY'),
    ]);
    const diff = diffScreenplays(before, afterChanged);
    const preamble = diff.scenes.find((s) => s.area === 'preamble');
    expect(preamble).toBeDefined();
    expect(preamble?.id).toBe('preamble');
    expect(preamble?.blocks).toHaveLength(1);
    expect(preamble?.blocks[0]).toMatchObject({ id: uuidFor(1), changed: true });
  });

  it('shows a block that relocates to a different scene as removed from its old scene and added to its new scene, while the document-wide entry says it moved, not deleted', () => {
    const before = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      action(2, 'Relocating beat.'),
      sceneHeading(3, 'EXT. STREET - NIGHT'),
      action(4, 'Stays put.'),
    ]);
    const after = screenplay([
      sceneHeading(1, 'INT. HOUSE - DAY'),
      sceneHeading(3, 'EXT. STREET - NIGHT'),
      action(4, 'Stays put.'),
      action(2, 'Relocating beat.'),
    ]);

    const diff = diffScreenplays(before, after);

    // Document-wide: the block survived and simply moved -- never reported as delete+add.
    const documentEntry = diff.blocks.find((b) => b.id === uuidFor(2));
    expect(documentEntry).toMatchObject({ status: 'matched', moved: true, changed: false });

    // Scene-local: scene 1 lost it, scene 3 gained it -- each scene's own boundary accurately
    // describes what changed within it, which is a deliberately different (and equally correct)
    // answer to a different question than the document-wide view above.
    const sceneOne = sceneAt(diff, uuidFor(1));
    expect(sceneOne.blocks).toContainEqual(
      expect.objectContaining({ id: uuidFor(2), status: 'removed' }),
    );
    const sceneThree = sceneAt(diff, uuidFor(3));
    expect(sceneThree.blocks).toContainEqual(
      expect.objectContaining({ id: uuidFor(2), status: 'added' }),
    );
  });
});

describe('diffScreenplays: title, title pages, document settings', () => {
  function titlePage(id: string, overrides: Partial<TitlePage> = {}): TitlePage {
    return { id, title: 'Working Title', credit: 'written by', ...overrides };
  }

  it('reports a screenplay title change', () => {
    const before = screenplay([], { title: 'Draft One' });
    const after = screenplay([], { title: 'Draft Two' });

    const diff = diffScreenplays(before, after);

    expect(diff.titleChanged).toBe(true);
    expect(diff.titleBefore).toBe('Draft One');
    expect(diff.titleAfter).toBe('Draft Two');
    expect(diff.isEmpty).toBe(false);
  });

  it('reports an added, removed, and changed title page by stable id', () => {
    const before = screenplay([], {
      titlePages: [titlePage('tp-removed'), titlePage('tp-changed', { credit: 'written by' })],
    });
    const after = screenplay([], {
      titlePages: [
        titlePage('tp-changed', { credit: 'story by' }),
        titlePage('tp-added', { title: 'New Page' }),
      ],
    });

    const diff = diffScreenplays(before, after);

    const removed = diff.titlePages.find((t) => t.id === 'tp-removed');
    const added = diff.titlePages.find((t) => t.id === 'tp-added');
    const changed = diff.titlePages.find((t) => t.id === 'tp-changed');
    expect(removed?.status).toBe('removed');
    expect(added?.status).toBe('added');
    expect(changed).toMatchObject({ status: 'matched', changed: true });
  });

  it('omits an unaffected title page entirely', () => {
    const page = titlePage('tp-steady');
    const before = screenplay([], { titlePages: [page] });
    const after = screenplay([], { titlePages: [{ ...page }] });

    const diff = diffScreenplays(before, after);

    expect(diff.titlePages).toEqual([]);
  });

  it('reports document settings changes field by field', () => {
    const before = screenplay([]);
    const after = screenplay([], {
      documentSettings: {
        ...DEFAULT_DOCUMENT_SETTINGS,
        sceneNumbersEnabled: !DEFAULT_DOCUMENT_SETTINGS.sceneNumbersEnabled,
        pageNumberStyle:
          DEFAULT_DOCUMENT_SETTINGS.pageNumberStyle === 'arabic' ? 'roman' : 'arabic',
      },
    });

    const diff = diffScreenplays(before, after);

    expect(diff.documentSettingsChanges).toHaveLength(2);
    expect(diff.documentSettingsChanges.map((c) => c.field).sort()).toEqual(
      ['pageNumberStyle', 'sceneNumbersEnabled'].sort(),
    );
    expect(diff.isEmpty).toBe(false);
  });

  it('reports no document settings changes when settings are identical', () => {
    const before = screenplay([]);
    const after = screenplay([], { documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS } });

    expect(diffScreenplays(before, after).documentSettingsChanges).toEqual([]);
  });
});

describe('diffIdentifiedSequence: the generic move-aware primitive', () => {
  type Item = { id: string; value: number };

  it('detects no moves at all when the order is unchanged', () => {
    const before: Item[] = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'c', value: 3 },
    ];
    const after: Item[] = before.map((item) => ({ ...item }));

    const entries = diffIdentifiedSequence(before, after, (a, b) => a.value === b.value);

    expect(entries.every((e) => !e.moved)).toBe(true);
  });

  it('treats inserting one new item at the front as adding, not moving, every existing item', () => {
    const before: Item[] = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'c', value: 3 },
    ];
    const after: Item[] = [{ id: 'z', value: 0 }, ...before.map((item) => ({ ...item }))];

    const entries = diffIdentifiedSequence(before, after, (a, b) => a.value === b.value);

    const existing = entries.filter((e) => e.id !== 'z');
    expect(existing.every((e) => !e.moved)).toBe(true);
    expect(entries.find((e) => e.id === 'z')).toMatchObject({ status: 'added' });
  });

  it('finds the minimal set of moves for a single relocated item among untouched neighbors', () => {
    const before: Item[] = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'c', value: 3 },
      { id: 'd', value: 4 },
    ];
    // 'b' relocates to the end; a, c, d keep their relative order.
    const after: Item[] = [
      { id: 'a', value: 1 },
      { id: 'c', value: 3 },
      { id: 'd', value: 4 },
      { id: 'b', value: 2 },
    ];

    const entries = diffIdentifiedSequence(before, after, (a, b) => a.value === b.value);

    expect(entries.find((e) => e.id === 'b')?.moved).toBe(true);
    for (const id of ['a', 'c', 'd']) {
      expect(entries.find((e) => e.id === id)?.moved).toBe(false);
    }
  });
});

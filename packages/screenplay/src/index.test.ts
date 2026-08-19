import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MARGIN_LEFT_IN, MARGIN_RIGHT_IN, PAGE_WIDTH_IN } from './pageFormat.js';
import { minimalScreenplayFixture, screenplayFixture } from './fixtures.js';
import {
  SCREENPLAY_SCHEMA_VERSION,
  DEFAULT_DOCUMENT_SETTINGS,
  MAX_ANNOTATIONS,
  MAX_AUTHORED_TEXT_LENGTH,
  MAX_CANONICAL_NODES,
  MAX_DUAL_DIALOGUE_COLUMN_BLOCKS,
  MAX_ROOT_BLOCKS,
  MAX_TOTAL_AUTHORED_TEXT_LENGTH,
  createDefaultTitlePage,
  deriveScenes,
  parseScreenplay,
  safeParseScreenplay,
  screenplayBlockSchema,
  screenplaySchema,
} from './index.js';

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function actionBlock(index: number, text = 'x') {
  return { id: uuidFor(index), type: 'action' as const, text };
}

function fullDualDialogue(index: number) {
  const firstId = 100_000 + index * (MAX_DUAL_DIALOGUE_COLUMN_BLOCKS * 2 + 3);
  const dialogueBlocks = (offset: number, character: string) =>
    Array.from({ length: MAX_DUAL_DIALOGUE_COLUMN_BLOCKS }, (_, blockIndex) =>
      blockIndex === 0
        ? { id: uuidFor(firstId + offset), type: 'character' as const, text: character }
        : { id: uuidFor(firstId + offset + blockIndex), type: 'dialogue' as const, text: 'Yes.' },
    );

  return {
    id: uuidFor(firstId),
    type: 'dual_dialogue' as const,
    left: {
      id: uuidFor(firstId + 1),
      blocks: dialogueBlocks(2, 'ADA'),
    },
    right: {
      id: uuidFor(firstId + 2 + MAX_DUAL_DIALOGUE_COLUMN_BLOCKS),
      blocks: dialogueBlocks(3 + MAX_DUAL_DIALOGUE_COLUMN_BLOCKS, 'MILES'),
    },
  };
}

describe('screenplaySchema', () => {
  it('accepts a realistic screenplay with every printable root element', () => {
    const parsed = parseScreenplay(screenplayFixture);

    expect(parsed).toEqual(screenplayFixture);
    expect(parsed.schemaVersion).toBe(SCREENPLAY_SCHEMA_VERSION);
    expect(parsed.blocks.map((block) => block.type)).toEqual([
      'scene_heading',
      'action',
      'character',
      'parenthetical',
      'dialogue',
      'transition',
      'scene_heading',
      'shot',
      'dual_dialogue',
      'page_break',
    ]);
    expect(parsed.annotations).toHaveLength(1);
    expect(parsed.annotations[0]?.anchor.blockId).toBe('ba53c2dc-10a6-46d7-a409-9aabbff7cf5d');
  });

  it('accepts an empty screenplay while an editor is being composed', () => {
    expect(parseScreenplay(minimalScreenplayFixture)).toEqual(minimalScreenplayFixture);
  });

  it('accepts omitted optional title-page and scene-number text fields', () => {
    const parsed = parseScreenplay({
      ...minimalScreenplayFixture,
      titlePages: [{ id: uuidFor(90_000) }],
      blocks: [
        {
          id: uuidFor(90_001),
          type: 'scene_heading',
          text: 'INT. APARTMENT - MORNING',
        },
      ],
    });

    expect(parsed.titlePages[0]).toEqual({ id: uuidFor(90_000) });
    expect(parsed.blocks[0]).toMatchObject({ type: 'scene_heading' });
    expect('sceneNumber' in (parsed.blocks[0] ?? {})).toBe(false);
  });

  it('requires explicit empty collections in canonical snapshots', () => {
    const { schemaVersion, id, title, titlePages, blocks, annotations } = minimalScreenplayFixture;
    const withoutAnnotations = { schemaVersion, id, title, titlePages, blocks };
    const withoutTitlePages = { schemaVersion, id, title, blocks, annotations };

    expect(safeParseScreenplay(withoutAnnotations).success).toBe(false);
    expect(safeParseScreenplay(withoutTitlePages).success).toBe(false);
  });

  it('rejects a future schema version without attempting migration', () => {
    const result = safeParseScreenplay({ ...minimalScreenplayFixture, schemaVersion: 2 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['schemaVersion']);
    }
  });

  it('rejects extra fields so persisted canonical snapshots are unambiguous', () => {
    const result = safeParseScreenplay({ ...minimalScreenplayFixture, ownerId: 'not-canonical' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe(z.ZodIssueCode.unrecognized_keys);
    }
  });

  it('rejects duplicate stable identifiers across every canonical entity', () => {
    const duplicateId = screenplayFixture.blocks[0]?.id;
    const dualDialogue = screenplayFixture.blocks.find((block) => block.type === 'dual_dialogue');
    if (dualDialogue === undefined || duplicateId === undefined) {
      throw new Error('The screenplay fixture must contain a scene heading and dual dialogue.');
    }

    const result = safeParseScreenplay({
      ...screenplayFixture,
      blocks: [
        ...screenplayFixture.blocks.slice(0, -2),
        { ...dualDialogue, left: { ...dualDialogue.left, id: duplicateId } },
        ...screenplayFixture.blocks.slice(-1),
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          message: `Stable id ${duplicateId} must be globally unique within a screenplay.`,
        }),
      );
    }
  });

  it('rejects stable identifiers reused between the screenplay, title page, blocks, and annotations', () => {
    const screenplayId = screenplayFixture.id;
    const titlePageId = screenplayFixture.titlePages[0]?.id;
    const annotationId = screenplayFixture.annotations[0]?.id;
    if (titlePageId === undefined || annotationId === undefined) {
      throw new Error('The screenplay fixture must contain a title page and annotation.');
    }

    for (const input of [
      {
        ...screenplayFixture,
        titlePages: [{ ...screenplayFixture.titlePages[0], id: screenplayId }],
      },
      {
        ...screenplayFixture,
        blocks: [
          { ...screenplayFixture.blocks[0], id: titlePageId },
          ...screenplayFixture.blocks.slice(1),
        ],
      },
      {
        ...screenplayFixture,
        annotations: [
          { ...screenplayFixture.annotations[0], id: annotationId },
          { ...screenplayFixture.annotations[0], id: titlePageId },
        ],
      },
    ]) {
      expect(safeParseScreenplay(input).success).toBe(false);
    }
  });

  it('rejects an invalid nested dual-dialogue block shape', () => {
    const result = screenplayBlockSchema.safeParse({
      id: '6d292544-0da7-4d70-b4fc-1e74f8419f8e',
      type: 'dual_dialogue',
      left: { id: '414a6e41-ef46-4494-9973-1be5e1c5a058', blocks: [] },
      right: { id: '7bb08610-61a9-44d4-8c9e-14c3bc3e52c4', blocks: [] },
    });

    expect(result.success).toBe(false);
  });

  it('requires every dual-dialogue column to start with character and contain dialogue', () => {
    const dualDialogue = screenplayFixture.blocks.find((block) => block.type === 'dual_dialogue');
    if (dualDialogue === undefined) {
      throw new Error('The screenplay fixture must contain dual dialogue.');
    }

    const missingCharacter = screenplayBlockSchema.safeParse({
      ...dualDialogue,
      left: { ...dualDialogue.left, blocks: [dualDialogue.left.blocks[1]] },
    });
    const missingDialogue = screenplayBlockSchema.safeParse({
      ...dualDialogue,
      right: { ...dualDialogue.right, blocks: [dualDialogue.right.blocks[0]] },
    });

    expect(missingCharacter.success).toBe(false);
    expect(missingDialogue.success).toBe(false);
  });

  it('enforces root, annotation, and dual-dialogue resource bounds at their boundaries', () => {
    const rootBlocks = Array.from({ length: MAX_ROOT_BLOCKS }, (_, index) => actionBlock(index));
    const annotations = Array.from({ length: MAX_ANNOTATIONS }, (_, index) => ({
      id: uuidFor(index + MAX_ROOT_BLOCKS),
      type: 'note' as const,
      text: 'x',
      anchor: { blockId: rootBlocks[0]!.id, startOffset: 0, endOffset: 1 },
    }));
    const dialogueBlocks = Array.from({ length: MAX_DUAL_DIALOGUE_COLUMN_BLOCKS }, (_, index) =>
      index === 0
        ? { id: uuidFor(index + 30_000), type: 'character' as const, text: 'ADA' }
        : { id: uuidFor(index + 30_000), type: 'dialogue' as const, text: 'Yes.' },
    );
    const dualDialogue = screenplayFixture.blocks.find((block) => block.type === 'dual_dialogue');
    if (dualDialogue === undefined) {
      throw new Error('The screenplay fixture must contain dual dialogue.');
    }

    expect(
      safeParseScreenplay({ ...minimalScreenplayFixture, blocks: rootBlocks, annotations }).success,
    ).toBe(true);
    expect(
      safeParseScreenplay({
        ...minimalScreenplayFixture,
        blocks: [...rootBlocks, actionBlock(MAX_ROOT_BLOCKS)],
        annotations: [],
      }).success,
    ).toBe(false);
    expect(
      safeParseScreenplay({
        ...minimalScreenplayFixture,
        blocks: rootBlocks,
        annotations: [
          ...annotations,
          {
            id: uuidFor(20_001),
            type: 'note',
            text: 'x',
            anchor: { blockId: rootBlocks[0]!.id, startOffset: 0, endOffset: 1 },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      screenplayBlockSchema.safeParse({
        ...dualDialogue,
        left: { ...dualDialogue.left, blocks: dialogueBlocks },
      }).success,
    ).toBe(true);
    expect(
      screenplayBlockSchema.safeParse({
        ...dualDialogue,
        left: { ...dualDialogue.left, blocks: [...dialogueBlocks, dialogueBlocks[1]] },
      }).success,
    ).toBe(false);
  });

  it('enforces the aggregate canonical-node budget across fully populated dual dialogue', () => {
    const nodesPerFullDualDialogue = MAX_DUAL_DIALOGUE_COLUMN_BLOCKS * 2 + 3;
    const validCount = Math.floor(MAX_CANONICAL_NODES / nodesPerFullDualDialogue);
    const nearBoundaryBlocks = Array.from({ length: validCount }, (_, index) =>
      fullDualDialogue(index),
    );
    const overflowBlocks = [...nearBoundaryBlocks, fullDualDialogue(validCount)];

    expect(validCount * nodesPerFullDualDialogue).toBeLessThanOrEqual(MAX_CANONICAL_NODES);
    expect((validCount + 1) * nodesPerFullDualDialogue).toBeGreaterThan(MAX_CANONICAL_NODES);
    expect(
      safeParseScreenplay({ ...minimalScreenplayFixture, blocks: nearBoundaryBlocks }).success,
    ).toBe(true);
    expect(
      safeParseScreenplay({ ...minimalScreenplayFixture, blocks: overflowBlocks }).success,
    ).toBe(false);
  });

  it('derives scene anchors and bodies from the ordered flat block sequence without mutation', () => {
    const blocks = [
      { id: '0bffbc7c-cd70-446d-b87f-7e9d7d09f24c', type: 'action' as const, text: 'A prologue.' },
      ...screenplayFixture.blocks,
    ];
    const before = structuredClone(blocks);

    const scenes = deriveScenes(blocks);

    expect(scenes).toHaveLength(2);
    expect(scenes.map((scene) => scene.id)).toEqual([
      '2175a1b6-8d05-4e6e-bac7-e471e8df33a1',
      '7e00a5b4-e629-42ea-98e7-705ff5ce46b1',
    ]);
    expect(scenes.map((scene) => scene.heading.text)).toEqual([
      'INT. UNION STATION - NIGHT',
      'EXT. UNION STATION - CONTINUOUS',
    ]);
    expect(scenes.map((scene) => scene.body.map((block) => block.type))).toEqual([
      ['action', 'character', 'parenthetical', 'dialogue', 'transition'],
      ['shot', 'dual_dialogue', 'page_break'],
    ]);
    expect(blocks).toEqual(before);
  });

  it('rejects annotations that do not anchor a text block or exceed its text range', () => {
    const unanchored = safeParseScreenplay({
      ...screenplayFixture,
      annotations: [
        {
          ...screenplayFixture.annotations[0],
          anchor: {
            blockId: '0a5e4fa5-6204-4ab0-b4bb-8f5a30af1cb1',
            startOffset: 0,
            endOffset: 1,
          },
        },
      ],
    });
    const outOfRange = safeParseScreenplay({
      ...screenplayFixture,
      annotations: [
        {
          ...screenplayFixture.annotations[0],
          anchor: {
            blockId: 'ba53c2dc-10a6-46d7-a409-9aabbff7cf5d',
            startOffset: 0,
            endOffset: 500,
          },
        },
      ],
    });

    expect(unanchored.success).toBe(false);
    expect(outOfRange.success).toBe(false);
  });

  it('uses UTF-16 code-unit annotation offsets for non-BMP and combining text', () => {
    const text = 'A😀e\u0301';
    const blockId = '0bffbc7c-cd70-446d-b87f-7e9d7d09f24c';
    const valid = safeParseScreenplay({
      ...minimalScreenplayFixture,
      blocks: [{ id: blockId, type: 'action', text }],
      annotations: [
        {
          id: '3ea75b44-f3f4-464a-b196-4ec2aab7372c',
          type: 'note',
          text: 'Emoji and accent.',
          anchor: { blockId, startOffset: 1, endOffset: 5 },
        },
      ],
    });
    const beyondUtf16Length = safeParseScreenplay({
      ...minimalScreenplayFixture,
      blocks: [{ id: blockId, type: 'action', text }],
      annotations: [
        {
          id: '3ea75b44-f3f4-464a-b196-4ec2aab7372c',
          type: 'note',
          text: 'Too long.',
          anchor: { blockId, startOffset: 1, endOffset: 6 },
        },
      ],
    });

    expect(text.length).toBe(5);
    expect(valid.success).toBe(true);
    expect(beyondUtf16Length.success).toBe(false);
  });

  it('rejects duplicate annotation identifiers', () => {
    const result = safeParseScreenplay({
      ...screenplayFixture,
      annotations: [screenplayFixture.annotations[0], screenplayFixture.annotations[0]],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate title-page identifiers', () => {
    const result = safeParseScreenplay({
      ...screenplayFixture,
      titlePages: [screenplayFixture.titlePages[0], screenplayFixture.titlePages[0]],
    });

    expect(result.success).toBe(false);
  });

  it('allows annotations to anchor a nested dialogue-column text block', () => {
    const parsed = parseScreenplay({
      ...screenplayFixture,
      annotations: [
        {
          ...screenplayFixture.annotations[0],
          anchor: {
            blockId: '76b460a1-1e89-45d9-89bd-f006ae87d0d7',
            startOffset: 0,
            endOffset: 3,
          },
        },
      ],
    });

    expect(parsed.annotations[0]?.anchor.blockId).toBe('76b460a1-1e89-45d9-89bd-f006ae87d0d7');
  });

  it('preserves screenplay text exactly instead of normalizing authored content', () => {
    const text = '  A beat.\n\nThen silence.  ';
    const parsed = parseScreenplay({
      ...minimalScreenplayFixture,
      blocks: [{ id: '0bffbc7c-cd70-446d-b87f-7e9d7d09f24c', type: 'action', text }],
    });

    expect(parsed.blocks[0]).toMatchObject({ type: 'action', text });
  });

  it('enforces individual and aggregate authored-text budgets across canonical text fields', () => {
    const invalidId = safeParseScreenplay({ ...minimalScreenplayFixture, id: 'screenplay-1' });
    const oversizedText = safeParseScreenplay({
      ...minimalScreenplayFixture,
      blocks: [
        {
          id: '0bffbc7c-cd70-446d-b87f-7e9d7d09f24c',
          type: 'action',
          text: 'x'.repeat(MAX_AUTHORED_TEXT_LENGTH + 1),
        },
      ],
    });
    const fullTextBlocks = Array.from(
      { length: MAX_TOTAL_AUTHORED_TEXT_LENGTH / MAX_AUTHORED_TEXT_LENGTH - 1 },
      (_, index) => actionBlock(index + 40_000, 'x'.repeat(MAX_AUTHORED_TEXT_LENGTH)),
    );
    const boundary = safeParseScreenplay({
      ...minimalScreenplayFixture,
      title: 'x',
      blocks: [...fullTextBlocks, actionBlock(50_000, 'x'.repeat(MAX_AUTHORED_TEXT_LENGTH - 1))],
    });
    const aggregateOverflow = safeParseScreenplay({
      ...minimalScreenplayFixture,
      title: 'xx',
      blocks: [...fullTextBlocks, actionBlock(50_000, 'x'.repeat(MAX_AUTHORED_TEXT_LENGTH - 1))],
    });

    expect(invalidId.success).toBe(false);
    expect(oversizedText.success).toBe(false);
    expect(boundary.success).toBe(true);
    expect(aggregateOverflow.success).toBe(false);
  });

  it('exposes the schema for consumers that need detailed validation errors', () => {
    expect(screenplaySchema.safeParse(minimalScreenplayFixture).success).toBe(true);
  });

  describe('documentSettings', () => {
    // Every fixture and test-construction site across the codebase predates this field and omits
    // it -- that is deliberate (see the field's comment in index.ts): this is what makes every
    // one of them keep validating unchanged.
    it("defaults to the specification's current fixed values when omitted", () => {
      const { documentSettings, ...withoutDocumentSettings } = minimalScreenplayFixture;
      void documentSettings;

      const parsed = parseScreenplay(withoutDocumentSettings);

      expect(parsed.documentSettings).toEqual(DEFAULT_DOCUMENT_SETTINGS);
    });

    it('accepts an explicit, fully custom, in-bounds set of settings', () => {
      const custom = {
        characterIndentIn: 3.5,
        parentheticalIndentIn: 3.0,
        parentheticalWidthIn: 2.2,
        pageNumberStyle: 'roman' as const,
        sceneNumbersEnabled: true,
        autoMoreContinued: false,
      };

      const parsed = parseScreenplay({ ...minimalScreenplayFixture, documentSettings: custom });

      expect(parsed.documentSettings).toEqual(custom);
    });

    it('rejects an indent left of the physical left margin', () => {
      const result = safeParseScreenplay({
        ...minimalScreenplayFixture,
        documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS, characterIndentIn: MARGIN_LEFT_IN - 0.1 },
      });

      expect(result.success).toBe(false);
    });

    it('rejects a character indent that leaves no room for the cue before the right margin', () => {
      const result = safeParseScreenplay({
        ...minimalScreenplayFixture,
        documentSettings: {
          ...DEFAULT_DOCUMENT_SETTINGS,
          characterIndentIn: PAGE_WIDTH_IN - MARGIN_RIGHT_IN,
        },
      });

      expect(result.success).toBe(false);
    });

    it('rejects a parenthetical width so narrow no text could fit', () => {
      const result = safeParseScreenplay({
        ...minimalScreenplayFixture,
        documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS, parentheticalWidthIn: 0.1 },
      });

      expect(result.success).toBe(false);
    });

    it('rejects a parenthetical indent and width that together cross the right margin, even though each is individually in bounds', () => {
      const rightEdgeIn = PAGE_WIDTH_IN - MARGIN_RIGHT_IN;
      const result = safeParseScreenplay({
        ...minimalScreenplayFixture,
        documentSettings: {
          ...DEFAULT_DOCUMENT_SETTINGS,
          parentheticalIndentIn: rightEdgeIn - 0.5,
          parentheticalWidthIn: 1,
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(['documentSettings', 'parentheticalWidthIn']);
      }
    });

    it('rejects a page-number style outside the two named values', () => {
      const result = safeParseScreenplay({
        ...minimalScreenplayFixture,
        documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS, pageNumberStyle: 'ordinal' },
      });

      expect(result.success).toBe(false);
    });

    it('rejects an unrecognized document-settings key', () => {
      const result = safeParseScreenplay({
        ...minimalScreenplayFixture,
        documentSettings: { ...DEFAULT_DOCUMENT_SETTINGS, dialogueWidthIn: 4 },
      });

      expect(result.success).toBe(false);
    });
  });
});

describe('createDefaultTitlePage', () => {
  const id = uuidFor(1);

  it('holds only real content: the given title and the literal "written by" credit', () => {
    expect(createDefaultTitlePage(id, 'The Last Stop')).toEqual({
      id,
      title: 'The Last Stop',
      credit: 'written by',
    });
  });

  it('omits authors and contact rather than storing placeholder text or an empty array', () => {
    const titlePage = createDefaultTitlePage(id, 'The Last Stop');

    expect(titlePage).not.toHaveProperty('authors');
    expect(titlePage).not.toHaveProperty('contact');
    expect(titlePage).not.toHaveProperty('source');
    expect(titlePage).not.toHaveProperty('draftDate');
  });

  it('validates as a title page on a real screenplay', () => {
    const result = safeParseScreenplay({
      ...minimalScreenplayFixture,
      titlePages: [createDefaultTitlePage(id, 'The Last Stop')],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.titlePages).toEqual([
        { id, title: 'The Last Stop', credit: 'written by' },
      ]);
    }
  });
});

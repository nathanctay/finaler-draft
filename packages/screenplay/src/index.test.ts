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
  deriveCharacters,
  deriveScenes,
  parseScreenplay,
  safeParseScreenplay,
  screenplayBlockSchema,
  screenplaySchema,
  screenplayToPlainText,
} from './index.js';

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function actionBlock(index: number, text = 'x') {
  return { id: uuidFor(index), type: 'action' as const, text };
}

function characterBlock(index: number, text: string) {
  return { id: uuidFor(index), type: 'character' as const, text };
}

function dialogueBlock(index: number, text: string) {
  return { id: uuidFor(index), type: 'dialogue' as const, text };
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
});

describe('deriveCharacters', () => {
  it('derives one character per name, covering both root cues and dual-dialogue cues', () => {
    const characters = deriveCharacters(screenplayFixture.blocks);

    expect(characters.map((character) => character.name)).toEqual(['ADA', 'MILES']);
    expect(characters[0]?.cueBlockIds).toEqual([
      '5e4c810d-75d9-4b2e-a1a2-0f7cb30fd77b',
      'd5a7f0f4-235c-4d3c-8385-b5f7a3a97720',
    ]);
    expect(characters[1]?.cueBlockIds).toEqual(['311e1d44-8a79-42c0-a8f4-ee3a3ec2ddf7']);
  });

  // packages/layout's groups.ts speech grouping, mirrored here: a cue's `blockIds` extend past
  // the cue itself to the parenthetical and dialogue that contiguously follow it, in both the
  // root body (ADA's cue -> its own parenthetical -> its own dialogue, stopping at `transition`)
  // and inside a dual_dialogue column (each cue -> the one dialogue line that follows it,
  // stopping at the column's end). cueBlockIds stays cue-only throughout -- the two fields must
  // not be conflated.
  it("attributes a character's contiguous parenthetical and dialogue blocks, not only its cues", () => {
    const characters = deriveCharacters(screenplayFixture.blocks);

    expect(characters[0]?.name).toBe('ADA');
    expect(characters[0]?.blockIds).toEqual([
      '5e4c810d-75d9-4b2e-a1a2-0f7cb30fd77b', // ADA's root cue
      'c3ca98bb-6720-45b1-85ae-8c851ba2f5be', // its parenthetical
      '0f2b5f3c-6d17-4f18-8d95-90b06e93e13a', // its dialogue
      'd5a7f0f4-235c-4d3c-8385-b5f7a3a97720', // ADA's dual_dialogue left-column cue
      '76b460a1-1e89-45d9-89bd-f006ae87d0d7', // that column's dialogue
    ]);

    expect(characters[1]?.name).toBe('MILES');
    expect(characters[1]?.blockIds).toEqual([
      '311e1d44-8a79-42c0-a8f4-ee3a3ec2ddf7', // MILES's dual_dialogue right-column cue
      'e6e0ff5d-988e-488d-9169-9c90bf9f97e4', // that column's dialogue
    ]);
  });

  it('attributes a parenthetical between the cue and the dialogue to the same character', () => {
    const blocks = [
      characterBlock(480, 'MARA'),
      { id: uuidFor(481), type: 'parenthetical' as const, text: '(beat)' },
      dialogueBlock(482, 'Say it again.'),
    ];

    const characters = deriveCharacters(blocks);

    expect(characters).toHaveLength(1);
    expect(characters[0]?.cueBlockIds).toEqual([uuidFor(480)]);
    expect(characters[0]?.blockIds).toEqual([uuidFor(480), uuidFor(481), uuidFor(482)]);
  });

  // groups.ts's own degenerate case ("openOrphanSpeech"): schema-legal, not real screenplay
  // convention. It must attribute to nobody -- not to whichever character happened to speak
  // last -- because there is no cue to name an owner, and guessing would silently disagree with
  // the paginator the moment the guess was wrong.
  it('attributes an orphan dialogue block (no preceding cue) to nobody, not to the previous speaker', () => {
    const blocks = [
      characterBlock(490, 'MARA'),
      dialogueBlock(491, 'Say it again.'),
      { id: uuidFor(492), type: 'action' as const, text: 'A door slams.' },
      dialogueBlock(493, 'An orphan line, spoken by no one in particular.'),
    ];

    const characters = deriveCharacters(blocks);

    expect(characters).toHaveLength(1);
    expect(characters[0]?.name).toBe('MARA');
    expect(characters[0]?.blockIds).toEqual([uuidFor(490), uuidFor(491)]);
    expect(characters[0]?.blockIds).not.toContain(uuidFor(493));
  });

  it('does not carry a speech across a dual_dialogue column boundary, or in from the root before it', () => {
    const dualDialogue = {
      id: uuidFor(500),
      type: 'dual_dialogue' as const,
      left: {
        id: uuidFor(501),
        blocks: [characterBlock(502, 'ADA'), dialogueBlock(503, 'Go.')],
      },
      right: {
        id: uuidFor(504),
        blocks: [characterBlock(505, 'MILES'), dialogueBlock(506, 'Wait.')],
      },
    };
    // A root-level MARA speech precedes the dual_dialogue block with no closing element between
    // them, which must not leak into the left column's ADA speech.
    const blocks = [characterBlock(507, 'MARA'), dialogueBlock(508, 'Before.'), dualDialogue];

    const characters = deriveCharacters(blocks);

    expect(characters.map((character) => character.name)).toEqual(['MARA', 'ADA', 'MILES']);
    expect(characters[0]?.blockIds).toEqual([uuidFor(507), uuidFor(508)]);
    expect(characters[1]?.blockIds).toEqual([uuidFor(502), uuidFor(503)]);
    expect(characters[2]?.blockIds).toEqual([uuidFor(505), uuidFor(506)]);
  });

  it('does not attribute a root dialogue block after a dual_dialogue to its last column speaker', () => {
    const dualDialogue = {
      id: uuidFor(510),
      type: 'dual_dialogue' as const,
      left: {
        id: uuidFor(511),
        blocks: [characterBlock(512, 'ADA'), dialogueBlock(513, 'Go.')],
      },
      right: {
        id: uuidFor(514),
        blocks: [characterBlock(515, 'MILES'), dialogueBlock(516, 'Wait.')],
      },
    };
    // No character cue between the dual_dialogue block and this trailing dialogue -- it must be
    // an orphan, not silently attributed to MILES because MILES's column happened to close last.
    const blocks = [dualDialogue, dialogueBlock(517, 'An orphan line after the exchange.')];

    const characters = deriveCharacters(blocks);

    const miles = characters.find((character) => character.name === 'MILES');
    expect(miles?.blockIds).toEqual([uuidFor(515), uuidFor(516)]);
    expect(miles?.blockIds).not.toContain(uuidFor(517));
    expect(characters.every((character) => !character.blockIds.includes(uuidFor(517)))).toBe(true);
  });

  it('does not mutate the input blocks', () => {
    const blocks = structuredClone(screenplayFixture.blocks);
    const before = structuredClone(blocks);

    deriveCharacters(blocks);

    expect(blocks).toEqual(before);
  });

  // The likeliest vacuous test for this derivation (per this scope's own progress file) is the
  // grouping: it is not enough that the result list is non-empty, it must be exactly one entry.
  // Includes the stacked form `MARA (V.O.) (CONT'D)` -- the standard rendering of a voice-over
  // that continues across a page break -- because stopping extension-stripping after only the
  // outermost parenthetical would leave it as a distinct fourth entry, splitting a real character
  // silently on any imported script that has this line.
  it("groups a plain cue with its V.O., O.S., and stacked V.O./CONT'D extensions as exactly one character", () => {
    const blocks = [
      characterBlock(400, 'MARA'),
      characterBlock(401, 'MARA (V.O.)'),
      characterBlock(402, 'MARA (O.S.)'),
      characterBlock(403, "MARA (V.O.) (CONT'D)"),
    ];

    const characters = deriveCharacters(blocks);

    expect(characters).toHaveLength(1);
    expect(characters[0]?.name).toBe('MARA');
    expect(characters[0]?.cueBlockIds).toEqual([
      uuidFor(400),
      uuidFor(401),
      uuidFor(402),
      uuidFor(403),
    ]);
  });

  it('normalizes period-less extension spellings to the punctuated form, deduplicated', () => {
    const blocks = [
      characterBlock(410, 'MARA (VO)'),
      characterBlock(411, 'MARA (V.O.)'),
      characterBlock(412, 'MARA (OS)'),
      characterBlock(413, 'MARA (CONTD)'),
    ];

    const characters = deriveCharacters(blocks);

    expect(characters).toHaveLength(1);
    expect(characters[0]?.extensions).toEqual(['V.O.', 'O.S.', "CONT'D"]);
  });

  it('strips an unrecognized trailing parenthetical as an extension without inventing a canonical spelling', () => {
    const blocks = [characterBlock(420, 'MARA (SUBTITLED)')];

    const characters = deriveCharacters(blocks);

    expect(characters).toEqual([
      {
        name: 'MARA',
        extensions: ['SUBTITLED'],
        cueBlockIds: [uuidFor(420)],
        blockIds: [uuidFor(420)],
      },
    ]);
  });

  it('does not treat a parenthetical as an extension unless it is at the end of the line', () => {
    const blocks = [characterBlock(430, 'MARA (LOUD) SCREAMING')];

    const characters = deriveCharacters(blocks);

    expect(characters).toEqual([
      {
        name: 'MARA (LOUD) SCREAMING',
        extensions: [],
        cueBlockIds: [uuidFor(430)],
        blockIds: [uuidFor(430)],
      },
    ]);
  });

  it('strips a stack of trailing parentheticals down to the bare name, in left-to-right order', () => {
    const blocks = [characterBlock(435, "MARA (V.O.) (CONT'D)")];

    const characters = deriveCharacters(blocks);

    expect(characters).toEqual([
      {
        name: 'MARA',
        extensions: ['V.O.', "CONT'D"],
        cueBlockIds: [uuidFor(435)],
        blockIds: [uuidFor(435)],
      },
    ]);
  });

  it('counts every character cue in both columns of a dual_dialogue block, not only the first', () => {
    const dualDialogue = {
      id: uuidFor(440),
      type: 'dual_dialogue' as const,
      left: {
        id: uuidFor(441),
        blocks: [characterBlock(442, 'ADA'), dialogueBlock(443, 'Go.')],
      },
      right: {
        id: uuidFor(444),
        blocks: [
          characterBlock(445, 'MILES'),
          characterBlock(446, "MILES (CONT'D)"),
          dialogueBlock(447, 'Wait.'),
        ],
      },
    };

    const characters = deriveCharacters([dualDialogue]);

    expect(characters.map((character) => character.name)).toEqual(['ADA', 'MILES']);
    expect(characters[1]?.cueBlockIds).toEqual([uuidFor(445), uuidFor(446)]);
  });

  it('preserves first-appearance order across root cues and dual-dialogue cues', () => {
    const dualDialogue = {
      id: uuidFor(450),
      type: 'dual_dialogue' as const,
      left: {
        id: uuidFor(451),
        blocks: [characterBlock(452, 'MILES'), dialogueBlock(453, 'Go.')],
      },
      right: {
        id: uuidFor(454),
        blocks: [characterBlock(455, 'ADA'), dialogueBlock(456, 'Wait.')],
      },
    };
    const blocks = [characterBlock(457, 'ADA'), dualDialogue];

    const characters = deriveCharacters(blocks);

    expect(characters.map((character) => character.name)).toEqual(['ADA', 'MILES']);
  });

  it('skips a character cue with no text at all', () => {
    const blocks = [characterBlock(460, ''), characterBlock(461, 'MARA')];

    const characters = deriveCharacters(blocks);

    expect(characters.map((character) => character.name)).toEqual(['MARA']);
  });

  it('keeps a cue that is only a parenthetical as its own literal name rather than dropping it', () => {
    const blocks = [characterBlock(470, '(V.O.)')];

    const characters = deriveCharacters(blocks);

    expect(characters).toEqual([
      { name: '(V.O.)', extensions: [], cueBlockIds: [uuidFor(470)], blockIds: [uuidFor(470)] },
    ]);
  });
});

describe('screenplaySchema', () => {
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

describe('screenplayToPlainText', () => {
  it('renders every element type at its specified indent, not canonical JSON', () => {
    const text = screenplayToPlainText(screenplayFixture);
    const lines = text.split('\n');

    // Not canonical JSON -- the whole point of "Copy my version" (progress/save-conflict-recovery.md,
    // "Copy my version must actually rescue the work") is that a writer can paste this somewhere
    // useful; `JSON.parse` succeeding here would mean the export regressed to `JSON.stringify`.
    expect(() => JSON.parse(text)).toThrow();
    expect(text).not.toContain('"blocks"');
    expect(text).not.toContain(screenplayFixture.id);

    // Title page: title, then credit+authors, then draft date+contact, one blank line between
    // groups (fixture has no `source`, so that line is correctly absent, not a stray blank).
    expect(lines.slice(0, 7)).toEqual([
      'THE LAST STOP',
      '',
      'Written by',
      'Morgan Vale',
      '',
      'August 2026',
      'morgan@example.test',
    ]);

    // scene_heading and action/shot sit flush with the left margin (0 indent); the scene number
    // is appended, not silently dropped.
    expect(lines).toContain('INT. UNION STATION - NIGHT (scene 1)');
    expect(lines).toContain(
      'Rain presses against the glass ceiling. ADA waits beside a silent departures board.',
    );
    expect(lines).toContain('CLOSE ON the arrival clock as it changes to midnight.');

    // character (22 characters from the margin), parenthetical (16), and dialogue (10) -- see
    // pageFormat.ts's ELEMENT_INDENTS, re-based from the page edge onto the left margin.
    expect(lines).toContain(`${' '.repeat(22)}ADA`);
    expect(lines).toContain(`${' '.repeat(16)}(into her phone)`);
    expect(lines).toContain(`${' '.repeat(10)}I am at the last stop. If you are coming, come now.`);

    // transition right-aligns to the body's right margin (60 characters).
    expect(lines).toContain('CUT TO:'.padStart(60));
    expect(lines.find((line) => line.includes('CUT TO:'))).toHaveLength(60);

    // dual_dialogue: both columns print in full, sequentially, each labelled -- no content lost,
    // even though plain text cannot represent them side by side.
    const leftLabelIndex = lines.indexOf('[Dual dialogue -- spoken together, left column]');
    const rightLabelIndex = lines.indexOf('[Dual dialogue -- spoken together, right column]');
    expect(leftLabelIndex).toBeGreaterThan(-1);
    expect(rightLabelIndex).toBeGreaterThan(leftLabelIndex);
    expect(lines.slice(leftLabelIndex + 1, rightLabelIndex)).toEqual([
      `${' '.repeat(22)}ADA`,
      `${' '.repeat(10)}You made it.`,
      '',
    ]);
    expect(lines.slice(rightLabelIndex + 1, rightLabelIndex + 3)).toEqual([
      `${' '.repeat(22)}MILES`,
      `${' '.repeat(10)}The train was late.`,
    ]);

    // page_break leaves a marker, not silence -- a reader of the plain text can tell a page
    // boundary was there even though nothing about pagination survives into plain text.
    expect(lines).toContain('-- page break --');

    // The note annotation's text is deliberately not part of the manuscript export (this is the
    // rescued screenplay, not the anchored comments on it) -- it must not leak into the output.
    expect(text).not.toContain('Confirm station access.');
  });

  it('keeps a speech contiguous: zero blank lines between character, parenthetical, and dialogue', () => {
    const lines = screenplayToPlainText(screenplayFixture).split('\n');
    const characterIndex = lines.indexOf(`${' '.repeat(22)}ADA`);

    // One blank line separates the preceding action from the character cue (BLANK_LINES_BEFORE),
    // then the parenthetical and dialogue that make up the same speech follow with none at all.
    expect(lines[characterIndex - 1]).toBe('');
    expect(lines[characterIndex - 2]).not.toBe('');
    expect(lines[characterIndex + 1]).toBe(`${' '.repeat(16)}(into her phone)`);
    expect(lines[characterIndex + 2]).toBe(
      `${' '.repeat(10)}I am at the last stop. If you are coming, come now.`,
    );
  });

  it('falls back to the screenplay title when there is no title page', () => {
    expect(screenplayToPlainText(minimalScreenplayFixture)).toBe('Untitled Screenplay\n');
  });

  it('omits an absent scene number rather than inventing one', () => {
    const text = screenplayToPlainText({
      ...minimalScreenplayFixture,
      blocks: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          type: 'scene_heading',
          text: 'INT. HOUSE - DAY',
        },
      ],
    });

    expect(text).toBe('Untitled Screenplay\n\n\nINT. HOUSE - DAY\n');
  });

  it('drops no title-page group and adds no stray blank line when only contact information is present', () => {
    const text = screenplayToPlainText({
      ...minimalScreenplayFixture,
      titlePages: [
        { id: '00000000-0000-4000-8000-000000000002', contact: ['writer@example.test'] },
      ],
    });

    expect(text).toBe('writer@example.test\n');
  });
});

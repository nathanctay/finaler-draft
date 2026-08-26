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
  deriveVocabulary,
  parseScreenplay,
  safeParseScreenplay,
  screenplayBlockSchema,
  screenplaySchema,
  screenplayToPlainText,
  suggest,
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

function sceneHeadingBlock(index: number, text: string) {
  return { id: uuidFor(index), type: 'scene_heading' as const, text };
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

  // The product decision under test: character cues group case-insensitively, and the Navigator
  // always displays the canonical uppercase form -- screenplay convention -- regardless of what
  // the writer actually typed. The writer's own text (the block's `text` field) is never rewritten;
  // only this derived `name` is uppercased. Three differently-cased cues for the same character,
  // one of them carrying a lowercase-spelled extension, must still be exactly one entry.
  it('groups character cues case-insensitively and displays the canonical uppercase name', () => {
    const blocks = [
      characterBlock(600, 'VIVAMUS'),
      characterBlock(601, 'Vivamus'),
      characterBlock(602, 'vivamus (v.o.)'),
    ];

    const characters = deriveCharacters(blocks);

    expect(characters).toHaveLength(1);
    expect(characters[0]?.name).toBe('VIVAMUS');
    expect(characters[0]?.extensions).toEqual(['V.O.']);
    expect(characters[0]?.cueBlockIds).toEqual([uuidFor(600), uuidFor(601), uuidFor(602)]);
    expect(characters[0]?.blockIds).toEqual([uuidFor(600), uuidFor(601), uuidFor(602)]);

    // The writer's literal text is untouched -- uppercasing is display-only, on the derived
    // `name`, never a rewrite of authored content.
    expect(blocks[1]?.text).toBe('Vivamus');
    expect(blocks[2]?.text).toBe('vivamus (v.o.)');
  });

  it('groups mixed-case cues under whichever spelling was cued first, still displayed uppercase', () => {
    const blocks = [characterBlock(610, 'mara'), characterBlock(611, 'MARA')];

    const characters = deriveCharacters(blocks);

    expect(characters).toHaveLength(1);
    expect(characters[0]?.name).toBe('MARA');
    expect(characters[0]?.cueBlockIds).toEqual([uuidFor(610), uuidFor(611)]);
  });

  it('dedupes an unconventional extension case-insensitively, keeping the first-seen spelling', () => {
    const blocks = [
      characterBlock(620, 'MARA (subtitled)'),
      characterBlock(621, 'MARA (SUBTITLED)'),
      characterBlock(622, 'MARA (Subtitled)'),
    ];

    const characters = deriveCharacters(blocks);

    expect(characters).toHaveLength(1);
    expect(characters[0]?.extensions).toEqual(['subtitled']);
  });

  it('still normalizes a lowercase-spelled conventional extension to the punctuated uppercase form', () => {
    const blocks = [characterBlock(630, 'mara (vo)')];

    const characters = deriveCharacters(blocks);

    expect(characters[0]?.name).toBe('MARA');
    expect(characters[0]?.extensions).toEqual(['V.O.']);
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

    // DEFAULT_DOCUMENT_SETTINGS is defined in pageFormat.ts, independently of
    // documentSettingsSchema, so nothing at the type level forces its numeric fields to fall
    // within the schema's min/max bounds or satisfy its cross-field refine. Passing it here as an
    // *explicit* documentSettings value -- rather than relying on the schema's own `.default()`,
    // which the test above exercises -- runs it through every one of those runtime checks
    // directly, so the two definitions can never silently drift apart.
    it("DEFAULT_DOCUMENT_SETTINGS satisfies the schema's own bounds and refinements", () => {
      const result = safeParseScreenplay({
        ...minimalScreenplayFixture,
        documentSettings: DEFAULT_DOCUMENT_SETTINGS,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.documentSettings).toEqual(DEFAULT_DOCUMENT_SETTINGS);
      }
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

describe('deriveVocabulary', () => {
  it('seeds times with the conventional set, in declaration order, when nothing is authored', () => {
    const vocabulary = deriveVocabulary([]);

    expect(vocabulary.locations).toEqual([]);
    expect(vocabulary.characters).toEqual([]);
    expect(vocabulary.times).toEqual([
      { value: 'DAY', count: 0 },
      { value: 'NIGHT', count: 0 },
      { value: 'AFTERNOON', count: 0 },
      { value: 'CONTINUOUS', count: 0 },
      { value: 'LATER', count: 0 },
      { value: 'MOMENTS LATER', count: 0 },
      { value: 'MORNING', count: 0 },
      { value: 'EVENING', count: 0 },
      { value: 'DAWN', count: 0 },
      { value: 'DUSK', count: 0 },
      { value: 'SAME', count: 0 },
      { value: 'SAME TIME', count: 0 },
    ]);
  });

  // Proves the suggestion-side tie-break is conventional commonness (`CONVENTIONAL_PREFIX_ORDER`:
  // INT., EXT., INT./EXT., I/E.), not the parsing-side longest-first matching order
  // (`SCENE_HEADING_PREFIXES`: INT./EXT., I/E., INT., EXT.). A document with nothing authored
  // yet has all four prefixes tied at count 0, so this is exactly the tie-break case, and it
  // fails under either wrong order: matching order, or no seeding at all.
  it('seeds all four prefixes, in conventional-commonness order, when nothing is authored', () => {
    const vocabulary = deriveVocabulary([]);

    expect(vocabulary.prefixes).toEqual([
      { value: 'INT.', count: 0 },
      { value: 'EXT.', count: 0 },
      { value: 'INT./EXT.', count: 0 },
      { value: 'I/E.', count: 0 },
    ]);
  });

  it("counts a heading's matched prefix toward frequency", () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. KITCHEN - DAY')]);

    expect(vocabulary.prefixes.find((prefix) => prefix.value === 'INT.')).toEqual({
      value: 'INT.',
      count: 1,
    });
  });

  // The core of the coordinator's correction: frequency must be able to override conventional
  // commonness. `INT.` is the conventionally common prefix, but this document uses `INT./EXT.`
  // three times and `INT.` only once, so `INT./EXT.` must lead. A suggestion order that ignored
  // authored frequency (declaration order, or the conventional tie-break order applied
  // unconditionally) would rank `INT.` first here; it does not.
  it('ranks a heavily-authored INT./EXT. above a less-authored INT., overriding conventional order', () => {
    const vocabulary = deriveVocabulary([
      sceneHeadingBlock(1, 'INT./EXT. GARAGE - DAY'),
      sceneHeadingBlock(2, 'INT./EXT. GARAGE - NIGHT'),
      sceneHeadingBlock(3, 'INT./EXT. PORCH - DAY'),
      sceneHeadingBlock(4, 'INT. KITCHEN - DAY'),
    ]);

    expect(vocabulary.prefixes.map((prefix) => prefix.value)).toEqual([
      'INT./EXT.',
      'INT.',
      'EXT.',
      'I/E.',
    ]);
    expect(vocabulary.prefixes[0]).toEqual({ value: 'INT./EXT.', count: 3 });
  });

  it('orders equally-frequent authored prefixes by most recently authored', () => {
    const vocabulary = deriveVocabulary([
      sceneHeadingBlock(1, 'EXT. YARD - DAY'),
      sceneHeadingBlock(2, 'INT. KITCHEN - DAY'),
    ]);

    // Both authored once; INT. is authored later, so it leads despite EXT. conventionally
    // ranking above INT./EXT. and I/E. -- but not above INT. once both are equally frequent and
    // INT. is the more recent one.
    expect(vocabulary.prefixes[0]).toEqual({ value: 'INT.', count: 1 });
    expect(vocabulary.prefixes[1]).toEqual({ value: 'EXT.', count: 1 });
  });

  it('matches the longest applicable prefix so INT./EXT. is credited, not INT.', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT./EXT. HALLWAY - DAY')]);

    expect(vocabulary.prefixes.find((prefix) => prefix.value === 'INT./EXT.')?.count).toBe(1);
    expect(vocabulary.prefixes.find((prefix) => prefix.value === 'INT.')?.count).toBe(0);
  });

  it('credits no prefix for a heading with none recognised', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'SOMEWHERE OUT THERE - NIGHT')]);

    expect(vocabulary.prefixes.every((prefix) => prefix.count === 0)).toBe(true);
  });

  it('parses a simple heading into one location and one time', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. KITCHEN - DAY')]);

    expect(vocabulary.locations).toEqual([{ value: 'KITCHEN', count: 1 }]);
    expect(vocabulary.times[0]).toEqual({ value: 'DAY', count: 1 });
  });

  // The central hazard this scope's brief calls out: time is whatever follows the LAST ` - `,
  // not the first. An implementation that split on the first separator would report location
  // `KITCHEN` and time `BACK ROOM - DAY` -- this assertion fails immediately under that mutation.
  it('splits a heading with two separators on the LAST one, not the first', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. KITCHEN - BACK ROOM - DAY')]);

    expect(vocabulary.locations).toEqual([{ value: 'KITCHEN - BACK ROOM', count: 1 }]);
    expect(vocabulary.times[0]).toEqual({ value: 'DAY', count: 1 });
  });

  it('accepts a heading with no recognised prefix and still yields a location', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'SOMEWHERE OUT THERE - NIGHT')]);

    expect(vocabulary.locations).toEqual([{ value: 'SOMEWHERE OUT THERE', count: 1 }]);
    expect(vocabulary.times[0]).toEqual({ value: 'NIGHT', count: 1 });
  });

  it('matches the longest applicable prefix so INT./EXT. is not mistaken for INT.', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT./EXT. HALLWAY - DAY')]);

    expect(vocabulary.locations).toEqual([{ value: 'HALLWAY', count: 1 }]);
  });

  it('yields a location with no time when there is no ` - ` separator at all', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. KITCHEN')]);

    expect(vocabulary.locations).toEqual([{ value: 'KITCHEN', count: 1 }]);
    expect(vocabulary.times.every((time) => time.count === 0)).toBe(true);
  });

  it('does not treat a bare hyphen with no surrounding spaces as a separator', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. KITCHEN-DAY')]);

    expect(vocabulary.locations).toEqual([{ value: 'KITCHEN-DAY', count: 1 }]);
    expect(vocabulary.times.every((time) => time.count === 0)).toBe(true);
  });

  it('still splits when extra whitespace surrounds the separator', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. KITCHEN  -  DAY')]);

    expect(vocabulary.locations).toEqual([{ value: 'KITCHEN', count: 1 }]);
    expect(vocabulary.times[0]).toEqual({ value: 'DAY', count: 1 });
  });

  it('yields no location for an empty location segment but still yields the time', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. - DAY')]);

    expect(vocabulary.locations).toEqual([]);
    expect(vocabulary.times[0]).toEqual({ value: 'DAY', count: 1 });
  });

  it('yields no time for a trailing, incomplete separator', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. KITCHEN -')]);

    expect(vocabulary.locations).toEqual([{ value: 'KITCHEN -', count: 1 }]);
    expect(vocabulary.times.every((time) => time.count === 0)).toBe(true);
  });

  it('yields neither location nor time for a blank heading', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, '   ')]);

    expect(vocabulary.locations).toEqual([]);
    expect(vocabulary.times.every((time) => time.count === 0)).toBe(true);
  });

  it('yields neither location nor time for a heading that is only a recognised prefix', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT.')]);

    expect(vocabulary.locations).toEqual([]);
    expect(vocabulary.times.every((time) => time.count === 0)).toBe(true);
  });

  it('dedupes locations case-insensitively regardless of casing, with a combined count', () => {
    const vocabulary = deriveVocabulary([
      sceneHeadingBlock(1, 'INT. Kitchen - DAY'),
      sceneHeadingBlock(2, 'EXT. KITCHEN - NIGHT'),
    ]);

    // Still one term, count 2 -- dedup and counting are unaffected by canonicalizing the display
    // value to uppercase (see the 'canonicalizes an authored location/time to uppercase' tests
    // below for the casing itself).
    expect(vocabulary.locations).toEqual([{ value: 'KITCHEN', count: 2 }]);
  });

  // The user's ruling on this scope: screenplay convention is uppercase throughout a scene
  // heading, and accepting is always an explicit Tab, never a silent rewrite -- so the vocabulary
  // offers the conventional casing regardless of how the writer actually typed it. A location or
  // time authored in lowercase (or any mixed case) is offered back canonically uppercased, the
  // same as a character cue already is.
  it('canonicalizes an authored location and time to uppercase, regardless of authored casing', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'int. kitchen - dusk')]);

    expect(vocabulary.locations).toEqual([{ value: 'KITCHEN', count: 1 }]);
    expect(vocabulary.times[0]).toEqual({ value: 'DUSK', count: 1 });
  });

  it('canonicalizes a lowercase authored time that duplicates an already-uppercase seed', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. KITCHEN - day')]);

    // Not a new, separately-cased entry -- folds into the existing 'DAY' seed, which was already
    // uppercase, so this is really a regression guard: uppercasing authored terms must not
    // somehow produce two entries where dedup used to produce one.
    expect(vocabulary.times).toHaveLength(6);
    expect(vocabulary.times[0]).toEqual({ value: 'DAY', count: 1 });
  });

  // The user's own words: "what we store canonically is whatever the writer typed." Uppercasing
  // is confined to the derived vocabulary; the canonical blocks the writer authored must come
  // back byte-identical, lowercase and all, proving `deriveVocabulary` never mutates its input
  // (directly or by returning aliases into it) and nothing in this module has any path back to
  // rewriting a document.
  it('never rewrites the canonical blocks it reads: the authored lowercase heading is untouched', () => {
    const blocks = [sceneHeadingBlock(1, 'int. kitchen - dusk')];
    const snapshot = JSON.parse(JSON.stringify(blocks)) as typeof blocks;

    deriveVocabulary(blocks);

    expect(blocks).toEqual(snapshot);
    expect(blocks[0]?.text).toBe('int. kitchen - dusk');
  });

  it('folds an authored time into its matching seed rather than duplicating it', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. KITCHEN - day')]);

    // Still six entries, not seven: 'day' folded into the 'DAY' seed instead of adding a
    // separate, differently-cased entry.
    expect(vocabulary.times).toHaveLength(6);
    expect(vocabulary.times[0]).toEqual({ value: 'DAY', count: 1 });
  });

  it('adds a novel time not in the seeded set', () => {
    const vocabulary = deriveVocabulary([sceneHeadingBlock(1, 'INT. KITCHEN - DAWN')]);

    expect(vocabulary.times).toHaveLength(7);
    expect(vocabulary.times[0]).toEqual({ value: 'DAWN', count: 1 });
  });

  // Proves "most frequent first": KITCHEN is authored twice, LOBBY once and more recently. If
  // ordering were recency-first (or count ascending), LOBBY would lead; it does not.
  it('orders locations by frequency first, most authored winning over most recent', () => {
    const vocabulary = deriveVocabulary([
      sceneHeadingBlock(1, 'INT. KITCHEN - DAY'),
      sceneHeadingBlock(2, 'INT. KITCHEN - NIGHT'),
      sceneHeadingBlock(3, 'INT. LOBBY - DAY'),
    ]);

    expect(vocabulary.locations.map((location) => location.value)).toEqual(['KITCHEN', 'LOBBY']);
  });

  // Proves "ties broken by most recently authored": KITCHEN and LOBBY are each authored once,
  // but LOBBY is authored later. If ties were broken by first-authored (or not at all), KITCHEN
  // would lead.
  it('orders equally-frequent locations by most recently authored', () => {
    const vocabulary = deriveVocabulary([
      sceneHeadingBlock(1, 'INT. KITCHEN - DAY'),
      sceneHeadingBlock(2, 'INT. LOBBY - DAY'),
    ]);

    expect(vocabulary.locations.map((location) => location.value)).toEqual(['LOBBY', 'KITCHEN']);
  });

  it('reuses deriveCharacters for the character vocabulary, in canonical uppercase', () => {
    const vocabulary = deriveVocabulary(screenplayFixture.blocks);

    expect(vocabulary.characters).toEqual([
      { value: 'ADA', count: 2 },
      { value: 'MILES', count: 1 },
    ]);
  });

  it('counts a character cued inside a dual_dialogue column toward frequency and recency', () => {
    const vocabulary = deriveVocabulary([
      sceneHeadingBlock(1, 'INT. KITCHEN - DAY'),
      characterBlock(2, 'ADA'),
      dialogueBlock(3, 'Hello.'),
      {
        id: uuidFor(4),
        type: 'dual_dialogue' as const,
        left: {
          id: uuidFor(5),
          blocks: [characterBlock(6, 'MILES'), dialogueBlock(7, 'Hi.')],
        },
        right: {
          id: uuidFor(8),
          blocks: [characterBlock(9, 'ADA'), dialogueBlock(10, 'Hey.')],
        },
      },
    ]);

    // ADA is cued twice (root, then the dual_dialogue right column) and MILES once, but MILES's
    // one cue lands after ADA's root cue and before ADA's second cue -- so by frequency alone ADA
    // leads regardless of where MILES's single cue falls in that ordering.
    expect(vocabulary.characters).toEqual([
      { value: 'ADA', count: 2 },
      { value: 'MILES', count: 1 },
    ]);
  });
});

describe('suggest', () => {
  // Deliberately in an order that matches neither `SCENE_HEADING_PREFIXES` (longest-first, for
  // parsing) nor `CONVENTIONAL_PREFIX_ORDER` (the tie-break for an unauthored document) --
  // `suggest` must pass through whatever order `vocabulary.prefixes` gives it, not silently
  // re-derive an order from either fixed constant.
  const vocabulary = {
    prefixes: [
      { value: 'EXT.', count: 3 },
      { value: 'I/E.', count: 2 },
      { value: 'INT./EXT.', count: 1 },
      { value: 'INT.', count: 0 },
    ],
    locations: [
      { value: 'KITCHEN', count: 3 },
      { value: 'KITCHEN - BACK ROOM', count: 1 },
      { value: 'LOBBY', count: 1 },
    ],
    times: [
      { value: 'DAY', count: 4 },
      { value: 'NIGHT', count: 2 },
      { value: 'DAWN', count: 0 },
    ],
    characters: [
      { value: 'MARA', count: 5 },
      { value: 'MILES', count: 2 },
    ],
  };

  it('suggests nothing for an element SmartType does not support', () => {
    for (const elementType of [
      'action',
      'dialogue',
      'parenthetical',
      'transition',
      'shot',
    ] as const) {
      expect(suggest(elementType, 'anything', vocabulary)).toEqual([]);
    }
  });

  it('suggests every prefix, in vocabulary order, when nothing has been typed', () => {
    // Order comes from `vocabulary.prefixes` (this fixture), not from `SCENE_HEADING_PREFIXES`'s
    // matching order and not from `CONVENTIONAL_PREFIX_ORDER`'s tie-break order -- both would
    // produce a different sequence than this fixture's, so either mistake fails this assertion.
    expect(suggest('scene_heading', '', vocabulary)).toEqual([
      { insertText: 'EXT.', remainder: 'EXT.', matchedLength: 0 },
      { insertText: 'I/E.', remainder: 'I/E.', matchedLength: 0 },
      { insertText: 'INT./EXT.', remainder: 'INT./EXT.', matchedLength: 0 },
      { insertText: 'INT.', remainder: 'INT.', matchedLength: 0 },
    ]);
  });

  it('filters prefixes case-insensitively by what has been typed so far, preserving vocabulary order', () => {
    const candidates = suggest('scene_heading', 'i', vocabulary);

    // 'EXT.' (first in vocabulary order) does not start with 'I' and is excluded; the remaining
    // three keep their relative vocabulary order.
    expect(candidates.map((candidate) => candidate.insertText)).toEqual([
      'I/E.',
      'INT./EXT.',
      'INT.',
    ]);
    expect(candidates[0]).toEqual({
      insertText: 'I/E.',
      remainder: '/E.',
      matchedLength: 1,
    });
  });

  it('suggests locations, pre-sorted by frequency then recency, once a prefix and space are typed', () => {
    const candidates = suggest('scene_heading', 'INT. ', vocabulary);

    expect(candidates.map((candidate) => candidate.insertText)).toEqual([
      'KITCHEN',
      'KITCHEN - BACK ROOM',
      'LOBBY',
    ]);
    // Matched length excludes the "INT. " the writer already has right -- accepting only
    // replaces the (empty, here) partial location, never the prefix or its trailing space.
    expect(candidates[0]?.matchedLength).toBe(0);
  });

  it('filters locations by what has been typed after the prefix, preserving vocabulary order', () => {
    const candidates = suggest('scene_heading', 'INT. KIT', vocabulary);

    // Both offered: 'KITCHEN - BACK ROOM' also starts with 'KIT', case-insensitively. Order is
    // preserved from `vocabulary.locations` (frequency-then-recency order), not re-sorted here.
    expect(candidates).toEqual([
      { insertText: 'KITCHEN', remainder: 'CHEN', matchedLength: 3 },
      { insertText: 'KITCHEN - BACK ROOM', remainder: 'CHEN - BACK ROOM', matchedLength: 3 },
    ]);
  });

  it('filters locations to an exact match once the full location has been typed', () => {
    const candidates = suggest('scene_heading', 'INT. LOBBY', vocabulary);

    expect(candidates).toEqual([{ insertText: 'LOBBY', remainder: '', matchedLength: 5 }]);
  });

  it('does not fuzzy-match: a location missing its first letter is not offered', () => {
    expect(suggest('scene_heading', 'INT. ITCHEN', vocabulary)).toEqual([]);
  });

  it('suggests times after the last separator, filtering out an already-typed prefix and location', () => {
    const candidates = suggest('scene_heading', 'INT. KITCHEN - ', vocabulary);

    expect(candidates.map((candidate) => candidate.insertText)).toEqual(['DAY', 'NIGHT', 'DAWN']);
  });

  it('uses the LAST separator to find the time zone when a location itself contains one', () => {
    const candidates = suggest('scene_heading', 'INT. KITCHEN - BACK ROOM - D', vocabulary);

    // 'DAWN' also starts with 'D'; both are offered, DAY first (it is more frequent).
    expect(candidates).toEqual([
      { insertText: 'DAY', remainder: 'AY', matchedLength: 1 },
      { insertText: 'DAWN', remainder: 'AWN', matchedLength: 1 },
    ]);
  });

  it('suggests characters, case-insensitively, in a character block', () => {
    const candidates = suggest('character', 'ma', vocabulary);

    expect(candidates).toEqual([{ insertText: 'MARA', remainder: 'RA', matchedLength: 2 }]);
  });

  it('offers a candidate that corrects case even when there is no remainder to preview', () => {
    const candidates = suggest('character', 'mara', vocabulary);

    expect(candidates).toEqual([{ insertText: 'MARA', remainder: '', matchedLength: 4 }]);

    // Accepting replaces exactly `matchedLength` characters before the caret with `insertText`,
    // which is what turns the writer's lowercase `mara` into the canonical `MARA`.
    const candidate = candidates[0]!;
    const textBeforeCaret = 'mara';
    const accepted =
      textBeforeCaret.slice(0, textBeforeCaret.length - candidate.matchedLength) +
      candidate.insertText;
    expect(accepted).toBe('MARA');
  });

  it('suggests nothing in a character block when nothing authored matches', () => {
    expect(suggest('character', 'zzz', vocabulary)).toEqual([]);
  });

  it('does not throw on empty text, whitespace-only text, or unmatched text', () => {
    expect(() => suggest('scene_heading', '', vocabulary)).not.toThrow();
    expect(() => suggest('character', '   ', vocabulary)).not.toThrow();
    expect(suggest('scene_heading', 'ZZZ', vocabulary)).toEqual([]);
    expect(
      suggest('character', '', { prefixes: [], locations: [], times: [], characters: [] }),
    ).toEqual([]);
  });

  it('composes with deriveVocabulary end to end: accept reproduces the canonical heading', () => {
    const vocab = deriveVocabulary([
      sceneHeadingBlock(1, 'INT. KITCHEN - DAY'),
      sceneHeadingBlock(2, 'INT. KITCHEN - NIGHT'),
    ]);

    const textBeforeCaret = 'INT. KIT';
    const candidate = suggest('scene_heading', textBeforeCaret, vocab)[0]!;
    const accepted =
      textBeforeCaret.slice(0, textBeforeCaret.length - candidate.matchedLength) +
      candidate.insertText;

    expect(accepted).toBe('INT. KITCHEN');
  });

  it('composes with deriveVocabulary end to end: a document heavy in INT./EXT. suggests it first', () => {
    const vocab = deriveVocabulary([
      sceneHeadingBlock(1, 'INT./EXT. GARAGE - DAY'),
      sceneHeadingBlock(2, 'INT./EXT. GARAGE - NIGHT'),
      sceneHeadingBlock(3, 'INT./EXT. PORCH - DAY'),
      sceneHeadingBlock(4, 'INT. KITCHEN - DAY'),
    ]);

    // Documentary-style scripts that are mostly INT./EXT. get INT./EXT. suggested first, not the
    // conventionally more common INT. -- this document's own authored frequency wins.
    const candidates = suggest('scene_heading', '', vocab);
    expect(candidates[0]).toEqual({
      insertText: 'INT./EXT.',
      remainder: 'INT./EXT.',
      matchedLength: 0,
    });
  });

  it('composes with deriveVocabulary end to end: a lowercase-authored time is offered uppercase', () => {
    const vocab = deriveVocabulary([sceneHeadingBlock(1, 'int. kitchen - dusk')]);

    const candidates = suggest('scene_heading', 'INT. KITCHEN - du', vocab);

    expect(candidates).toEqual([{ insertText: 'DUSK', remainder: 'SK', matchedLength: 2 }]);
  });
});

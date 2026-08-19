import { z } from 'zod';
import { ELEMENT_INDENTS, MARGIN_LEFT_IN, PAGE_WIDTH_IN, MARGIN_RIGHT_IN } from './pageFormat.js';

export const SCREENPLAY_SCHEMA_VERSION = 1 as const;
export const MAX_SCREENPLAY_TITLE_LENGTH = 250;
export const MAX_TITLE_PAGES = 10;
export const MAX_TITLE_PAGE_LINES = 20;
export const MAX_SCENE_NUMBER_LENGTH = 32;
export const MAX_AUTHORED_TEXT_LENGTH = 20_000;
export const MAX_TOTAL_AUTHORED_TEXT_LENGTH = 1_500_000;
export const MAX_ROOT_BLOCKS = 10_000;
export const MAX_ANNOTATIONS = 10_000;
export const MAX_DUAL_DIALOGUE_COLUMN_BLOCKS = 100;
export const MAX_CANONICAL_NODES = 25_000;

const stableIdSchema = z.string().uuid();
const screenplayTextSchema = z.string().max(MAX_AUTHORED_TEXT_LENGTH);
const titleSchema = z.string().min(1).max(MAX_SCREENPLAY_TITLE_LENGTH);

const titlePageSchema = z
  .object({
    id: stableIdSchema,
    title: titleSchema.optional(),
    authors: z.array(screenplayTextSchema).max(MAX_TITLE_PAGE_LINES).optional(),
    credit: screenplayTextSchema.optional(),
    source: screenplayTextSchema.optional(),
    draftDate: screenplayTextSchema.optional(),
    contact: z.array(screenplayTextSchema).max(MAX_TITLE_PAGE_LINES).optional(),
  })
  .strict();

/**
 * plan.md's "Document settings" section: "These values are document state, not application
 * preferences. They live in the canonical screenplay, travel with it through export and import,
 * and are inputs to the layout package." Only the six values that section lists as adjustable are
 * here -- plan.md is explicit that the typeface, type size, and pitch are "not adjustable, ever,"
 * and (separately, in "Element indents") that action/dialogue/scene-heading/shot widths are
 * specification, not settings. Only `character`'s indent and `parenthetical`'s indent and width
 * move; everything else in `ELEMENT_INDENTS` stays fixed.
 *
 * No field is optional: a screenplay either has a complete, valid set of document settings or
 * none of this validates. Partial settings would leave pagination to guess at what wasn't
 * specified, which is exactly the kind of silent, ambiguous behavior schema validation elsewhere
 * in this file exists to prevent.
 */
const MAX_ADJUSTABLE_INDENT_IN = PAGE_WIDTH_IN - MARGIN_RIGHT_IN;

/**
 * Sanity floors, not specification values: plan.md places no lower bound on how far a writer may
 * push these (the parenthetical-indent-vs-character-indent warning it does specify is a UI
 * warning, not a schema constraint -- "A warning, not a block"). These exist only to reject a
 * setting so extreme no element could hold any text at all, which would otherwise let a
 * malformed or adversarial document setting silently corrupt every page's pagination.
 */
const MIN_CHARACTER_CUE_ROOM_IN = 1; // room for at least ten characters before the right margin
const MIN_PARENTHETICAL_ROOM_IN = 0.3; // room for at least three characters

function requiredElementIndentValue(
  element: keyof typeof ELEMENT_INDENTS,
  field: 'leftIn' | 'widthIn',
): number {
  const value = ELEMENT_INDENTS[element][field];
  if (value === undefined) {
    throw new Error(
      `ELEMENT_INDENTS.${element}.${field} is unset; the document-settings default derivation is stale.`,
    );
  }
  return value;
}

const documentSettingsSchema = z
  .object({
    characterIndentIn: z
      .number()
      .min(MARGIN_LEFT_IN)
      .max(MAX_ADJUSTABLE_INDENT_IN - MIN_CHARACTER_CUE_ROOM_IN),
    parentheticalIndentIn: z
      .number()
      .min(MARGIN_LEFT_IN)
      .max(MAX_ADJUSTABLE_INDENT_IN - MIN_PARENTHETICAL_ROOM_IN),
    parentheticalWidthIn: z
      .number()
      .min(MIN_PARENTHETICAL_ROOM_IN)
      .max(MAX_ADJUSTABLE_INDENT_IN - MARGIN_LEFT_IN),
    // "Roman numerals are available as a document setting" (plan.md, "Page numbering"). Position
    // is deliberately not a field here -- plan.md's "Page numbering" section states only a fixed
    // top-right position with no alternative ever described, which does not match "Document
    // settings"' listing of "page-number position" as adjustable. Treated as an unresolved
    // discrepancy in plan.md rather than an invented control; see this scope's progress log.
    pageNumberStyle: z.enum(['arabic', 'roman']),
    sceneNumbersEnabled: z.boolean(),
    autoMoreContinued: z.boolean(),
  })
  .strict()
  .refine(
    (settings) =>
      settings.parentheticalIndentIn + settings.parentheticalWidthIn <= MAX_ADJUSTABLE_INDENT_IN,
    {
      message: 'Parenthetical indent plus width must not cross the right margin.',
      path: ['parentheticalWidthIn'],
    },
  );

export type DocumentSettings = z.infer<typeof documentSettingsSchema>;

/**
 * The specification's current fixed values, unchanged from `pageFormat.ts`'s `ELEMENT_INDENTS`
 * and the `(MORE)`/`CONT'D` and scene-number defaults plan.md states directly ("disabled by
 * default" for scene numbers; "defaulting to on" for automatic `(MORE)`/`CONT'D`). Every new
 * screenplay gets these, so existing pagination behavior is unchanged until a writer -- or,
 * before the document-settings dialog exists, a direct API caller -- sets something different.
 */
export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  characterIndentIn: requiredElementIndentValue('character', 'leftIn'),
  parentheticalIndentIn: requiredElementIndentValue('parenthetical', 'leftIn'),
  parentheticalWidthIn: requiredElementIndentValue('parenthetical', 'widthIn'),
  pageNumberStyle: 'arabic',
  sceneNumbersEnabled: false,
  autoMoreContinued: true,
};

const sceneHeadingSchema = z
  .object({
    id: stableIdSchema,
    type: z.literal('scene_heading'),
    text: screenplayTextSchema,
    sceneNumber: z.string().min(1).max(MAX_SCENE_NUMBER_LENGTH).optional(),
  })
  .strict();

const textBlockSchemas = [
  z.object({ id: stableIdSchema, type: z.literal('action'), text: screenplayTextSchema }).strict(),
  z
    .object({ id: stableIdSchema, type: z.literal('character'), text: screenplayTextSchema })
    .strict(),
  z
    .object({ id: stableIdSchema, type: z.literal('dialogue'), text: screenplayTextSchema })
    .strict(),
  z
    .object({ id: stableIdSchema, type: z.literal('parenthetical'), text: screenplayTextSchema })
    .strict(),
  z
    .object({ id: stableIdSchema, type: z.literal('transition'), text: screenplayTextSchema })
    .strict(),
  z.object({ id: stableIdSchema, type: z.literal('shot'), text: screenplayTextSchema }).strict(),
] as const;

const dialogueColumnBlockSchema = z.discriminatedUnion('type', [
  textBlockSchemas[1],
  textBlockSchemas[2],
  textBlockSchemas[3],
]);

const dialogueColumnSchema = z
  .object({
    id: stableIdSchema,
    blocks: z.array(dialogueColumnBlockSchema).min(1).max(MAX_DUAL_DIALOGUE_COLUMN_BLOCKS),
  })
  .strict()
  .superRefine((column, context) => {
    if (column.blocks[0]?.type !== 'character') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A dual-dialogue column must begin with a character block.',
        path: ['blocks', 0],
      });
    }

    if (!column.blocks.some((block) => block.type === 'dialogue')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A dual-dialogue column must contain at least one dialogue block.',
        path: ['blocks'],
      });
    }
  });

const dualDialogueSchema = z
  .object({
    id: stableIdSchema,
    type: z.literal('dual_dialogue'),
    left: dialogueColumnSchema,
    right: dialogueColumnSchema,
  })
  .strict();

const pageBreakSchema = z.object({ id: stableIdSchema, type: z.literal('page_break') }).strict();

export const screenplayBlockSchema = z.discriminatedUnion('type', [
  sceneHeadingSchema,
  ...textBlockSchemas,
  dualDialogueSchema,
  pageBreakSchema,
]);

export type ScreenplayBlock = z.infer<typeof screenplayBlockSchema>;
export type DialogueColumn = z.infer<typeof dialogueColumnSchema>;
export type TitlePage = z.infer<typeof titlePageSchema>;
export type SceneHeadingBlock = z.infer<typeof sceneHeadingSchema>;

/**
 * The title page a new screenplay is given by default, per plan.md's "Title page" section: "A
 * new screenplay gets a dedicated title page by default." Stores only real content, never a
 * placeholder string a writer must remember to overwrite before it round-trips or prints:
 *
 *  - `title` is the screenplay title the writer already supplied at creation -- the correct
 *    value, not a placeholder.
 *  - `credit` is the literal "written by", standard on essentially every screenplay and not
 *    specific to any one document.
 *  - `authors` and `contact` start absent, not `[]`. The editor renders a placeholder hint on the
 *    empty field -- the same `:empty::after` convention `styles.css` already uses for empty
 *    screenplay text blocks -- rather than storing literal text like "Author name" that would
 *    round-trip and print as real content if the writer never touches it. Omitting the keys
 *    (rather than `[]`) also matches the convention `apps/web/src/titlePageEditor.ts` uses when
 *    projecting the title-page editor's state back to canonical form ("no entries" -> key
 *    omitted), so a freshly created title page round-trips through the editor unchanged even
 *    before a writer adds an author or contact line.
 */
export function createDefaultTitlePage(id: string, title: string): TitlePage {
  return { id, title, credit: 'written by' };
}

/** A JavaScript string index, measured in UTF-16 code units. */
export type Utf16CodeUnitOffset = number;

export type AnnotationAnchor = {
  blockId: string;
  startOffset: Utf16CodeUnitOffset;
  endOffset: Utf16CodeUnitOffset;
};

export type DerivedScene = {
  id: string;
  heading: SceneHeadingBlock;
  body: readonly ScreenplayBlock[];
};

/**
 * Derives scenes from the ordered canonical body without changing it.
 * Blocks before the first scene heading do not belong to a derived scene.
 */
export function deriveScenes(blocks: readonly ScreenplayBlock[]): DerivedScene[] {
  const scenes: DerivedScene[] = [];
  let currentScene: { id: string; heading: SceneHeadingBlock; body: ScreenplayBlock[] } | undefined;

  for (const block of blocks) {
    if (block.type === 'scene_heading') {
      currentScene = { id: block.id, heading: block, body: [] };
      scenes.push(currentScene);
    } else {
      currentScene?.body.push(block);
    }
  }

  return scenes;
}

function collectBlockIds(block: ScreenplayBlock): string[] {
  if (block.type !== 'dual_dialogue') {
    return [block.id];
  }

  return [
    block.id,
    block.left.id,
    ...block.left.blocks.map(({ id }) => id),
    block.right.id,
    ...block.right.blocks.map(({ id }) => id),
  ];
}

function countCanonicalNodes(block: ScreenplayBlock): number {
  if (block.type !== 'dual_dialogue') {
    return 1;
  }

  return 3 + block.left.blocks.length + block.right.blocks.length;
}

function collectTextLengths(block: ScreenplayBlock): Map<string, number> {
  if (block.type === 'dual_dialogue') {
    return new Map([
      ...block.left.blocks.map(({ id, text }) => [id, text.length] as const),
      ...block.right.blocks.map(({ id, text }) => [id, text.length] as const),
    ]);
  }

  if (block.type === 'page_break') {
    return new Map();
  }

  return new Map([[block.id, block.text.length]]);
}

function collectBlockAuthoredTextLength(block: ScreenplayBlock): number {
  if (block.type === 'dual_dialogue') {
    return [...block.left.blocks, ...block.right.blocks].reduce(
      (total, dialogueBlock) => total + dialogueBlock.text.length,
      0,
    );
  }

  if (block.type === 'page_break') {
    return 0;
  }

  return (
    block.text.length + (block.type === 'scene_heading' ? (block.sceneNumber?.length ?? 0) : 0)
  );
}

function collectTitlePageAuthoredTextLength(titlePage: TitlePage): number {
  return [
    titlePage.title,
    ...(titlePage.authors ?? []),
    titlePage.credit,
    titlePage.source,
    titlePage.draftDate,
    ...(titlePage.contact ?? []),
  ].reduce((total, text) => total + (text?.length ?? 0), 0);
}

const annotationSchema = z
  .object({
    id: stableIdSchema,
    type: z.literal('note'),
    text: screenplayTextSchema,
    anchor: z
      .object({
        blockId: stableIdSchema,
        startOffset: z.number().int().nonnegative(),
        endOffset: z.number().int().nonnegative(),
      })
      .strict()
      .refine(({ startOffset, endOffset }) => endOffset >= startOffset, {
        message: 'Annotation endOffset must be greater than or equal to startOffset.',
        path: ['endOffset'],
      }),
  })
  .strict();

export type Annotation = Omit<z.infer<typeof annotationSchema>, 'anchor'> & {
  anchor: AnnotationAnchor;
};

export const screenplaySchema = z
  .object({
    schemaVersion: z.literal(SCREENPLAY_SCHEMA_VERSION),
    id: stableIdSchema,
    title: titleSchema,
    titlePages: z.array(titlePageSchema).max(MAX_TITLE_PAGES),
    // Defaulted, not required: nothing writes a real (dialog-set) value yet -- the editor round
    // trip, the layout package, and the document-settings dialog itself are later increments of
    // this same scope (see progress/title-page-and-document-settings.md) -- so every existing
    // construction site across the codebase that predates this field keeps validating unchanged,
    // getting the specification's current fixed values exactly as if this field didn't exist yet.
    documentSettings: documentSettingsSchema.default(() => ({ ...DEFAULT_DOCUMENT_SETTINGS })),
    blocks: z.array(screenplayBlockSchema).max(MAX_ROOT_BLOCKS),
    annotations: z.array(annotationSchema).max(MAX_ANNOTATIONS),
  })
  .strict()
  .superRefine((screenplay, context) => {
    const seenStableIds = new Set<string>();
    const textLengths = new Map<string, number>();

    const registerStableId = (id: string, path: (string | number)[]) => {
      if (seenStableIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Stable id ${id} must be globally unique within a screenplay.`,
          path,
        });
      }
      seenStableIds.add(id);
    };

    registerStableId(screenplay.id, ['id']);

    for (const [titlePageIndex, titlePage] of screenplay.titlePages.entries()) {
      registerStableId(titlePage.id, ['titlePages', titlePageIndex, 'id']);
    }

    screenplay.blocks.forEach((block, blockIndex) => {
      for (const id of collectBlockIds(block)) {
        registerStableId(id, ['blocks', blockIndex]);
      }
      for (const [id, textLength] of collectTextLengths(block)) {
        textLengths.set(id, textLength);
      }
    });

    for (const [annotationIndex, annotation] of screenplay.annotations.entries()) {
      registerStableId(annotation.id, ['annotations', annotationIndex, 'id']);

      const textLength = textLengths.get(annotation.anchor.blockId);
      if (textLength === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Annotation anchor block ${annotation.anchor.blockId} must reference a text block.`,
          path: ['annotations', annotationIndex, 'anchor', 'blockId'],
        });
      } else if (annotation.anchor.endOffset > textLength) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Annotation endOffset must not exceed the anchored block text length (${textLength}).`,
          path: ['annotations', annotationIndex, 'anchor', 'endOffset'],
        });
      }
    }

    const authoredTextLength =
      screenplay.title.length +
      screenplay.titlePages.reduce(
        (total, titlePage) => total + collectTitlePageAuthoredTextLength(titlePage),
        0,
      ) +
      screenplay.blocks.reduce((total, block) => total + collectBlockAuthoredTextLength(block), 0) +
      screenplay.annotations.reduce((total, annotation) => total + annotation.text.length, 0);

    const canonicalNodeCount = screenplay.blocks.reduce(
      (total, block) => total + countCanonicalNodes(block),
      0,
    );

    if (canonicalNodeCount > MAX_CANONICAL_NODES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Canonical screenplay nodes must not exceed ${MAX_CANONICAL_NODES}.`,
        path: ['blocks'],
      });
    }

    if (authoredTextLength > MAX_TOTAL_AUTHORED_TEXT_LENGTH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Total authored text must not exceed ${MAX_TOTAL_AUTHORED_TEXT_LENGTH} UTF-16 code units.`,
        path: [],
      });
    }
  });

export type Screenplay = z.infer<typeof screenplaySchema>;

export function parseScreenplay(input: unknown): Screenplay {
  return screenplaySchema.parse(input);
}

export function safeParseScreenplay(input: unknown) {
  return screenplaySchema.safeParse(input);
}

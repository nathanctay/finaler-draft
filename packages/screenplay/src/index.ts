import { z } from 'zod';
import {
  BLANK_LINES_BEFORE,
  BODY_WIDTH_CHARACTERS,
  ELEMENT_INDENTS,
  MARGIN_LEFT_IN,
  NOMINAL_CHARACTERS_PER_INCH,
  PAGE_WIDTH_IN,
  MARGIN_RIGHT_IN,
  type ScreenplayElementKind,
} from './pageFormat.js';

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

export type DerivedCharacter = {
  /**
   * The extension-stripped, normalized grouping key. plan.md's "Character names and extensions":
   * "`MARA`, `MARA (V.O.)`, and `MARA (O.S.)` are one character, not three" -- this is the one
   * name they group under.
   */
  name: string;
  /**
   * Every extension this character was cued with, normalized and deduplicated in first-seen
   * order; empty when the character is never cued with a parenthetical. plan.md: "accept the
   * period-less spellings on import but normalise on output" -- `(VO)` and `(V.O.)` both
   * contribute the single normalized entry `'V.O.'` here, never two.
   */
  extensions: readonly string[];
  /**
   * Every character-cue block id naming this character, in document order, including both
   * columns of any `dual_dialogue` block. A cue only -- not the dialogue or parentheticals that
   * follow it. Used for navigation: the Navigator jumps to `cueBlockIds[0]`.
   */
  cueBlockIds: readonly string[];
  /**
   * Every block id attributed to this character: each id in `cueBlockIds`, plus the contiguous
   * run of `parenthetical`/`dialogue` blocks that follows it, ending at the first block that is
   * neither -- a superset of `cueBlockIds`, in document order. This is the same "speech" grouping
   * `packages/layout`'s `groups.ts` (`buildGroups`) uses for pagination ("a character cue plus
   * its contiguous parentheticals and dialogue"), deliberately reused rather than reinvented: if
   * the Navigator and the paginator ever disagreed about which character owns a line, the
   * Navigator would be wrong. A `parenthetical`/`dialogue` block with no preceding cue in its own
   * contiguous run (schema-legal, not real screenplay convention -- `groups.ts` calls this an
   * orphan speech) attributes to nobody, matching `groups.ts` exactly: it has no character name to
   * attribute to, and guessing "whichever character spoke last" would silently disagree with the
   * paginator the moment that guess was wrong. Used for membership tests: the Navigator highlights
   * a character whenever the caret is anywhere in `blockIds`, not only on a cue.
   */
  blockIds: readonly string[];
};

/**
 * The conventional screenplay character extensions (plan.md's "Character names and extensions"
 * names exactly this set), keyed by their letters alone -- periods and apostrophes stripped -- so
 * `(V.O.)`, `(V.O)`, and `(VO)` all resolve to the same key. Used only to *normalize* a
 * recognized extension's spelling; which parenthetical counts as an extension in the first place
 * is decided structurally in `splitCharacterCue`, not by membership in this table -- plan.md is
 * explicit that the fixed set is "what to test against, not what to implement against."
 */
const CONVENTIONAL_CHARACTER_EXTENSIONS: Readonly<Record<string, string>> = {
  VO: 'V.O.',
  OS: 'O.S.',
  OC: 'O.C.',
  CONTD: "CONT'D",
};

function normalizeCharacterExtension(rawExtension: string): string {
  const key = rawExtension.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CONVENTIONAL_CHARACTER_EXTENSIONS[key] ?? rawExtension;
}

/**
 * Splits a character cue's raw text into its base name and every extension stacked on it -- the
 * parenthetical that can follow a character on the same line, as in `MARA (V.O.)`. Strips *any*
 * trailing parenthetical, matched structurally (a `(...)` group anchored at the end of the line),
 * rather than checking membership in `CONVENTIONAL_CHARACTER_EXTENSIONS`: plan.md requires "treat
 * any trailing parenthetical on a character line as an extension rather than matching a fixed
 * list. The conventional set... is what to test against, not what to implement against." Only a
 * trailing group strips -- `MARA (LOUD) SCREAMING` has no parenthetical at the end of the line, so
 * nothing strips and the whole line is the name.
 *
 * Stripping repeats until no trailing parenthetical remains, rather than stopping after one:
 * `MARA (V.O.) (CONT'D)` -- the standard rendering of a voice-over that continues across a page
 * break, not an exotic case -- must still group under `MARA`, per plan.md's own grouping
 * guarantee ("`MARA`, `MARA (V.O.)`, and `MARA (O.S.)` are one character, not three"). Stopping at
 * the outermost group would leave `MARA (V.O.)` as a name distinct from `MARA`, splitting one
 * real character into two Navigator entries on any script that has this line. Extensions are
 * returned in the order a reader encounters them left to right in the original text (innermost,
 * i.e. closest to the name, first), which for `MARA (V.O.) (CONT'D)` is `['V.O.', "CONT'D"]`.
 *
 * A name-less or empty parenthetical (`(V.O.)` alone, or `MARA ()`) has nothing usable either
 * side of the split, so stripping stops there and that remaining text -- not further parentheticals
 * that might precede it -- is left as the literal name.
 */
function splitCharacterCue(rawText: string): { name: string; extensions: string[] } {
  let remaining = rawText.trim();
  const extensions: string[] = [];

  for (;;) {
    const match = /^(.*)\((.*)\)\s*$/.exec(remaining);
    if (!match) {
      break;
    }

    const namePart = (match[1] ?? '').trim();
    const rawExtension = (match[2] ?? '').trim();
    if (namePart === '' || rawExtension === '') {
      break;
    }

    extensions.unshift(normalizeCharacterExtension(rawExtension));
    remaining = namePart;
  }

  return { name: remaining, extensions };
}

type CharacterEntry = { extensions: string[]; cueBlockIds: string[]; blockIds: string[] };

type SpeechBlock = { id: string; type: 'character' | 'parenthetical' | 'dialogue'; text: string };

/**
 * Derives the screenplay's character list from the ordered canonical body without changing it.
 * Mirrors `packages/layout`'s `groups.ts` (`buildGroups`) speech grouping deliberately, not by
 * coincidence: a character cue opens a "speech" that absorbs every contiguous
 * `parenthetical`/`dialogue` block that follows it, ending at the first block that is neither --
 * another cue, or anything else. Reusing that exact rule (rather than, say, walking upward from a
 * caret position and re-deriving the same boundary independently) is what guarantees the
 * Navigator and the paginator can never disagree about which character owns a line; if they did,
 * the Navigator would be the one that's wrong, since `groups.ts` is what pagination actually
 * builds on.
 *
 * `dual_dialogue` columns follow the same rule independently: each column is its own contiguous
 * run (`dialogueColumnBlockSchema` permits `character` anywhere in a column, not only as its
 * first block, so every `character`-typed block there opens its own speech exactly as at the root
 * level), and a speech never carries across the boundary between columns, or between the
 * `dual_dialogue` block and whatever precedes or follows it at the root level.
 *
 * A cue whose text is nothing but an unusable parenthetical (see `splitCharacterCue`) still opens
 * a speech under its literal text rather than being dropped, so no authored cue silently vanishes
 * from the list; the empty-name case that *is* dropped is a `character` block with no text at
 * all, which closes whatever speech was open (via `closeSpeech`, matching `groups.ts`'s own
 * `character` case) without opening a new one.
 */
export function deriveCharacters(blocks: readonly ScreenplayBlock[]): DerivedCharacter[] {
  const order: string[] = [];
  const entriesByName = new Map<string, CharacterEntry>();

  const getOrCreateEntry = (name: string): CharacterEntry => {
    let entry = entriesByName.get(name);
    if (!entry) {
      entry = { extensions: [], cueBlockIds: [], blockIds: [] };
      entriesByName.set(name, entry);
      order.push(name);
    }
    return entry;
  };

  // The character entry the currently open speech belongs to, or `undefined` for an orphan run
  // (a `parenthetical`/`dialogue` block with no preceding cue in its own contiguous run --
  // schema-legal, not real screenplay convention; see `groups.ts`'s own `openOrphanSpeech`) or
  // when nothing is currently open at all.
  let openEntry: CharacterEntry | undefined;

  const openCue = (cueBlock: { id: string; text: string }): void => {
    const { name, extensions: cueExtensions } = splitCharacterCue(cueBlock.text);
    if (name === '') {
      // No name to open a speech under -- closes whatever was open, same as any other block this
      // derivation does not recognize as continuing a speech.
      openEntry = undefined;
      return;
    }

    const entry = getOrCreateEntry(name);
    entry.cueBlockIds.push(cueBlock.id);
    entry.blockIds.push(cueBlock.id);
    for (const extension of cueExtensions) {
      if (!entry.extensions.includes(extension)) {
        entry.extensions.push(extension);
      }
    }
    openEntry = entry;
  };

  const continueSpeech = (blockId: string): void => {
    openEntry?.blockIds.push(blockId);
  };

  const closeSpeech = (): void => {
    openEntry = undefined;
  };

  const processSpeechBlock = (block: SpeechBlock): void => {
    if (block.type === 'character') {
      openCue(block);
    } else {
      continueSpeech(block.id);
    }
  };

  for (const block of blocks) {
    switch (block.type) {
      case 'character':
      case 'parenthetical':
      case 'dialogue':
        processSpeechBlock(block);
        break;
      case 'dual_dialogue':
        // A structurally separate block, not a continuation of whatever speech preceded it, and
        // its two columns are simultaneous, independent speeches rather than one continuous run
        // -- so each boundary (before the left column, between columns, and after the right
        // column) closes whatever speech is open, matching the doc comment above.
        closeSpeech();
        for (const columnBlock of block.left.blocks) {
          processSpeechBlock(columnBlock);
        }
        closeSpeech();
        for (const columnBlock of block.right.blocks) {
          processSpeechBlock(columnBlock);
        }
        closeSpeech();
        break;
      default:
        // scene_heading, action, shot, transition, page_break: none of these continue a speech,
        // matching every `groups.ts` case that is not `character`/`parenthetical`/`dialogue`.
        closeSpeech();
        break;
    }
  }

  return order.map((name) => {
    const entry = entriesByName.get(name);
    if (!entry) {
      throw new Error(`deriveCharacters: missing entry for '${name}'; this is a derivation bug.`);
    }
    return {
      name,
      extensions: entry.extensions,
      cueBlockIds: entry.cueBlockIds,
      blockIds: entry.blockIds,
    };
  });
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

/**
 * Left indent for a screenplay element, in spaces, for the plain-text rescue export below.
 * `ELEMENT_INDENTS` measures from the physical page edge (see pageFormat.ts's module comment);
 * plain text pasted into an email or a note has no page edge, only a left margin, so this
 * re-bases every indent onto `MARGIN_LEFT_IN` and converts inches to characters via the
 * specification's nominal 10-pitch (`NOMINAL_CHARACTERS_PER_INCH`) -- the same character grid
 * `BODY_WIDTH_CHARACTERS` and pagination already treat as normative, not a font-derived guess.
 */
function plainTextIndent(element: Exclude<ScreenplayElementKind, 'transition'>): string {
  const leftIn = ELEMENT_INDENTS[element].leftIn ?? MARGIN_LEFT_IN;
  return ' '.repeat(
    Math.max(0, Math.round((leftIn - MARGIN_LEFT_IN) * NOMINAL_CHARACTERS_PER_INCH)),
  );
}

/**
 * A title page's plain-text lines, grouped the way a printed title page groups them (title,
 * then credit/authors, then source/date/contact) but without the blank-vertical-centering a real
 * title page uses -- there is no page to center on in plain text. Groups are separated by exactly
 * one blank line, and an empty group contributes nothing, so a title page with only a title (or
 * only contact information) does not leave stray blank lines behind.
 */
function plainTextTitlePageLines(titlePage: TitlePage): string[] {
  const groups = [
    titlePage.title ? [titlePage.title] : [],
    [titlePage.credit, ...(titlePage.authors ?? [])].filter((line): line is string =>
      Boolean(line),
    ),
    [titlePage.source, titlePage.draftDate, ...(titlePage.contact ?? [])].filter(
      (line): line is string => Boolean(line),
    ),
  ].filter((group) => group.length > 0);

  return groups.flatMap((group, index) => (index === 0 ? group : ['', ...group]));
}

/** Blank lines before a root block, on the six-per-inch line grid -- see `BLANK_LINES_BEFORE`'s
 * own comment for the element types it covers. `dual_dialogue` and `page_break` have no entry
 * there (the specification gives blank-line counts per screenplay *element*, and neither is one);
 * one blank line each is the plain-text default, matching every other multi-line structural break
 * in this export.
 */
function plainTextBlankLinesBefore(block: ScreenplayBlock): number {
  if (block.type === 'dual_dialogue' || block.type === 'page_break') {
    return 1;
  }
  return BLANK_LINES_BEFORE[block.type];
}

function plainTextDialogueColumnLines(column: DialogueColumn): string[] {
  return column.blocks.map((block) => plainTextIndent(block.type) + block.text);
}

/**
 * One root block's plain-text lines, with no blank line before or after -- `screenplayToPlainText`
 * inserts those itself via `plainTextBlankLinesBefore`, once, so spacing is decided in exactly one
 * place. `transition` right-aligns to the body's right margin (its only specified edge, per
 * `ELEMENT_INDENTS`); every other text element left-indents per `plainTextIndent`. `dual_dialogue`
 * has no plain-text equivalent of true side-by-side columns (60 characters is too narrow to
 * duplicate the page layout and still read), so both columns print in full, sequentially, each
 * labelled -- lossy in relative timing (which this format cannot represent at all) but not in
 * content: everything either character said is present and attributed. `page_break` carries no
 * text of its own; its marker exists only so a reader of the plain text knows a page boundary was
 * there, not so the marker could be parsed back out.
 */
function plainTextBlockLines(block: ScreenplayBlock): string[] {
  switch (block.type) {
    case 'page_break':
      return ['-- page break --'];
    case 'transition':
      return [block.text.padStart(BODY_WIDTH_CHARACTERS)];
    case 'dual_dialogue':
      return [
        '[Dual dialogue -- spoken together, left column]',
        ...plainTextDialogueColumnLines(block.left),
        '',
        '[Dual dialogue -- spoken together, right column]',
        ...plainTextDialogueColumnLines(block.right),
      ];
    case 'scene_heading':
      return [
        plainTextIndent('scene_heading') +
          block.text +
          (block.sceneNumber ? ` (scene ${block.sceneNumber})` : ''),
      ];
    default:
      return [plainTextIndent(block.type) + block.text];
  }
}

/**
 * Renders a canonical screenplay as readable, screenplay-formatted plain text -- scene headings,
 * character cues, dialogue, parentheticals, transitions, and shots each at their specified
 * indent, not the canonical JSON a writer cannot paste anywhere useful. Built for the save-conflict
 * "Copy my version" rescue (progress/save-conflict-recovery.md): when saving is paused because the
 * server holds a newer version, this is the one way a writer can get their own unsaved text out of
 * the browser. Deliberately not an export format -- no page breaks are recomputed, no (MORE)/CONT'D
 * is inserted, annotations are omitted -- FDX export is the real export format and supersedes this
 * for that purpose (plan.md's autosave-and-conflict material, "Out of scope" in the same progress
 * file); this only has to be legible enough to paste into an email, a note, or a fresh document
 * without losing the writer's words.
 */
export function screenplayToPlainText(screenplay: Screenplay): string {
  const titlePage = screenplay.titlePages[0];
  const titlePageLines = titlePage ? plainTextTitlePageLines(titlePage) : [];
  const headerLines = titlePageLines.length > 0 ? titlePageLines : [screenplay.title];

  const lines = [...headerLines, '', ''];
  screenplay.blocks.forEach((block, index) => {
    if (index > 0) {
      lines.push(...Array<string>(plainTextBlankLinesBefore(block)).fill(''));
    }
    lines.push(...plainTextBlockLines(block));
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

import { z } from 'zod';
import {
  BLANK_LINES_BEFORE,
  BODY_WIDTH_CHARACTERS,
  DEFAULT_DOCUMENT_SETTINGS,
  ELEMENT_INDENTS,
  MARGIN_LEFT_IN,
  NOMINAL_CHARACTERS_PER_INCH,
  PAGE_WIDTH_IN,
  MARGIN_RIGHT_IN,
  type ScreenplayElementKind,
} from './pageFormat.js';

// Re-exported unchanged: `DEFAULT_DOCUMENT_SETTINGS` is defined in `pageFormat.ts` (which carries
// no zod dependency) so that a schema-free import chain -- `apps/web`'s pre-authentication CSS
// bootstrap via the `./pageFormat` subpath -- can reach it without pulling in zod and
// `screenplaySchema`. Consumers that already depend on zod, including `apps/api`, keep importing
// it from here; there is exactly one definition, never a copy.
export { DEFAULT_DOCUMENT_SETTINGS };

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
   * The extension-stripped grouping key, in canonical uppercase. plan.md's "Character names and
   * extensions": "`MARA`, `MARA (V.O.)`, and `MARA (O.S.)` are one character, not three" -- this
   * is the one name they group under. Grouping is case-insensitive on top of that: `MARA`,
   * `Mara`, and `mara` are also one character, because screenplay convention is that character
   * cues are uppercase, and the Navigator displays that convention regardless of what the writer
   * typed. The writer's own text is never rewritten to enforce this -- only this derived,
   * display-facing field is uppercased. Whichever spelling was cued first in document order
   * decides nothing observable here (the field is always uppercase), but does decide the case
   * used internally to key the grouping map, which is why cues are folded to uppercase before
   * lookup rather than compared case-insensitively on every read.
   */
  name: string;
  /**
   * Every extension this character was cued with, normalized and deduplicated case-insensitively
   * in first-seen order; empty when the character is never cued with a parenthetical. plan.md:
   * "accept the period-less spellings on import but normalise on output" -- `(VO)` and `(V.O.)`
   * both contribute the single normalized entry `'V.O.'` here, never two, and that normalization
   * already folds case (`CONVENTIONAL_CHARACTER_EXTENSIONS` is keyed by uppercased, punctuation-
   * stripped letters). An unconventional extension such as `(SUBTITLED)` is not forced to any
   * particular case -- it passes through exactly as the writer typed it, matching `name`'s "we do
   * not rewrite what the writer typed" rule -- but two spellings differing only in case, such as
   * `(subtitled)` and `(SUBTITLED)`, still dedupe to whichever spelling was cued first.
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
 * a speech under its own text (uppercased, per `DerivedCharacter.name`) rather than being
 * dropped, so no authored cue silently vanishes from the list; the empty-name case that *is*
 * dropped is a `character` block with no text at all, which closes whatever speech was open (via
 * `closeSpeech`, matching `groups.ts`'s own `character` case) without opening a new one.
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
    const { name: rawName, extensions: cueExtensions } = splitCharacterCue(cueBlock.text);
    if (rawName === '') {
      // No name to open a speech under -- closes whatever was open, same as any other block this
      // derivation does not recognize as continuing a speech.
      openEntry = undefined;
      return;
    }

    // Grouping is case-insensitive and the displayed name is always uppercase (see
    // `DerivedCharacter.name`'s doc comment), so the map key -- and the value stored in `name` --
    // is the uppercased spelling, not the writer's literal text. `MARA`, `Mara`, and `mara` all
    // fold to the same key and the same displayed `'MARA'`, regardless of which one was cued
    // first.
    const name = rawName.toUpperCase();
    const entry = getOrCreateEntry(name);
    entry.cueBlockIds.push(cueBlock.id);
    entry.blockIds.push(cueBlock.id);
    for (const extension of cueExtensions) {
      // Case-insensitive dedup: `(subtitled)` and `(SUBTITLED)` are the same extension, and
      // whichever spelling was cued first is the one kept -- matching the same "don't invent a
      // canonical spelling for what we don't already normalize" rule `normalizeCharacterExtension`
      // follows for conventional extensions.
      const alreadyPresent = entry.extensions.some(
        (existing) => existing.toUpperCase() === extension.toUpperCase(),
      );
      if (!alreadyPresent) {
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

/**
 * SmartType-style contextual completion (plan.md's SmartType-style entry, and this scope's
 * brief): "Scene-heading input suggests prefixes, then locations and times already authored;
 * character input suggests previously authored characters." This section is the pure core both
 * later stages (the editor's ghost overlay, and an optional accept-by-list layer) consume --
 * "No DOM, no ProseMirror, no React -- this is the seam both later stages consume." Two pieces:
 * `deriveVocabulary`, which reads the ordered canonical body once per document change and
 * produces the terms SmartType can offer, and `suggest`, which is given caret-side text on every
 * keystroke and filters those terms. Splitting the work this way keeps the expensive part (a
 * document-wide scan) off the keystroke path.
 */

/**
 * One term SmartType can offer, already in the form `suggest` will insert on accept -- uppercase
 * throughout: for a character name (`DerivedCharacter.name` is already canonical uppercase; see
 * its own doc comment), for a prefix (`SCENE_HEADING_PREFIXES`'s own canonical spelling), and,
 * per the user's ruling on this scope, for a location or time too. Screenplay convention is
 * uppercase throughout a scene heading, and accepting a suggestion is always an explicit action
 * (Tab), never a silent rewrite -- so offering `DUSK` for an authored `dusk` is a nudge toward
 * convention, not a correction imposed on the writer. This canonicalization is confined to what
 * `deriveVocabulary` derives and what `suggest` offers: the canonical screenplay itself is never
 * rewritten, and an authored `dusk` still reads back as `dusk` from the document -- see
 * `recordAuthoredTerm`. `count` is how many times it was authored; ordering by count (and, on a
 * tie, by how recently it was authored) happens once, in `deriveVocabulary`, not on every
 * `suggest` call -- see `sortTerms`.
 */
export type SmartTypeTerm = {
  readonly value: string;
  readonly count: number;
};

/** The vocabulary `suggest` filters, derived once from the ordered canonical body. Each list is
 * already sorted most-frequent-first, ties broken by most-recently-authored -- see `sortTerms`.
 * `prefixes` covers all four of `SCENE_HEADING_PREFIXES`, always -- unlike `locations`/`times`,
 * which omit anything never authored, a never-authored prefix still appears (at count 0) because
 * `suggest` must always have all four to offer while the caret is in the prefix zone. */
export type ScreenplayVocabulary = {
  readonly prefixes: readonly SmartTypeTerm[];
  readonly locations: readonly SmartTypeTerm[];
  readonly times: readonly SmartTypeTerm[];
  readonly characters: readonly SmartTypeTerm[];
};

/**
 * The fixed scene-heading prefixes this scope's brief names, longest first. Order matters for
 * matching (`matchScenePrefix`, below): `INT./EXT.` and `INT.` share the same first four
 * characters, so testing `INT.` before `INT./EXT.` would consume only the shorter prefix and
 * leave `/EXT.` as leftover text misparsed into the location. Checking longest-first is the only
 * way one pass through this list gets the right answer for every entry, including the ones that
 * do not overlap with anything (`I/E.`, `EXT.`).
 *
 * This is a MATCHING order only. It is deliberately not also the order `suggest` offers these in
 * -- that would rank the comparatively rare `INT./EXT.` above the single most common thing a
 * screenwriter types, `INT.`, for every writer, regardless of what they actually author. See
 * `CONVENTIONAL_PREFIX_ORDER` for the suggestion-side ordering.
 */
const SCENE_HEADING_PREFIXES = ['INT./EXT.', 'I/E.', 'INT.', 'EXT.'] as const;

/**
 * The tie-break `deriveVocabulary` falls back to for prefixes that are equally (usually
 * zero-)frequent, ranked by conventional real-world commonness rather than by anything about how
 * matching works: `INT.` is by far the most common scene-heading prefix a screenwriter types,
 * then `EXT.`, with the two combined forms `INT./EXT.` and `I/E.` both comparatively rare. This
 * is intentionally a different order from `SCENE_HEADING_PREFIXES` (longest-first, for correct
 * parsing) -- conflating the two would rank `INT./EXT.` and `I/E.` above `INT.` for every writer
 * on a brand-new document, and even after some authoring, `INT.` still needs a real frequency
 * lead over `INT./EXT.` before it can outrank it. Keeping the lists separate, with separate
 * names, is what stops that conflation from creeping back in.
 */
const CONVENTIONAL_PREFIX_ORDER = ['INT.', 'EXT.', 'INT./EXT.', 'I/E.'] as const;

/**
 * The conventional times of day this scope's brief specifies: "Seed the times with the
 * conventional set... The user chose this over authored-only, because a new document's first
 * scene otherwise gets no help." Declaration order is also the tie-break order `deriveVocabulary`
 * falls back to before anything has been authored (see `sortTerms`): every seed starts at count 0
 * with no authored position, so frequency and recency cannot distinguish them, and a stable sort
 * leaves them in exactly this order.
 */
const SEEDED_TIMES = [
  'DAY',
  'NIGHT',
  'AFTERNOON',
  'CONTINUOUS',
  'LATER',
  'MOMENTS LATER',
  'MORNING',
  'EVENING',
  'DAWN',
  'DUSK',
  'SAME',
  'SAME TIME',
];

/**
 * Case-insensitively matches `text`'s start against `SCENE_HEADING_PREFIXES`, returning the
 * canonical spelling (never the writer's typed case) or `undefined` if none matches. Shared by
 * `parseSceneHeading` (a committed, already-authored heading) and `locateSceneHeadingZone` (live
 * `textBeforeCaret`) so parsing an authored document and locating the caret within one being
 * typed can never disagree about where a prefix ends.
 */
function matchScenePrefix(text: string): string | undefined {
  const upper = text.toUpperCase();
  return SCENE_HEADING_PREFIXES.find((prefix) => upper.startsWith(prefix));
}

/**
 * A term's authored frequency and where in document order it was last authored -- the raw
 * material `sortTerms` reduces to the public, ordering-free `SmartTypeTerm`. `lastAuthoredIndex`
 * is `undefined` for a seeded-but-never-authored time: there is no document position to report,
 * and treating "never authored" as position `-1` (rather than, say, `0`) in `sortTerms` is what
 * keeps an unauthored seed from ever outranking a term actually authored at the very first block.
 */
type MutableTerm = { value: string; count: number; lastAuthoredIndex: number | undefined };

/**
 * Sorts by count descending, ties broken by `lastAuthoredIndex` descending -- this scope's
 * brief: "most frequent first, ties broken by most recently authored." `Array.prototype.sort` is
 * specified as a stable sort (ECMA-262 since ES2019), which this relies on directly: two terms
 * that tie on both count and last-authored position (only possible for two seeded, never-authored
 * times, since every authored occurrence lands at a document position no other block shares) keep
 * their `MutableTerm` insertion order, which for seeded times is `SEEDED_TIMES`'s declaration
 * order. Runs once per `deriveVocabulary` call, not per keystroke, so `suggest` never re-sorts.
 */
function sortTerms(terms: readonly MutableTerm[]): SmartTypeTerm[] {
  return [...terms]
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      return (b.lastAuthoredIndex ?? -1) - (a.lastAuthoredIndex ?? -1);
    })
    .map(({ value, count }) => ({ value, count }));
}

/**
 * Records one authored occurrence of `rawValue` (a prefix, a location, or a time) at document
 * position `blockIndex`, keyed case-insensitively so `Kitchen` and `KITCHEN` are the same term
 * with a combined count -- casing plays no part in identity, only in display. The stored `value`
 * is always the upper-cased key, never `rawValue` itself: per the user's ruling on this scope,
 * every `SmartTypeTerm` this module produces is canonical uppercase (see `SmartTypeTerm`'s own
 * doc comment), so an authored `dusk` and an authored `DUSK` are not just the same term (that
 * part was already true) but now also display and insert identically, as `DUSK`. This function
 * only ever writes into `index`, a `deriveVocabulary`-local `Map` -- it has no access to, and
 * never touches, the canonical blocks a document's writer actually typed.
 */
function recordAuthoredTerm(
  index: Map<string, MutableTerm>,
  rawValue: string,
  blockIndex: number,
): void {
  const key = rawValue.toUpperCase();
  const existing = index.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastAuthoredIndex = blockIndex;
    return;
  }
  index.set(key, { value: key, count: 1, lastAuthoredIndex: blockIndex });
}

/**
 * Splits one authored scene-heading's text into its prefix, location, and time, per this scope's
 * brief:
 *
 *  - The prefix is matched via `matchScenePrefix`; a heading with no recognised prefix still
 *    yields a location -- "the rest is still a location" -- so an unmatched prefix simply leaves
 *    the whole (trimmed) text as `rest` rather than discarding anything.
 *  - Time is whatever follows the LAST ` - ` separator, not the first: `INT. KITCHEN - BACK ROOM
 *    - DAY` has location `KITCHEN - BACK ROOM` and time `DAY`. `String.prototype.lastIndexOf`
 *    finds that occurrence directly; this is the main hazard this scope's brief calls out; see
 *    the "last separator, not first" test for the mutation this guards against.
 *  - Only the exact three-character token ` - ` (space, hyphen, space) counts as a separator. A
 *    bare hyphen with no surrounding spaces (`KITCHEN-DAY`) is not a separator and stays inside
 *    the location whole; a hyphen with extra surrounding whitespace (`KITCHEN  -  DAY`) still
 *    contains that exact token as a substring, so it still splits, and the per-segment `.trim()`
 *    below absorbs the extra spaces adjacent to it.
 *  - The whole heading is trimmed once up front (leading/trailing whitespace on a *committed*
 *    heading carries no signal), and each of `location`/`time` is trimmed again after splitting,
 *    to absorb whitespace immediately adjacent to the separator token. A segment that trims to
 *    the empty string contributes nothing -- "a heading with no time still yields its location"
 *    implies the reverse holds too: a blank segment is not a real value to remember.
 *
 * Also returns the matched `prefix` itself (undefined when none matched) so `deriveVocabulary`
 * can record prefix frequency without calling `matchScenePrefix` a second time.
 */
function parseSceneHeading(text: string): {
  prefix: string | undefined;
  location: string | undefined;
  time: string | undefined;
} {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { prefix: undefined, location: undefined, time: undefined };
  }

  // `rest` is deliberately left untrimmed here: trimming it before searching for the separator
  // would delete the leading space of a ` - ` token that sits immediately after the prefix (an
  // empty location, e.g. `INT. - DAY`), and that space is what makes the token match at all. Only
  // the final `location`/`time` values -- and the "is there anything here at all" check just
  // below -- are trimmed.
  const matchedPrefix = matchScenePrefix(trimmed);
  const rest = matchedPrefix ? trimmed.slice(matchedPrefix.length) : trimmed;
  if (rest.trim() === '') {
    return { prefix: matchedPrefix, location: undefined, time: undefined };
  }

  const separatorIndex = rest.lastIndexOf(' - ');
  if (separatorIndex === -1) {
    return { prefix: matchedPrefix, location: rest.trim(), time: undefined };
  }

  const location = rest.slice(0, separatorIndex).trim();
  const time = rest.slice(separatorIndex + 3).trim();
  return {
    prefix: matchedPrefix,
    location: location === '' ? undefined : location,
    time: time === '' ? undefined : time,
  };
}

/**
 * Assigns every block a unique, document-order position -- root blocks in order, and for
 * `dual_dialogue`, its left column's blocks then its right column's blocks, matching the
 * sequential reading order `screenplayToPlainText`'s own `dual_dialogue` case already uses ("both
 * columns print in full, sequentially"). Used only to give `deriveCharacterVocabulary` a
 * document position for each character's last cue -- a plain root-array index would miss cues
 * inside a `dual_dialogue` column entirely, undercounting recency for any character who only
 * speaks there.
 */
function buildBlockPositionIndex(blocks: readonly ScreenplayBlock[]): Map<string, number> {
  const positions = new Map<string, number>();
  let position = 0;
  const record = (id: string): void => {
    positions.set(id, position);
    position += 1;
  };

  for (const block of blocks) {
    record(block.id);
    if (block.type === 'dual_dialogue') {
      for (const columnBlock of block.left.blocks) {
        record(columnBlock.id);
      }
      for (const columnBlock of block.right.blocks) {
        record(columnBlock.id);
      }
    }
  }

  return positions;
}

/**
 * Character terms for `ScreenplayVocabulary`, built on top of `deriveCharacters` rather than
 * re-deriving character grouping -- this scope's brief: "character cues come from the existing
 * `deriveCharacters`; do NOT duplicate that logic, reuse it." `count` is how many times the
 * character was cued (`cueBlockIds.length`); `lastAuthoredIndex` is the document position (via
 * `buildBlockPositionIndex`) of the last cue in `cueBlockIds`, which is already in document order
 * because `deriveCharacters` appends to it in traversal order. `cueBlockIds` is never empty for
 * an entry `deriveCharacters` returns (every entry is created only when a cue is opened, which
 * immediately pushes to it), so there is always a last cue to look up.
 */
function deriveCharacterVocabulary(blocks: readonly ScreenplayBlock[]): SmartTypeTerm[] {
  const positions = buildBlockPositionIndex(blocks);
  const terms: MutableTerm[] = deriveCharacters(blocks).map((character) => {
    const lastCueBlockId = character.cueBlockIds[character.cueBlockIds.length - 1];
    return {
      value: character.name,
      count: character.cueBlockIds.length,
      lastAuthoredIndex: lastCueBlockId === undefined ? undefined : positions.get(lastCueBlockId),
    };
  });
  return sortTerms(terms);
}

/**
 * Derives SmartType's vocabulary from the ordered canonical body without changing it -- the
 * document-wide scan `suggest` is deliberately kept out of, so a caller runs this once per
 * document change (not per keystroke) and passes the result to every `suggest` call. Locations
 * and times come from authored `scene_heading` blocks only (`parseSceneHeading`); times are
 * additionally seeded with `SEEDED_TIMES` before any block is visited, so `recordAuthoredTerm`
 * folds an authored spelling into its matching seed instead of creating a duplicate (this scope's
 * brief: "Authored times that duplicate a seed... must not appear twice"). Locations have no
 * seed -- there is no universal default location the way there is a default time of day.
 *
 * Prefixes are seeded too, but for a different reason than times: all four of
 * `SCENE_HEADING_PREFIXES` are seeded (via `CONVENTIONAL_PREFIX_ORDER`, at count 0) not because a
 * writer might type something else that folds into one of them, but because `suggest` must always
 * have all four available in the prefix zone, and a prefix this document has never used still
 * needs to be there, ranked last, broken by conventional commonness rather than by anything about
 * how `SCENE_HEADING_PREFIXES` matches. See `CONVENTIONAL_PREFIX_ORDER`'s own comment for why that
 * ranking is a distinct list from `SCENE_HEADING_PREFIXES`, not a reuse of it.
 *
 * Characters are `deriveCharacterVocabulary`, reusing `deriveCharacters` entirely.
 */
export function deriveVocabulary(blocks: readonly ScreenplayBlock[]): ScreenplayVocabulary {
  const prefixIndex = new Map<string, MutableTerm>(
    CONVENTIONAL_PREFIX_ORDER.map((prefix) => [
      prefix,
      { value: prefix, count: 0, lastAuthoredIndex: undefined },
    ]),
  );
  const locationIndex = new Map<string, MutableTerm>();
  const timeIndex = new Map<string, MutableTerm>(
    SEEDED_TIMES.map((seed) => [seed, { value: seed, count: 0, lastAuthoredIndex: undefined }]),
  );

  blocks.forEach((block, blockIndex) => {
    if (block.type !== 'scene_heading') {
      return;
    }
    const { prefix, location, time } = parseSceneHeading(block.text);
    if (prefix !== undefined) {
      recordAuthoredTerm(prefixIndex, prefix, blockIndex);
    }
    if (location !== undefined) {
      recordAuthoredTerm(locationIndex, location, blockIndex);
    }
    if (time !== undefined) {
      recordAuthoredTerm(timeIndex, time, blockIndex);
    }
  });

  return {
    prefixes: sortTerms([...prefixIndex.values()]),
    locations: sortTerms([...locationIndex.values()]),
    times: sortTerms([...timeIndex.values()]),
    characters: deriveCharacterVocabulary(blocks),
  };
}

/**
 * One candidate `suggest` offers: enough to render a ghost (`remainder`) and enough to perform an
 * explicit accept (`insertText` plus `matchedLength`) without the caller re-deriving the match.
 *
 *  - `insertText` is the full canonical value to insert -- uppercase throughout, for a
 *    character, a prefix, a location, or a time alike (see `SmartTypeTerm`'s doc comment).
 *    Never rewritten based on what the writer typed.
 *  - `matchedLength` is how many UTF-16 code units, counting back from the caret, an accept
 *    replaces with `insertText`. It is deliberately not always `textBeforeCaret.length`: for a
 *    scene heading, it is the length of only the zone-local partial word (e.g. the partial
 *    location after `INT. `, not the whole heading), so accepting never touches the prefix or
 *    separator the writer already has right.
 *  - `remainder` is `insertText` with its first `matchedLength` characters removed -- the ghost
 *    text a caller renders after the caret. It can be the empty string (the writer's typed text
 *    already equals the candidate case-insensitively, e.g. `mara` against `MARA`); the candidate
 *    is still offered, because accepting it still corrects the case, which is real, visible work
 *    even though there is no remainder to preview.
 *
 * Accepting a candidate is: `textBeforeCaret.slice(0, textBeforeCaret.length - matchedLength) +
 * insertText`, followed by whatever text originally followed the caret, unchanged. `suggest`
 * itself never performs this -- only an explicit accept does, per this scope's brief: "never
 * replace text without an explicit accept action."
 */
export type SmartTypeCandidate = {
  readonly insertText: string;
  readonly remainder: string;
  readonly matchedLength: number;
};

/**
 * Filters `terms` to those whose `value` case-insensitively starts with `filterText`, building a
 * `SmartTypeCandidate` for each match. The only matching rule in this module -- case-insensitive
 * prefix matching, never fuzzy (this scope's brief: "Screenplay vocabulary is small and fuzzy
 * matching surprises writers"). `terms` is expected to already be in display order (`sortTerms`'s
 * output -- every list on `ScreenplayVocabulary`, prefixes included, is pre-sorted); filtering
 * with `Array.prototype.filter` preserves that order, so this function never has to sort anything
 * itself.
 */
function buildCandidates(
  filterText: string,
  terms: readonly SmartTypeTerm[],
): SmartTypeCandidate[] {
  const upperFilter = filterText.toUpperCase();
  const candidates: SmartTypeCandidate[] = [];
  for (const term of terms) {
    if (!term.value.toUpperCase().startsWith(upperFilter)) {
      continue;
    }
    candidates.push({
      insertText: term.value,
      remainder: term.value.slice(filterText.length),
      matchedLength: filterText.length,
    });
  }
  return candidates;
}

type SceneHeadingZone =
  | { readonly zone: 'prefix'; readonly filterText: string }
  | { readonly zone: 'location'; readonly filterText: string }
  | { readonly zone: 'time'; readonly filterText: string };

/**
 * Determines which part of a scene heading being typed the caret sits in, from `textBeforeCaret`
 * alone -- `suggest` never sees what follows the caret (see `SmartTypeCandidate`'s doc comment),
 * so this is the only signal available, and it is enough:
 *
 *  - `prefix`, while `textBeforeCaret` contains no space at all. This also covers "a heading with
 *    no recognised prefix" while it is still being typed: an unrecognised first token stays in
 *    the prefix zone (offering no candidates, since nothing in `vocabulary.prefixes` matches it)
 *    until a space commits it to being a location, exactly mirroring `parseSceneHeading`'s "the
 *    rest is still a location" rule for the same text once authored.
 *  - `time`, once a space exists and the text after the prefix (or, if none was recognised, the
 *    whole heading) contains a ` - ` -- the LAST one, matching `parseSceneHeading` exactly.
 *  - `location` otherwise: a space exists, but no ` - ` has been typed yet.
 *
 * Each zone's `filterText` strips only a leading run of whitespace immediately at the zone's own
 * start (the one boundary space after a prefix, or after a ` - `) -- never a trailing trim,
 * because the zone always ends at the caret; and never more than that one leading run, because
 * everything past it is the partial word being completed.
 */
function locateSceneHeadingZone(textBeforeCaret: string): SceneHeadingZone {
  if (!textBeforeCaret.includes(' ')) {
    return { zone: 'prefix', filterText: textBeforeCaret };
  }

  const matchedPrefix = matchScenePrefix(textBeforeCaret);
  const rest = matchedPrefix ? textBeforeCaret.slice(matchedPrefix.length) : textBeforeCaret;

  const separatorIndex = rest.lastIndexOf(' - ');
  if (separatorIndex === -1) {
    return { zone: 'location', filterText: rest.replace(/^\s+/, '') };
  }

  return { zone: 'time', filterText: rest.slice(separatorIndex + 3).replace(/^\s+/, '') };
}

/**
 * SmartType's pure suggestion core (this scope's brief; plan.md's SmartType-style entry): given
 * the element being typed into, the text before the caret, and a pre-derived `ScreenplayVocabulary`
 * (`deriveVocabulary`), returns ordered candidates a caller can render as a ghost and insert on
 * explicit accept. No DOM, no ProseMirror, no React, and no mutation of anything -- this is the
 * seam both the editor's ghost overlay and an optional accept-by-list layer consume, and its
 * purity is what keeps those two independent of each other and of this module.
 *
 *  - In a `scene_heading`, `locateSceneHeadingZone` decides whether the caret is completing a
 *    prefix, a location, or a time, and this dispatches to the matching candidate list:
 *    `vocabulary.prefixes`, `vocabulary.locations`, or `vocabulary.times` -- all three ranked the
 *    same way (`sortTerms`: most-authored first, ties by most-recently-authored, and for
 *    prefixes, a never-authored tie breaks by `CONVENTIONAL_PREFIX_ORDER` rather than by
 *    `SCENE_HEADING_PREFIXES`'s matching order; see that constant's own comment for why those
 *    two orders must not be conflated).
 *  - In a `character` block, candidates come from `vocabulary.characters`, filtered against the
 *    whole of `textBeforeCaret` (stripped of any leading whitespace) -- a character cue has no
 *    internal zones the way a scene heading does.
 *  - In every other element, this returns `[]` unconditionally: "In any other element, suggest
 *    nothing."
 *
 * Never throws. Odd input -- empty text, whitespace-only text, a caret sitting mid-word (this
 * function only ever sees text already truncated at the caret, so "mid-word" is not a distinct
 * case to detect, only ordinary input that happens to produce a short `filterText`), or text that
 * matches no vocabulary entry -- all flow through the same case-insensitive-prefix filtering in
 * `buildCandidates` and settle out as `[]` when nothing matches, without any special-cased branch
 * for "this input is odd." The one input that is not empty by default is genuinely empty
 * `textBeforeCaret` in a `scene_heading`: that is the prefix zone with an empty `filterText`,
 * which matches every entry in `vocabulary.prefixes` -- deliberately not `[]`, because "at the
 * start, suggest prefixes" is exactly the case of a freshly created, still-empty scene heading.
 */
export function suggest(
  elementType: ScreenplayElementKind,
  textBeforeCaret: string,
  vocabulary: ScreenplayVocabulary,
): readonly SmartTypeCandidate[] {
  if (elementType === 'scene_heading') {
    const zone = locateSceneHeadingZone(textBeforeCaret);
    switch (zone.zone) {
      case 'prefix':
        return buildCandidates(zone.filterText, vocabulary.prefixes);
      case 'location':
        return buildCandidates(zone.filterText, vocabulary.locations);
      case 'time':
        return buildCandidates(zone.filterText, vocabulary.times);
    }
  }

  if (elementType === 'character') {
    return buildCandidates(textBeforeCaret.replace(/^\s+/, ''), vocabulary.characters);
  }

  return [];
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

import {
  DEFAULT_DOCUMENT_SETTINGS,
  MAX_SCREENPLAY_TITLE_LENGTH,
  safeParseScreenplay,
  type DialogueColumn,
  type DocumentSettings,
  type Screenplay,
  type ScreenplayBlock,
  type TitlePage,
} from '@finaler-draft/screenplay';
import {
  childElements,
  firstChildElement,
  directText,
  FdxXmlError,
  parseFdxXml,
  type XmlElement,
} from './xmlParser.js';
// These five constants are the entire piece of `index.ts` this module needs: the exact size of
// every blank-line gap `titlePageLines` writes, including the unconditional leading run before
// `title` itself. Importing them (rather than hardcoding the same numbers here, which is how the
// Task 1 defect -- and this pass's own trailing-author-blanks defect -- were each introduced in
// the first place) is what keeps the two halves of this grammar from drifting apart again -- see
// `decodeTitlePageContent`'s doc comment below. `index.ts` itself re-exports this module's public
// surface (`export { fdxToScreenplay, ... } from './import.js'` at its own top), so this is a
// real circular import; that is safe here because the only bindings pulled across it are `const`
// reads inside function bodies that never run during either module's own top-level evaluation.
import {
  TITLE_PAGE_LINES_BEFORE_TITLE,
  TITLE_PAGE_LINES_BEFORE_CREDIT,
  TITLE_PAGE_LINES_BEFORE_AUTHOR,
  TITLE_PAGE_LINES_BEFORE_SOURCE,
  TITLE_PAGE_LINES_BEFORE_DRAFT_DATE,
  TITLE_PAGE_LINES_BEFORE_CONTACT,
} from './index.js';

/**
 * `fdxToScreenplay` -- the FDX-import half of `packages/fdx` (`screenplayToFdx`, `index.ts`, is
 * the export half). Pure, like the exporter: a string in, a validated canonical `Screenplay` out
 * or a thrown `FdxImportError`, with no DOM, filesystem, or network access anywhere in this
 * module or in `xmlParser.ts` beneath it. `apps/web`'s import control (`routes/projects/
 * $projectId/index.tsx`) is the only caller today, and it calls this from inside the browser --
 * see `plan.md`'s "Importing untrusted files": "Parsing is client-side only." Being pure and
 * DOM-free is what makes this entire mapping unit-testable in Node, exactly as `screenplayToFdx`
 * already is, with no injected-parser seam: see `xmlParser.ts`'s own doc comment for why a
 * hand-written parser was chosen over `DOMParser` or a third-party library.
 *
 * **Security is layered, outermost first, and every layer is independently tested in
 * `import.test.ts`'s "security guards" suite:** `parseFdxXml` enforces the input-size bound before
 * touching a single character, then rejects any `DOCTYPE`/DTD before tokenizing anything else,
 * then bounds element count and nesting depth as it tokenizes. Only after all of that does this
 * module's mapping ever see a tree, and everything that tree's text produces is validated by
 * `screenplaySchema` at the very end (`safeParseScreenplay`) exactly as any other input to this
 * product -- import has no fast path around that boundary.
 *
 * **Fidelity is fail-closed, not best-effort.** `plan.md`: "A partially-understood import that
 * silently drops content is worse than a refusal." Every FDX construct this mapping cannot
 * represent -- a non-`Paragraph` element inside `<Content>`, a dual-dialogue block whose column
 * split cannot be determined safely -- throws `FdxImportError` with code `'unmapped_content'`
 * naming exactly what could not be imported, rather than silently omitting it. There is no
 * partial-import, warn-and-continue mode for either of those: a writer who imports a file either
 * gets everything in it or a specific refusal naming what this product cannot yet represent,
 * never a script quietly missing content they believe is there.
 *
 * **One deliberate exception: a title page whose paragraph sequence this mapping cannot decode no
 * longer refuses the whole import.** Before this pass, it did, via the same `'unmapped_content'`
 * path as everything else in the paragraph above -- and a 100-page script with every body
 * paragraph mappable could be refused outright over one unexpected blank line on its title page.
 * That trade is backwards: a title page is recoverable (the writer can re-type four fields), a
 * refused import is not. `fdxToScreenplay` now catches exactly the `FdxImportError` thrown inside
 * its own title-page decoding step, imports the body regardless, and reports
 * `titlePageUnreadable: true` on the returned `FdxImportResult` rather than losing the failure
 * silently -- the writer is told, through the caller's existing confirmation step, exactly as a
 * skipped element type already is. See `progress/fdx-import.md`'s Task 2 (this pass) for the full
 * reasoning and `FdxImportResult`'s own doc comment below for the field itself.
 *
 * **One specific case gets a resolution path instead of an outright refusal: a paragraph `Type`
 * attribute that is in neither `FDX_TYPE_TO_BLOCK_TYPE` nor `SKIPPABLE_FDX_TYPES`.** The first
 * `fdxToScreenplay` call on a file containing any such type throws `FdxUnknownTypesError`
 * (`code: 'unknown_types'`) naming every distinct unrecognised `Type`, its occurrence count, and
 * an excerpt of its first instance -- gathered in one pass over the whole document, not merely
 * the first one encountered, so a caller can show the writer everything that needs a decision at
 * once rather than discovering types one failed attempt at a time. The caller (`apps/web`) is
 * expected to let the writer choose, per distinct `Type`, to skip it or map it to one of the
 * canonical leaf block types (`MAPPABLE_BLOCK_TYPES`), then call `fdxToScreenplay` again with a
 * `resolutions` argument covering every type the first call reported. Nothing is ever guessed on
 * this package's own initiative -- a decision not supplied by the caller leaves that type
 * unresolved, and an unresolved type throws `FdxUnknownTypesError` again, same as the first call.
 * See `progress/fdx-import.md`'s Task 2 for why this is a different shape from `'unmapped_content'`
 * rather than a special case of it: every other unmapped construct has no other party who could
 * meaningfully decide what it means, but an unrecognised paragraph *type* is exactly the kind of
 * thing a writer looking at the original Final Draft file can.
 */

export type FdxImportErrorCode =
  | 'too_large'
  | 'doctype_rejected'
  | 'not_xml'
  | 'not_fdx'
  | 'unmapped_content'
  | 'unknown_types'
  | 'empty_result';

export class FdxImportError extends Error {
  constructor(
    readonly code: FdxImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FdxImportError';
  }
}

/**
 * The canonical leaf block types a writer may redirect an unrecognised FDX paragraph `Type` into
 * (`FdxUnknownTypeResolution`'s `'map'` action). Deliberately excludes `dual_dialogue` and
 * `page_break`: neither is a *paragraph* type a single unrecognised `<Paragraph Type="...">` could
 * ever faithfully become -- `dual_dialogue` is a structural wrapper around two columns of other
 * paragraphs, and `page_break` is synthesized from `StartsNewPage`, not from a `Type` at all (see
 * `decodeContent`'s own doc comment). Exported as a value, not only a type, because the caller
 * needs the literal list to render the writer's choices -- `apps/web`'s resolution dialog imports
 * this rather than re-declaring its own, so the two lists cannot drift apart.
 */
export const MAPPABLE_BLOCK_TYPES = [
  'action',
  'scene_heading',
  'character',
  'dialogue',
  'parenthetical',
  'transition',
  'shot',
] as const;
export type MappableBlockType = (typeof MAPPABLE_BLOCK_TYPES)[number];

/** One distinct unrecognised FDX paragraph `Type`, as reported by `FdxUnknownTypesError`. */
export type FdxUnknownType = {
  /** The raw FDX `Type` attribute string, verbatim -- the same key space `resolutions` is keyed
   * by. */
  readonly type: string;
  /** How many `<Content>` paragraphs carried this exact `Type` in the document just scanned. */
  readonly count: number;
  /** A short excerpt of the first such paragraph's `<Text>` content, trimmed and truncated (see
   * `UNKNOWN_TYPE_EXCERPT_MAX_LENGTH`), so the writer can tell what the content actually is
   * without seeing the raw file. Empty when the first instance itself had no text. */
  readonly excerpt: string;
};

/** The writer's decision for one distinct unrecognised `Type`: leave it out (tallied exactly like
 * `SKIPPABLE_FDX_TYPES`), or treat every paragraph of that `Type` as the given canonical block
 * type. */
export type FdxUnknownTypeResolution =
  | { readonly action: 'skip' }
  | { readonly action: 'map'; readonly blockType: MappableBlockType };

/** Keyed by the raw FDX `Type` string, exactly as reported in `FdxUnknownType.type`. Must cover
 * every `Type` the most recent `FdxUnknownTypesError` reported for `fdxToScreenplay` to proceed --
 * see that function's own doc comment. */
export type FdxUnknownTypeResolutions = Readonly<Record<string, FdxUnknownTypeResolution>>;

/**
 * Thrown instead of a generic `FdxImportError` when `<Content>` contains one or more paragraph
 * `Type`s this package does not recognize and the caller has not (yet, or not fully) supplied a
 * `resolutions` entry for each one. `unknownTypes` is exhaustive over every distinct such `Type`
 * still unresolved as of this call, gathered in one pass over the whole document -- never only the
 * first one found, which is the entire point of this being its own error rather than
 * `decodeContent` simply throwing `unmapped()` the moment it meets the first unrecognised `Type`.
 */
export class FdxUnknownTypesError extends FdxImportError {
  constructor(readonly unknownTypes: readonly FdxUnknownType[]) {
    super(
      'unknown_types',
      `This file contains ${unknownTypes.length} paragraph type(s) this product does not ` +
        `recognize: ${unknownTypes.map((entry) => `"${entry.type}" (×${entry.count})`).join(', ')}. ` +
        'Choose, for each one, whether to skip it or map it to a canonical element type, then ' +
        'import again.',
    );
    this.name = 'FdxUnknownTypesError';
  }
}

const UNKNOWN_TYPE_EXCERPT_MAX_LENGTH = 80;

/** A short, single-line excerpt of a (possibly long, possibly multi-line) paragraph's text, for
 * `FdxUnknownType.excerpt`. Trims surrounding whitespace first so a paragraph consisting only of
 * whitespace reports as the empty excerpt it visually is, not a string of invisible characters. */
function excerptOfText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= UNKNOWN_TYPE_EXCERPT_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, UNKNOWN_TYPE_EXCERPT_MAX_LENGTH)}…`;
}

function unmapped(description: string): FdxImportError {
  return new FdxImportError(
    'unmapped_content',
    `This file contains ${description}, which has no equivalent in this product's screenplay ` +
      'model and cannot be imported. Nothing was imported, so no content was silently dropped. ' +
      'Remove or convert that content in Final Draft and re-export, then try again.',
  );
}

/**
 * A UUID exactly as Final Draft and this package's own exporter write one (confirmed against
 * `packages/fdx/fixtures/final-draft-13-reference.fdx`, which gives every `Content` and
 * `TitlePage` paragraph an `id` attribute of this shape). Used only to decide whether to *reuse*
 * an incoming `id` attribute as a canonical block's stable id; any value that doesn't match --
 * missing, malformed, or truncated, which a hand-edited or third-party-tool file could produce --
 * falls back to a freshly generated id instead of ever being handed to `screenplaySchema`
 * unchecked.
 */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Reuses a paragraph's own `id` attribute when it is genuinely a UUID, otherwise mints a fresh
 * one. This is the mechanism behind this slice's strongest round-trip claim: **`screenplayToFdx`
 * writes the canonical block's own id into this exact attribute** (`index.ts`'s `bodyParagraph`:
 * "`id` is the canonical block's own stable id... this takes that identity rather than inventing
 * a parallel one"), and the genuine Final Draft reference file does the same thing independently
 * -- every `Content` paragraph it contains already carries a UUID `id`. Body-block ids therefore
 * round-trip exactly through this package, not merely "modulo ids"; see `progress/fdx-import.md`
 * for the precise, corrected statement of what does and does not survive a round trip.
 */
function reuseOrMintId(rawId: string | undefined): string {
  return rawId !== undefined && UUID_PATTERN.test(rawId) ? rawId : crypto.randomUUID();
}

const FDX_TYPE_TO_BLOCK_TYPE: Readonly<Record<string, MappableBlockType>> = {
  'Scene Heading': 'scene_heading',
  Action: 'action',
  // `General` is Final Draft's ordinary plain paragraph -- confirmed directly against the
  // reference fixture, where a `Type="General"` paragraph carries `LeftIndent="1.50"`, the exact
  // same left indent `Action` uses, and no distinguishing style or alignment of its own. Mapping
  // it to `action` is faithful, not a guess: same indent, same plain-paragraph shape, renders
  // identically either way. Owner decision (see progress/fdx-import.md): the original policy
  // refused every unrecognized `Type`, including `General`, which meant this project's own
  // genuine Final Draft reference file could not be imported -- `General` is routine in real
  // scripts, not an exotic construct, so refusing it made most real imports fail outright.
  General: 'action',
  Character: 'character',
  Dialogue: 'dialogue',
  Parenthetical: 'parenthetical',
  Transition: 'transition',
  Shot: 'shot',
};

/**
 * Paragraph `Type`s that are genuinely not screenplay body content -- outline, structure, and
 * production-board scaffolding Final Draft can carry alongside a script but that this product's
 * canonical model has no field for at all, as opposed to `General`'s case above where a faithful
 * mapping exists. Owner decision (see progress/fdx-import.md): these are *skipped* (counted and
 * reported to the writer before the import commits, never silently dropped) rather than treated
 * as a fatal, whole-file refusal -- the same owner correction that added `General` above. This is
 * a closed, explicit allowlist, not a catch-all: a `Type` absent from both this set and
 * `FDX_TYPE_TO_BLOCK_TYPE` above still fails the whole import with `'unmapped_content'` (see
 * `decodeContent` below), which is the property that keeps this relaxation safe -- an unrecognized
 * future Final Draft construct is refused, never guessed into "probably skippable."
 */
const SKIPPABLE_FDX_TYPES: ReadonlySet<string> = new Set([
  'Outline 1',
  'Outline 2',
  'Outline 3',
  'Summary',
  'Beat',
  'Sequence',
  'New Act',
  'End of Act',
  'Cast List',
  'Note',
]);

/**
 * Builds a leaf `ScreenplayBlock` from a `<Paragraph>` once its canonical block type is already
 * known -- shared by `decodeLeafParagraph` below (which derives `blockType` from `Type` via
 * `FDX_TYPE_TO_BLOCK_TYPE`) and `decodeContent`'s handling of a `'map'` resolution for a
 * previously-unrecognised `Type` (which instead takes `blockType` from the writer's own choice).
 * Text is taken verbatim from `<Text>`'s content with no case transformation: `Style="AllCaps"`
 * (seen on Scene Heading, Character, Transition, and Shot in the reference) is a Final Draft
 * *rendering* hint applied uniformly per element type, not a record that the underlying text was
 * retyped -- the reference's own `<Text Style="AllCaps">INT. DRISKILL...` stores the
 * already-uppercase text directly, matching exactly what `screenplayToFdx` itself writes (it sets
 * `Style="AllCaps"` unconditionally per type, never by inspecting the text). Taking `<Text>`
 * verbatim is therefore the correct, lossless mapping, not an approximation that happens to work
 * on this fixture.
 */
function buildLeafBlock(paragraph: XmlElement, blockType: MappableBlockType): ScreenplayBlock {
  const textElement = firstChildElement(paragraph, 'Text');
  const text = textElement !== undefined ? directText(textElement) : '';
  const id = reuseOrMintId(paragraph.attrs.id);

  if (blockType === 'scene_heading') {
    const sceneNumber = paragraph.attrs.Number;
    return {
      id,
      type: 'scene_heading',
      text,
      ...(sceneNumber !== undefined ? { sceneNumber } : {}),
    };
  }
  // The six remaining leaf types share the `{ id, type, text }` shape exactly.
  return { id, type: blockType, text } as ScreenplayBlock;
}

/**
 * Decodes one `<Paragraph Type="...">` into the matching leaf `ScreenplayBlock`, by first looking
 * up its canonical type from `FDX_TYPE_TO_BLOCK_TYPE`. Only ever called (from `decodeContent` and
 * from `decodeDualDialogue`'s column decoding) for a `Type` already confirmed to be in that table
 * -- a `Type` that is merely unrecognised, as opposed to genuinely absent, is `decodeContent`'s
 * own concern now (see that function's doc comment on `FdxUnknownTypesError`), not this one's; the
 * `unmapped()` throw below is reachable only through `decodeDualDialogue`'s column paragraphs,
 * which do not go through that resolution path.
 */
function decodeLeafParagraph(paragraph: XmlElement, position: number): ScreenplayBlock {
  const typeAttr = paragraph.attrs.Type;
  const blockType = typeAttr !== undefined ? FDX_TYPE_TO_BLOCK_TYPE[typeAttr] : undefined;
  if (blockType === undefined) {
    throw unmapped(`a paragraph of type "${typeAttr ?? '(none)'}" (content position ${position})`);
  }
  return buildLeafBlock(paragraph, blockType);
}

/**
 * Decodes a `dual_dialogue` paragraph: an outer `<Paragraph>` with no `Type` attribute wrapping a
 * `<DualDialogue>` of flattened Character/Parenthetical/Dialogue paragraphs -- the left column's
 * blocks, then the right column's, with no marker between them (`index.ts`'s own doc comment:
 * "no per-column wrapper, order alone distinguishes the columns").
 *
 * **The split point is recovered only when it is unambiguous.** `dialogueColumnSchema` requires
 * each column to *begin* with a character cue but does not forbid a column containing more than
 * one, so in general there is no safe way to locate the second column's start from a flat list.
 * This mapping requires *exactly two* `Character`-typed paragraphs among the flattened children
 * and splits at the second one; any other count throws `'unmapped_content'` rather than guess.
 * This is deliberately conservative: `dual_dialogue`'s FDX shape is itself unverified against a
 * genuine Final Draft file (`index.ts`'s own doc comment, and the reference fixture contains zero
 * dual-dialogue examples), so decoding it any more liberally than "the one shape this package's
 * own exporter produces" would be guessing at an unverified format twice over.
 */
function decodeDualDialogue(paragraph: XmlElement, position: number): ScreenplayBlock {
  const dualDialogueElement = firstChildElement(paragraph, 'DualDialogue');
  if (dualDialogueElement === undefined) {
    throw unmapped(
      `a paragraph with no "Type" attribute and no <DualDialogue> child (content position ${position})`,
    );
  }
  const innerParagraphs = childElements(dualDialogueElement).filter(
    (child) => child.tag === 'Paragraph',
  );
  const characterIndices = innerParagraphs.reduce<number[]>((indices, child, index) => {
    return child.attrs.Type === 'Character' ? [...indices, index] : indices;
  }, []);
  if (characterIndices.length !== 2) {
    throw unmapped(
      `a dual-dialogue block (content position ${position}) with ${characterIndices.length} ` +
        'character cues instead of exactly two, so its left/right column split cannot be ' +
        'determined safely',
    );
  }
  const splitIndex = characterIndices[1]!;

  function decodeColumn(rawBlocks: readonly XmlElement[]): DialogueColumn {
    return {
      id: crypto.randomUUID(),
      blocks: rawBlocks.map(
        (block) => decodeLeafParagraph(block, position) as DialogueColumn['blocks'][number],
      ),
    };
  }

  return {
    id: reuseOrMintId(paragraph.attrs.id),
    type: 'dual_dialogue',
    left: decodeColumn(innerParagraphs.slice(0, splitIndex)),
    right: decodeColumn(innerParagraphs.slice(splitIndex)),
  };
}

export type FdxSkippedTally = ReadonlyMap<string, number>;

type DecodedContent = { blocks: ScreenplayBlock[]; skipped: FdxSkippedTally };

/**
 * Decodes `<Content>`'s children into the canonical `blocks` array, including `page_break`
 * synthesis: `screenplayToFdx` has no FDX element for `page_break` and instead marks the
 * paragraph that follows one with `StartsNewPage="Yes"` (`index.ts`'s `renderBody`). Decoding the
 * inverse -- inserting a `page_break` immediately before any paragraph carrying that attribute --
 * is unambiguous here because `StartsNewPage` never appears on a genuine Content paragraph
 * *instance* otherwise: confirmed against the reference fixture, where every element type that
 * defaults to `StartsNewPage="Yes"` in its `<ElementSettings>` (`New Act`) still omits the
 * attribute on its actual `Content` instance, exactly as `screenplayToFdx` itself only emits the
 * attribute when true. This check runs before the skip/map/unknown decision below and applies
 * uniformly to all three: a `StartsNewPage="Yes"` paragraph that turns out to be a skipped (or
 * unresolved-unknown) type still contributes its forced page break, since the break is a property
 * of *where in the document* the page turns, independent of whether this product can represent
 * the paragraph's own content.
 *
 * `skipped` tallies every paragraph whose `Type` matched `SKIPPABLE_FDX_TYPES`, *or* whose `Type`
 * was unrecognised but the caller's `resolutions` chose `'skip'` for it, keyed by the raw FDX
 * `Type` string, in first-seen order -- returned to the caller rather than merely logged, so the
 * writer can be shown exactly what was left out *before* the import commits (owner decision,
 * `progress/fdx-import.md`: "nothing is dropped silently -- it is reported and the writer
 * consents"). The two sources share one tally because, to the writer reviewing the confirmation
 * step afterward, they are the identical fact: this `Type` contributed nothing to `blocks`.
 *
 * A `Type` in neither `FDX_TYPE_TO_BLOCK_TYPE` nor `SKIPPABLE_FDX_TYPES` is *unknown*, not
 * unmapped in the fatal, `'unmapped_content'` sense: this function gathers every distinct such
 * `Type` across the whole document (not stopping at the first one) along with its count and an
 * excerpt of its first instance, and consults `resolutions` for each. A `Type` the caller has
 * resolved to `'skip'` or `'map'` is handled accordingly, in the same pass; a `Type` with no
 * resolution at all is recorded and, once the whole document has been scanned, reported via a
 * thrown `FdxUnknownTypesError` naming every such still-unresolved `Type` -- never guessed at, and
 * never partially imported around. Everything scanned before that throw is discarded along with
 * it: there is no partial result to salvage, only a complete report of what still needs a
 * decision, exactly mirroring how the very first, unconditional refusal of unmapped content
 * always worked.
 */
function decodeContent(
  contentElement: XmlElement,
  resolutions: FdxUnknownTypeResolutions,
): DecodedContent {
  const blocks: ScreenplayBlock[] = [];
  const skipped = new Map<string, number>();
  const unknownTypes = new Map<string, { count: number; excerpt: string }>();

  childElements(contentElement).forEach((paragraph, index) => {
    const position = index + 1;
    if (paragraph.tag !== 'Paragraph') {
      throw unmapped(`a <${paragraph.tag}> element inside <Content> (position ${position})`);
    }
    if (paragraph.attrs.StartsNewPage === 'Yes') {
      blocks.push({ id: crypto.randomUUID(), type: 'page_break' });
    }
    const typeAttr = paragraph.attrs.Type;

    if (typeAttr !== undefined && SKIPPABLE_FDX_TYPES.has(typeAttr)) {
      skipped.set(typeAttr, (skipped.get(typeAttr) ?? 0) + 1);
      return;
    }

    if (typeAttr !== undefined && !(typeAttr in FDX_TYPE_TO_BLOCK_TYPE)) {
      const resolution = resolutions[typeAttr];
      if (resolution === undefined) {
        const existing = unknownTypes.get(typeAttr);
        if (existing === undefined) {
          const textElement = firstChildElement(paragraph, 'Text');
          const text = textElement !== undefined ? directText(textElement) : '';
          unknownTypes.set(typeAttr, { count: 1, excerpt: excerptOfText(text) });
        } else {
          existing.count += 1;
        }
        return;
      }
      if (resolution.action === 'skip') {
        skipped.set(typeAttr, (skipped.get(typeAttr) ?? 0) + 1);
      } else {
        blocks.push(buildLeafBlock(paragraph, resolution.blockType));
      }
      return;
    }

    blocks.push(
      typeAttr === undefined
        ? decodeDualDialogue(paragraph, position)
        : decodeLeafParagraph(paragraph, position),
    );
  });

  if (unknownTypes.size > 0) {
    throw new FdxUnknownTypesError(
      Array.from(unknownTypes, ([type, info]) => ({
        type,
        count: info.count,
        excerpt: info.excerpt,
      })),
    );
  }

  return { blocks, skipped };
}

function titleParagraphText(
  paragraph: XmlElement,
): { text: string; alignment: string | undefined; styleTokens: string[] } | undefined {
  const textElement = firstChildElement(paragraph, 'Text');
  if (textElement === undefined) return undefined;
  const styleTokens = (textElement.attrs.Style ?? '')
    .split('+')
    .filter((token) => token.length > 0);
  return { text: directText(textElement), alignment: paragraph.attrs.Alignment, styleTokens };
}

function isBlankTitleParagraph(paragraph: XmlElement): boolean {
  const info = titleParagraphText(paragraph);
  return info === undefined || info.text.length === 0;
}

type DecodedTitleFields = Pick<
  TitlePage,
  'title' | 'credit' | 'authors' | 'source' | 'draftDate' | 'contact'
>;

/**
 * Decodes a `<TitlePage><Content>`'s ordered paragraphs back into named title-page fields, the
 * inverse of `index.ts`'s `titlePageLines`. The encoder places each optional field behind its own
 * fixed blank-line gap (`TITLE_PAGE_LINES_BEFORE_CREDIT` = 3, `..._AUTHOR` = 2, `..._SOURCE` = 4,
 * `..._DRAFT_DATE` = 3, `..._CONTACT` = 3) and -- critically -- that blank-push only ever happens
 * inside the `if` branch for that same field, so a gap is never the sum of two different fields'
 * constants: if a field is absent, nothing at all is pushed for it, and the *next present* field's
 * gap is entirely its own.
 *
 * The one field that looks like an exception is `title`, whose leading run (`titlePageLines`'s
 * `pushBlank(TITLE_PAGE_LINES_BEFORE_TITLE, 'Left')`) is pushed *unconditionally*, outside the
 * `if (titlePage.title !== undefined)` guard -- it exists whether or not a title follows it.
 * **This function used to get exactly that case wrong.** An earlier version consumed this run
 * *inside* `tryTitle`'s own backtracking attempt and reset over it whenever no title paragraph
 * followed, which fed the leading run into the next-present field's own gap check as one merged,
 * wrong-sized gap (17 + 3 instead of 3, when `credit` was present but `title` was not) -- and
 * that merged gap then failed every remaining field's check too, refusing the whole title page.
 * The rule was exact: every one of the 64 combinations of the six optional fields that omitted
 * `title` while containing at least one other field failed; every combination containing `title`
 * passed. See `progress/fdx-import.md`'s Task 1 for the full diagnosis.
 *
 * The fix is to consume this leading run **once, unconditionally, before attempting `title` or
 * any other field**, using the exporter's own `TITLE_PAGE_LINES_BEFORE_TITLE` constant (imported
 * from `index.ts`, not re-hardcoded here, so the two halves of this grammar cannot drift apart
 * again) rather than letting `tryTitle` discover and then possibly un-discover it. `tryTitle`
 * itself no longer consumes or backtracks over any blanks at all -- by the time it runs, the
 * leading run is already gone, and it only ever tests the one paragraph now sitting at `cursor`.
 *
 * Every other field's gap *is* validated exactly, which is what makes this decode safe rather
 * than a guess: if any paragraph's gap, alignment, or style does not match this exact grammar,
 * decoding fails closed (`'unmapped_content'`) rather than mis-assigning text to the wrong field.
 * Verified directly against two independent, non-synthetic sources: `screenplayToFdx`'s own
 * output (this package's round-trip test, including the 64-combination sweep in
 * `import.test.ts`) and the byte-for-byte title page in
 * `packages/fdx/fixtures/final-draft-13-reference.fdx`, which uses this exact gap structure --
 * Final Draft's own default title-page template, not a convention invented for this package.
 *
 * A title page outside this exact shape (a non-standard layout, fewer than
 * `TITLE_PAGE_LINES_BEFORE_TITLE` leading blanks, extra authored content FDX does not use by
 * default) is a real, documented limitation of this slice: it fails closed rather than importing
 * an approximation. See `progress/fdx-import.md`.
 *
 * **`authors` is the one field whose own entries can themselves be blank** (`['Nathan', '', '']`
 * -- a writer leaving vertical space on the title page), and that breaks the fixed-gap grammar
 * above in a way none of the other fields can: `tryAuthors` (below) stops reading authors at the
 * first blank paragraph it meets, by construction, so a trailing blank author entry is left in
 * the paragraph stream for whichever field comes next to misinterpret as part of *its* gap. For
 * `['Nathan', '', '']` followed by `source` (whose own gap is `TITLE_PAGE_LINES_BEFORE_SOURCE` =
 * 4), the next field sees 2 + 4 = 6 blanks, fails its exact-gap check, and -- before this pass's
 * fix -- backtracked, cascading a refusal through every remaining field exactly the way the
 * missing-`title` defect once did. This is the owner's reported failure on
 * `packages/fdx/fixtures/multi-page-script.fdx`.
 *
 * **The fix is deterministic, not a guess**, because every field's gap is a fixed, known
 * constant: when the blank run immediately before a field is *longer* than that field's own
 * expected gap, the *last* `expectedGap` blanks are that field's real gap, and the rest can only
 * be trailing blank entries of the one preceding field capable of producing them -- `authors`.
 * `tryPlainField` takes an optional `authorsForExcess` reference and, only once a field has fully
 * matched (correct alignment and style, not merely a gap count that happens to add up), pushes
 * the excess as empty strings onto that same array. Two things keep this from ever fabricating
 * content: (1) `authorsForExcess` is only ever non-`undefined` when `tryAuthors` actually read at
 * least one author line -- an excess run is never turned into an `authors` array out of nothing;
 * and (2) the push happens strictly after the field's own shape (alignment, zero style tokens)
 * is confirmed, not merely after its gap count matches, so a coincidental gap sum that turns out
 * to belong to the *wrong* field (caught by that field's alignment not matching) backtracks fully
 * with no mutation, exactly like any other failed attempt. The same reasoning covers the case
 * where no field at all follows a trailing-blank `authors` list (the title page simply ends) --
 * handled separately, by the one block below that attributes a final, otherwise-unexplained
 * trailing blank run to `authors` only when nothing after it decoded successfully.
 *
 * Exporting empty `authors` entries unchanged, rather than having `screenplayToFdx` filter them
 * out, was a deliberate choice, not an oversight: those blank lines are real vertical space the
 * writer put on the page, and dropping them on export would be exactly the kind of silent,
 * unrequested normalization this project's import/export slices both refuse to do elsewhere. The
 * cost of keeping them is this decoder; the alternative (filtering on export) would also not have
 * fixed the owner's actual file, which was authored by Final Draft itself, not by this package.
 */
function decodeTitlePageContent(contentElement: XmlElement): DecodedTitleFields {
  const paragraphs = childElements(contentElement);
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.tag !== 'Paragraph' || paragraph.attrs.Type !== 'Title Paragraph') {
      throw unmapped(`a title-page element other than a "Title Paragraph" (position ${index + 1})`);
    }
  });

  let cursor = 0;
  const total = paragraphs.length;

  function consumeBlanks(): number {
    let count = 0;
    while (cursor < total && isBlankTitleParagraph(paragraphs[cursor]!)) {
      cursor += 1;
      count += 1;
    }
    return count;
  }

  // The unconditional leading run, consumed exactly once, before `title` or any other field is
  // attempted, and never undone by a later backtrack -- see this function's doc comment above for
  // why that ordering is the entire fix. A paragraph that is not blank stops this loop early
  // (rather than being consumed as though it were blank, which would silently misread real
  // content as filler); the title page then fails closed further down, through the ordinary
  // field checks and the final `cursor !== total` check, exactly as any other malformed sequence
  // does.
  for (let index = 0; index < TITLE_PAGE_LINES_BEFORE_TITLE && cursor < total; index += 1) {
    if (!isBlankTitleParagraph(paragraphs[cursor]!)) break;
    cursor += 1;
  }

  function tryTitle(): string | undefined {
    // No blanks left to consume or backtrack over here -- the leading run above already consumed
    // them unconditionally, once, outside this function. This only ever tests the single
    // paragraph now sitting at `cursor`, and leaves `cursor` untouched if it is not a title, so a
    // title page with no `title` field falls through to the next check with the leading run still
    // correctly consumed.
    if (cursor >= total) return undefined;
    const info = titleParagraphText(paragraphs[cursor]!);
    if (
      info === undefined ||
      info.alignment !== 'Center' ||
      !info.styleTokens.includes('Underline') ||
      !info.styleTokens.includes('AllCaps')
    ) {
      return undefined;
    }
    cursor += 1;
    return info.text;
  }

  // `authorsForExcess` is the array `tryAuthors` produced, or `undefined` when no author line was
  // read at all. Passing it through (rather than reading a shared outer variable) keeps this
  // function's only two call sites honest about exactly when attribution is possible: `credit`
  // (tried before `authors`) always passes `undefined`, and only `source`/`draftDate`/`contact`
  // (tried after) ever pass the real array. See this function's enclosing doc comment for why the
  // attribution itself is safe.
  function tryPlainField(
    expectedGap: number,
    alignment: string,
    authorsForExcess: string[] | undefined,
  ): string | undefined {
    const start = cursor;
    const gap = consumeBlanks();
    const excess = gap - expectedGap;
    if (excess < 0 || cursor >= total) {
      cursor = start;
      return undefined;
    }
    if (excess > 0 && authorsForExcess === undefined) {
      // A longer-than-expected gap with no preceding `authors` list to blame it on is not this
      // field -- back out exactly as the old strict `gap !== expectedGap` check did.
      cursor = start;
      return undefined;
    }
    const info = titleParagraphText(paragraphs[cursor]!);
    if (info === undefined || info.alignment !== alignment || info.styleTokens.length > 0) {
      cursor = start;
      return undefined;
    }
    // Only mutate `authors` once this field's own shape is fully confirmed, never on a gap count
    // that merely happens to add up -- a coincidental match caught by the alignment/style check
    // above backtracks with no mutation, exactly like any other failed attempt.
    for (let index = 0; index < excess; index += 1) {
      authorsForExcess!.push('');
    }
    cursor += 1;
    return info.text;
  }

  function tryAuthors(): string[] | undefined {
    const start = cursor;
    const gap = consumeBlanks();
    if (gap !== TITLE_PAGE_LINES_BEFORE_AUTHOR || cursor >= total) {
      cursor = start;
      return undefined;
    }
    const first = titleParagraphText(paragraphs[cursor]!);
    if (first === undefined || first.alignment !== 'Center' || first.styleTokens.length > 0) {
      cursor = start;
      return undefined;
    }
    const authors = [first.text];
    cursor += 1;
    while (cursor < total && !isBlankTitleParagraph(paragraphs[cursor]!)) {
      const info = titleParagraphText(paragraphs[cursor]!)!;
      if (info.alignment !== 'Center' || info.styleTokens.length > 0) break;
      authors.push(info.text);
      cursor += 1;
    }
    return authors;
  }

  const result: DecodedTitleFields = {};
  const title = tryTitle();
  if (title !== undefined) result.title = title;
  const credit = tryPlainField(TITLE_PAGE_LINES_BEFORE_CREDIT, 'Center', undefined);
  if (credit !== undefined) result.credit = credit;
  const authors = tryAuthors();
  if (authors !== undefined) result.authors = authors;
  const source = tryPlainField(TITLE_PAGE_LINES_BEFORE_SOURCE, 'Center', authors);
  if (source !== undefined) result.source = source;
  const draftDate = tryPlainField(TITLE_PAGE_LINES_BEFORE_DRAFT_DATE, 'Left', authors);
  if (draftDate !== undefined) result.draftDate = draftDate;
  const contact = tryPlainField(TITLE_PAGE_LINES_BEFORE_CONTACT, 'Right', authors);
  if (contact !== undefined) result.contact = contact.split('\n');

  // Trailing filler blanks, if any, are ordinarily inert and consumed without judgement -- *except*
  // when `authors` was read and nothing after it decoded (`source`/`draftDate`/`contact` all
  // absent): in that one case, any paragraphs left between the last author line and the end of
  // the title page cannot be unexplained filler, because `titlePageLines` never pushes a bare
  // blank paragraph with nothing behind it unless it came from `authors` itself. Guarded on all
  // three later fields being absent so this never reattributes blanks that actually belonged to a
  // field that *did* decode (those were already accounted for inside `tryPlainField` above).
  const trailing = consumeBlanks();
  if (
    authors !== undefined &&
    source === undefined &&
    draftDate === undefined &&
    contact === undefined &&
    trailing > 0
  ) {
    for (let index = 0; index < trailing; index += 1) {
      authors.push('');
    }
  }
  if (cursor !== total) {
    throw unmapped(
      `a title page whose paragraph sequence does not match the structure this product ` +
        `recognizes (unrecognized content starting at title-page paragraph ${cursor + 1} of ${total})`,
    );
  }
  return result;
}

/**
 * `decodeTitlePageContent` only ever sets `authors`/`contact` to a non-empty array -- `tryAuthors`
 * always captures at least its first (non-blank, by construction) line, and `tryPlainField`'s
 * `contact` reading only ever splits a non-blank paragraph's text, which can never produce an
 * empty array -- so checking each field for mere presence (`=== undefined`), with no additional
 * `.length === 0` check, is already exhaustive over every value this module can actually produce.
 */
function titlePageFieldsAreEmpty(fields: DecodedTitleFields): boolean {
  return (
    fields.title === undefined &&
    fields.credit === undefined &&
    fields.authors === undefined &&
    fields.source === undefined &&
    fields.draftDate === undefined &&
    fields.contact === undefined
  );
}

/** Every `<Paragraph>` anywhere under `element`, including inside a `<DualDialogue>` wrapper. */
function collectAllParagraphs(element: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  for (const child of childElements(element)) {
    if (child.tag === 'Paragraph') result.push(child);
    result.push(...collectAllParagraphs(child));
  }
  return result;
}

function parsedLeftIndent(paragraph: XmlElement): number | undefined {
  const raw = paragraph.attrs.LeftIndent;
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Recovers `documentSettings` from the body it actually shaped, not from an `<ElementSettings>`
 * block -- `screenplayToFdx` never writes `<ElementSettings>` at all (`progress/fdx-export.md`:
 * "`documentSettings` is not mapped into FDX page-layout settings"), so the only place
 * `characterIndentIn`/`parentheticalIndentIn` actually show up in the file is as the `LeftIndent`
 * on each Character/Parenthetical paragraph *instance*, which `screenplayToFdx`'s `bodyParagraph`
 * writes directly from those settings. This reads the first such instance found anywhere in the
 * document (including inside a `dual_dialogue` block) and falls back to the specification default
 * only when the document has no paragraph of that type to read a value from.
 *
 * **`parentheticalWidthIn` and `pageNumberStyle` cannot be recovered from any FDX this package
 * produces or reads -- confirmed, not assumed:** neither value is written anywhere by
 * `screenplayToFdx` (no attribute encodes a parenthetical's *width*, as opposed to its left
 * indent, and `pageNumberStyle` has no FDX representation in this mapping at all), so both always
 * fall back to `DEFAULT_DOCUMENT_SETTINGS`. This is a real, tested limitation of this slice, not
 * an oversight -- see `progress/fdx-import.md`'s round-trip section for the dedicated test that
 * proves it and the correction to this scope's original "ids cannot survive a round trip" premise
 * that sits beside it.
 */
function decodeDocumentSettings(contentElement: XmlElement, root: XmlElement): DocumentSettings {
  const allParagraphs = collectAllParagraphs(contentElement);
  const characterParagraph = allParagraphs.find(
    (p) => p.attrs.Type === 'Character' && parsedLeftIndent(p) !== undefined,
  );
  const parentheticalParagraph = allParagraphs.find(
    (p) => p.attrs.Type === 'Parenthetical' && parsedLeftIndent(p) !== undefined,
  );

  const sceneNumberOptions = firstChildElement(root, 'SceneNumberOptions');
  const sceneNumbersEnabled =
    sceneNumberOptions?.attrs.ShowNumbersOnLeft === 'Yes'
      ? true
      : sceneNumberOptions?.attrs.ShowNumbersOnLeft === 'No'
        ? false
        : DEFAULT_DOCUMENT_SETTINGS.sceneNumbersEnabled;

  const moresAndContinueds = firstChildElement(root, 'MoresAndContinueds');
  const dialogueBreaks =
    moresAndContinueds !== undefined
      ? firstChildElement(moresAndContinueds, 'DialogueBreaks')
      : undefined;
  const autoMoreContinued =
    dialogueBreaks?.attrs.AutomaticCharacterContinueds === 'Yes'
      ? true
      : dialogueBreaks?.attrs.AutomaticCharacterContinueds === 'No'
        ? false
        : DEFAULT_DOCUMENT_SETTINGS.autoMoreContinued;

  return {
    characterIndentIn: characterParagraph
      ? parsedLeftIndent(characterParagraph)!
      : DEFAULT_DOCUMENT_SETTINGS.characterIndentIn,
    parentheticalIndentIn: parentheticalParagraph
      ? parsedLeftIndent(parentheticalParagraph)!
      : DEFAULT_DOCUMENT_SETTINGS.parentheticalIndentIn,
    // Not recoverable from any FDX this package writes or reads -- see this function's doc
    // comment.
    parentheticalWidthIn: DEFAULT_DOCUMENT_SETTINGS.parentheticalWidthIn,
    pageNumberStyle: DEFAULT_DOCUMENT_SETTINGS.pageNumberStyle,
    sceneNumbersEnabled,
    autoMoreContinued,
  };
}

/**
 * `fdxToScreenplay`'s full result: the validated canonical screenplay, plus the tally of
 * paragraphs that were deliberately left out because this product's canonical model has no field
 * for their `Type` at all (`SKIPPABLE_FDX_TYPES`), plus whether the title page specifically could
 * not be decoded. Returning the tally and the title-page flag rather than only the screenplay is
 * what makes both relaxations honest -- a caller can (and `apps/web`'s import control does) show
 * the writer exactly what was left behind, or what could not be read, and let them decide before
 * the import commits, rather than the package deciding silently on their behalf.
 *
 * `titlePageUnreadable` is `true` exactly when the document had a `<TitlePage>` whose paragraph
 * sequence `decodeTitlePageContent` could not decode (see `fdxToScreenplay`'s own doc comment for
 * why this is reported rather than fatal, since this pass). `screenplay.titlePages` is `[]` in
 * that case -- the title page's content is genuinely lost, not approximated -- while
 * `screenplay.blocks` is the complete, unaffected body: title-page decoding and body decoding are
 * fully independent steps in this function, so a title-page failure can never touch the body.
 */
export type FdxImportResult = {
  screenplay: Screenplay;
  skipped: FdxSkippedTally;
  titlePageUnreadable: boolean;
};

/**
 * Parses and maps a Final Draft `.fdx` document's full text into a validated canonical
 * `Screenplay`, alongside a tally of any content deliberately left out (see `FdxImportResult`).
 * Throws `FdxImportError` with a specific `code` on every failure path this product distinguishes
 * (`plan.md`'s error-taxonomy requirement): `'too_large'` and `'doctype_rejected'` surface
 * directly from `parseFdxXml`; any other malformed-XML failure from the parser is re-thrown as
 * `'not_xml'`; a well-formed XML document whose root is not `<FinalDraft>`, or that has no
 * `<Content>` at all, is `'not_fdx'`; any FDX construct this mapping's *body* decoding cannot
 * represent -- which, as of the owner's relaxation recorded in `progress/fdx-import.md`, excludes
 * `General` (mapped) and the closed `SKIPPABLE_FDX_TYPES` allowlist (skipped and reported, not
 * refused) -- is `'unmapped_content'`; and a document that parses and maps cleanly but yields no
 * body content and no title-page content at all is `'empty_result'` -- the same code used for the
 * (believed unreachable in practice, since every path above already validates its own output)
 * case where the assembled object still fails `screenplaySchema` itself. **`'unmapped_content'`
 * from title-page decoding specifically is the one exception, and does not throw**: see this
 * function's own doc comment above and `FdxImportResult.titlePageUnreadable` for why, since this
 * pass.
 *
 * The returned screenplay's `id` and every `titlePages[].id` are freshly generated
 * (`crypto.randomUUID()`): FDX's `<TitlePage>` element carries no id of its own, and this
 * package's own exporter does not write the *screenplay's* id anywhere in the file either (there
 * is nowhere in FDX for a whole-document identity to live). `annotations` is always `[]`:
 * `screenplayToFdx` never writes annotations to the file in the first place
 * (`progress/fdx-export.md`: "never read by `screenplayToFdx` at all"), so there is nothing for
 * import to recover. See `progress/fdx-import.md` for the complete, precise round-trip statement.
 *
 * `resolutions` is this function's one piece of caller-supplied state, and it is entirely about
 * one thing: how to handle a `<Content>` paragraph `Type` this package does not itself recognize
 * (see `FdxUnknownTypesError`'s own doc comment). Omitted (or any object that does not cover every
 * such `Type` the document actually contains), this call throws `FdxUnknownTypesError` naming
 * every one of them, gathered in a single pass -- that is the intended first call from a UI that
 * has not yet asked the writer anything. Once the caller has a decision for every named `Type`,
 * calling this function again with `resolutions` covering all of them proceeds past that point
 * exactly as if those types had always been mapped or skippable.
 */
export function fdxToScreenplay(
  source: string,
  resolutions: FdxUnknownTypeResolutions = {},
): FdxImportResult {
  let root: XmlElement;
  try {
    root = parseFdxXml(source);
  } catch (error) {
    if (error instanceof FdxXmlError) {
      throw new FdxImportError(error.code, error.message);
    }
    throw error;
  }

  if (root.tag !== 'FinalDraft') {
    throw new FdxImportError(
      'not_fdx',
      `The document's root element is "<${root.tag}>", not "<FinalDraft>". This does not look ` +
        'like a Final Draft (.fdx) document.',
    );
  }

  const contentElement = firstChildElement(root, 'Content');
  if (contentElement === undefined) {
    throw new FdxImportError(
      'not_fdx',
      'The document has no <Content> element, so it carries no screenplay body to import.',
    );
  }

  // Body decoding happens first and is wholly unaffected by anything that follows -- `blocks` is
  // already final by the time the title page is even looked at, which is what makes Task 2's
  // "import the body anyway" guarantee structural rather than a promise this function has to keep
  // across two separate code paths: there is only one path, and the title page's own decoding
  // step can fail without this one having run differently.
  const { blocks, skipped } = decodeContent(contentElement, resolutions);

  const titlePageElement = firstChildElement(root, 'TitlePage');
  const titlePages: TitlePage[] = [];
  let titleFieldsAreEmpty = true;
  let titlePageUnreadable = false;
  if (titlePageElement !== undefined) {
    const titleContentElement = firstChildElement(titlePageElement, 'Content');
    try {
      const fields =
        titleContentElement !== undefined ? decodeTitlePageContent(titleContentElement) : {};
      titleFieldsAreEmpty = titlePageFieldsAreEmpty(fields);
      titlePages.push({ id: crypto.randomUUID(), ...fields });
    } catch (error) {
      // Only `decodeTitlePageContent` itself throws from inside this `try`, and it only ever
      // throws `FdxImportError` (via `unmapped`) -- re-throwing anything else keeps this catch
      // from ever silently swallowing a genuine programming error it was never meant to handle.
      if (!(error instanceof FdxImportError)) throw error;
      // The deliberate exception described in this function's own doc comment: the title page is
      // reported as unreadable, not fatal. `titlePages` stays `[]` (nothing decoded, nothing
      // guessed) and `titleFieldsAreEmpty` stays `true` (its default above), so the `empty_result`
      // check just below still behaves correctly when the body is also empty.
      titlePageUnreadable = true;
    }
  }

  if (blocks.length === 0 && titleFieldsAreEmpty) {
    throw new FdxImportError(
      'empty_result',
      titlePageUnreadable
        ? 'The file parsed as a valid Final Draft document but contained no screenplay body, ' +
          'and its title page could not be read either, so there was nothing to import.'
        : 'The file parsed as a valid Final Draft document but contained no screenplay content to ' +
          'import -- no body paragraphs and no title page content.',
    );
  }

  const documentSettings = decodeDocumentSettings(contentElement, root);
  const titleFromTitlePage = titlePages[0]?.title?.trim();
  const title =
    titleFromTitlePage !== undefined && titleFromTitlePage.length > 0
      ? titleFromTitlePage.slice(0, MAX_SCREENPLAY_TITLE_LENGTH)
      : 'Untitled Screenplay';

  const candidate: Screenplay = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    title,
    titlePages,
    documentSettings,
    blocks,
    annotations: [],
  };

  const validated = safeParseScreenplay(candidate);
  if (!validated.success) {
    throw new FdxImportError(
      'empty_result',
      `The imported screenplay did not pass validation: ${validated.error.message}`,
    );
  }
  return { screenplay: validated.data, skipped, titlePageUnreadable };
}

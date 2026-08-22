import type {
  DialogueColumn,
  DocumentSettings,
  Screenplay,
  ScreenplayBlock,
  TitlePage,
} from '@finaler-draft/screenplay';
import type { ElementIndent } from '@finaler-draft/screenplay/pageFormat';
import {
  ELEMENT_INDENTS,
  MARGIN_LEFT_IN,
  MARGIN_TOP_IN,
  PAGE_HEIGHT_IN,
  PAGE_NUMBER_TOP_IN,
  PAGE_WIDTH_IN,
} from '@finaler-draft/screenplay/pageFormat';
import { escapeFdxText } from './escape.js';

/**
 * The page's nominal bottom margin in inches. `pageFormat` deliberately exports no
 * `MARGIN_BOTTOM_IN` -- a screenplay page ends on a whole line, so the real bottom margin varies --
 * but `BODY_HEIGHT_IN` is itself derived as `PAGE_HEIGHT_IN - MARGIN_TOP_IN - 1.0`, making 1.0in
 * the specification's own nominal figure. FDX requires a single number, so that is the one to give
 * it.
 */
const NOMINAL_BOTTOM_MARGIN_IN = 1.0;

/**
 * The `<FontSpec>` child Final Draft writes inside several settings elements, copied verbatim from
 * the reference.
 *
 * Emitted because **trimming these sections to only the attributes and children we care about
 * produced a file Final Draft could not open at all** -- a worse failure than the unpaginated file
 * it replaced, and one caused by treating an element's shape as optional decoration. The lesson is
 * recorded in `progress/fdx-export.md`: for a section we do not own, reproduce the reference's
 * shape exactly and substitute only the values this product genuinely defines.
 *
 * The typeface named here is Final Draft's own bundled Courier, not `pageFormat`'s `TYPEFACE`.
 * That is deliberate and is not a values-versus-structure inconsistency: this is the font Final
 * Draft renders *its own* generated `(MORE)`/`CONT'D` and scene-number furniture in, not the
 * manuscript face, and naming a font its installation may not have would be worse than leaving its
 * default in place.
 */
const REFERENCE_FONT_SPEC =
  '<FontSpec AdornmentStyle="0" Font="Courier Final Draft" RevisionID="0" Size="12" Style=""/>';

export { escapeFdxText } from './escape.js';

/**
 * Serializes a canonical `Screenplay` (`packages/screenplay`) to a Final Draft `.fdx` document.
 * Pure by design -- no DOM, filesystem, network, or server -- per this package's scope
 * (`progress/fdx-export.md`): the same function must later serve a server-side export of a
 * historical revision, which the PDF slice needs anyway, so building it pure now means that
 * later slice adds a caller rather than a rewrite.
 *
 * Takes **canonical** input, not editor input. The editor (`apps/web/src/screenplayEditor.ts`)
 * refuses `dual_dialogue`, `page_break`, annotations, and multiple title pages, but all of those
 * are valid canonical screenplays that will exist once FDX import lands -- this function has no
 * such licence and must handle every one of them explicitly. `renderBody`'s `switch` is
 * exhaustive over `ScreenplayBlock`'s discriminated union today; the `default` branch exists so a
 * block type the schema grows before this package is updated throws loudly instead of being
 * silently dropped from the exported script.
 *
 * **This mapping is built against a genuine Final Draft 13 reference file**
 * (`packages/fdx/fixtures/final-draft-13-reference.fdx`, provenance in the sibling `README.md`),
 * not against third-party descriptions of the format. An earlier version of this package was
 * built from third-party sources only and produced a document Final Draft rejected outright
 * ("This file was created in an older Final Draft format"). Every structural choice below --
 * element/attribute names, attribute order, when a paragraph self-closes, the `Style="AllCaps"`
 * convention, the title page's `Title Paragraph` shape -- is read directly from that reference,
 * not inferred. Where this package still has no genuine reference to check against
 * (`dual_dialogue`, the exact position of `draftDate`/`contact` on the title page), that is
 * recorded explicitly in `progress/fdx-export.md` rather than presented as confirmed.
 */
export function screenplayToFdx(screenplay: Screenplay): string {
  const body = renderBody(screenplay.blocks, screenplay.documentSettings);
  const titlePageXml = renderTitlePage(screenplay.titlePages);

  return (
    `${XML_DECLARATION}\n` +
    `<FinalDraft DocumentType="Script" Template="No" Version="${FINAL_DRAFT_VERSION}">\n` +
    `  <Content>\n${body}  </Content>\n` +
    renderPageLayout() +
    titlePageXml +
    renderMoresAndContinueds(screenplay.documentSettings) +
    renderSceneNumberOptions(screenplay.documentSettings) +
    `</FinalDraft>\n`
  );
}

// Byte-identical to the reference file's declaration -- no space before `?>`, unlike the
// (incorrect, third-party-derived) declaration this package used before.
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>';

// The reference file's root `Version` attribute. The most likely direct cause of Final Draft's
// rejection of this package's first version was `Version="1"`, taken from third-party exporters
// with no genuine Final Draft file to check it against; "6" is what Final Draft 13 itself writes.
const FINAL_DRAFT_VERSION = '6';

function requiredIndentValue(indent: ElementIndent, field: 'leftIn' | 'rightIn'): number {
  const value = indent[field];
  if (value === undefined) {
    throw new Error(`ELEMENT_INDENTS.${field} is unset; the FDX indent derivation is stale.`);
  }
  return value;
}

type BodyParagraphType =
  | 'Scene Heading'
  | 'Action'
  | 'Character'
  | 'Parenthetical'
  | 'Dialogue'
  | 'Transition'
  | 'Shot';

/**
 * A body paragraph's `Alignment`, `LeftIndent`, and whether its `Text` carries `Style="AllCaps"`
 * -- confirmed structurally from the reference (every Content paragraph carries exactly these
 * three pieces of per-instance formatting; `Style="AllCaps"` appears on Scene Heading, Character,
 * Transition, and Shot text and nowhere else). The `LeftIndent` *values* come from our own
 * specification (`packages/screenplay/src/pageFormat.ts`'s `ELEMENT_INDENTS`) and, for character
 * and parenthetical, this screenplay's own `documentSettings` -- not copied from the reference
 * file's numbers, which are Final Draft's own out-of-the-box defaults for an unmodified script
 * and legitimately differ from ours (our `character` indent is 3.7in by specification, not Final
 * Draft's default 3.5in). Matching the reference's *structure* while keeping our own *values* is
 * the distinction the rebuild is built on.
 */
function bodyParagraphStyleFor(
  type: BodyParagraphType,
  documentSettings: DocumentSettings,
): { alignment: 'Left' | 'Right'; leftIn: number; allCaps: boolean } {
  switch (type) {
    case 'Scene Heading':
      return {
        alignment: 'Left',
        leftIn: requiredIndentValue(ELEMENT_INDENTS.scene_heading, 'leftIn'),
        allCaps: true,
      };
    case 'Action':
      return {
        alignment: 'Left',
        leftIn: requiredIndentValue(ELEMENT_INDENTS.action, 'leftIn'),
        allCaps: false,
      };
    case 'Character':
      return { alignment: 'Left', leftIn: documentSettings.characterIndentIn, allCaps: true };
    case 'Parenthetical':
      return { alignment: 'Left', leftIn: documentSettings.parentheticalIndentIn, allCaps: false };
    case 'Dialogue':
      return {
        alignment: 'Left',
        leftIn: requiredIndentValue(ELEMENT_INDENTS.dialogue, 'leftIn'),
        allCaps: false,
      };
    case 'Transition':
      // `ELEMENT_INDENTS.transition` has no `leftIn` -- the specification only fixes a
      // right-aligned Transition's right edge (see pageFormat.ts's own comment on one-sided
      // indents), so there is no natural left-indent value to derive the way there is for every
      // other element. `MARGIN_LEFT_IN`, the same left edge every other body element shares, is
      // used rather than inventing a narrower box to match the reference's own (unexplained,
      // Transition-specific) 5.50in: `Alignment="Right"` is what actually positions the text
      // within the box, not `LeftIndent`.
      return { alignment: 'Right', leftIn: MARGIN_LEFT_IN, allCaps: true };
    case 'Shot':
      return {
        alignment: 'Left',
        leftIn: requiredIndentValue(ELEMENT_INDENTS.shot, 'leftIn'),
        allCaps: true,
      };
  }
}

/**
 * Builds one body `<Paragraph>`. Attribute order (`Alignment`, `LeftIndent`, optional `Number`,
 * optional `StartsNewPage`, `Type`, `id`) is not arbitrary -- the reference file writes every
 * paragraph's attributes in strict ASCII-sorted order (confirmed independently on both the body
 * `Content` paragraphs and the `TitlePage` paragraphs, which have a different, larger attribute
 * set but are *also* alphabetical), so this reproduces that ordering rather than picking one.
 *
 * A block with empty text self-closes with no `<Text>` child at all -- confirmed directly in the
 * reference (`<Paragraph ... Type="Character" id="..."/>` for an empty Character block), which is
 * not what the third-party sample this package used before did (`<Text></Text>`). `id` is the
 * canonical block's own stable id: the reference's paragraph `id` is a UUID, which is exactly what
 * `packages/screenplay`'s `stableIdSchema` already gives every block, so this takes that identity
 * rather than inventing a parallel one.
 */
function bodyParagraph(
  type: BodyParagraphType,
  text: string,
  id: string,
  documentSettings: DocumentSettings,
  options: { number?: string; startsNewPage?: boolean } = {},
): string {
  const style = bodyParagraphStyleFor(type, documentSettings);
  const attrs = [`Alignment="${style.alignment}"`, `LeftIndent="${style.leftIn.toFixed(2)}"`];
  if (options.number !== undefined) {
    attrs.push(`Number="${escapeFdxText(options.number)}"`);
  }
  if (options.startsNewPage === true) {
    attrs.push('StartsNewPage="Yes"');
  }
  attrs.push(`Type="${type}"`, `id="${id}"`);
  const openTag = `    <Paragraph ${attrs.join(' ')}`;

  if (text.length === 0) {
    return `${openTag}/>\n`;
  }
  const styleAttr = style.allCaps ? ' Style="AllCaps"' : '';
  return `${openTag}>\n      <Text${styleAttr}>${escapeFdxText(text)}</Text>\n    </Paragraph>\n`;
}

type DialogueColumnBlock = DialogueColumn['blocks'][number];

function dialogueColumnBlockType(
  block: DialogueColumnBlock,
): 'Character' | 'Parenthetical' | 'Dialogue' {
  switch (block.type) {
    case 'character':
      return 'Character';
    case 'parenthetical':
      return 'Parenthetical';
    case 'dialogue':
      return 'Dialogue';
  }
}

/**
 * `dual_dialogue`'s FDX shape: an outer `<Paragraph>` (the `dual_dialogue` block's own id, no
 * `Type`) wrapping a `<DualDialogue>` element that itself contains ordinary typed paragraphs for
 * the left column's blocks, then the right column's, in order -- no per-column wrapper, order
 * alone distinguishes the columns.
 *
 * **This remains the checkpoint-1 policy decision, unverified against genuine Final Draft
 * output.** The FD13 reference (`packages/fdx/fixtures/final-draft-13-reference.fdx`) contains no
 * dual-dialogue example -- confirmed by grepping it for `DualDialogue`, nothing matches. The shape
 * below is unchanged from before: sourced from Beat (github.com/lmparppei/Beat), itself derived
 * from screenplain. `dual_dialogue` is unreachable in this codebase today (the editor refuses it,
 * and nothing can produce one until FDX import lands), so this mapping costs nothing if it turns
 * out to be wrong and gives import a concrete thing to verify against a real file. **Must be
 * checked against a genuine Final Draft file before import ships anything that can produce one.**
 */
function dualDialogueParagraph(
  block: Extract<ScreenplayBlock, { type: 'dual_dialogue' }>,
  documentSettings: DocumentSettings,
  startsNewPage: boolean,
): string {
  const columnParagraphs = [...block.left.blocks, ...block.right.blocks]
    .map((column) =>
      bodyParagraph(dialogueColumnBlockType(column), column.text, column.id, documentSettings),
    )
    .join('');
  const attrs = [...(startsNewPage ? ['StartsNewPage="Yes"'] : []), `id="${block.id}"`];
  return (
    `    <Paragraph ${attrs.join(' ')}>\n` +
    `      <DualDialogue>\n${columnParagraphs}      </DualDialogue>\n` +
    `    </Paragraph>\n`
  );
}

/**
 * Renders `screenplay.blocks` to the `<Content>` body. `page_break` has no direct FDX element of
 * its own. What the reference does confirm is `StartsNewPage="Yes"` as a real Final Draft
 * paragraph attribute (present in every `ElementSettings`'s default `ParagraphSpec`, e.g. `New
 * Act` always starts a new page) -- but the reference has no *forced*, ad hoc page break in its
 * `Content`, so this attribute's use on an arbitrary body paragraph (rather than as a per-type
 * style default) is corroborated, not confirmed. Given that, this attaches `StartsNewPage="Yes"`
 * to the paragraph immediately following a `page_break` block rather than synthesizing an empty
 * paragraph: an empty paragraph would shift every page after a forced break down by one line,
 * which this project cannot take (plan.md: "a script that previews at 112 pages must not export
 * at 113"), and is a strictly worse guess than reusing a real, if not fully exercised, attribute.
 *
 * Two degenerate cases follow and are deliberate, tested FDX limitations, not bugs: consecutive
 * `page_break` blocks collapse to a single `StartsNewPage="Yes"` (FDX cannot express "two blank
 * pages" through this attribute), and a trailing `page_break` with nothing after it renders
 * nothing at all.
 */
/** Inches to PostScript points, the unit `PageLayout`'s margins are expressed in. */
function pointsFromInches(inches: number): string {
  return String(Math.round(inches * 72));
}

/**
 * The page geometry Final Draft paginates against. **Omitting this is what made an accepted export
 * render as one continuous page**: with no `PageSize` and no margins, a renderer has no page to
 * break at, which looks like a missing feature rather than a missing element.
 *
 * Structure is taken from the reference; the values are ours. That distinction is deliberate and
 * is the same one governing `LeftIndent`: `packages/screenplay/pageFormat` is normative for this
 * product, and the whole purpose of `packages/layout` is that our pagination is authoritative, so
 * emitting Final Draft's own defaults here would let the file disagree with the page count we
 * computed. `plan.md`: "a script that previews at 112 pages must not export at 113."
 *
 * Note the unit change, which is the easy thing to get wrong here: `PageSize` is in inches, while
 * every margin attribute is in points. A silent conversion error would produce a file that
 * paginates -- at the wrong length -- which is worse than one that does not paginate at all,
 * because it looks correct.
 *
 * `MARGIN_BOTTOM_IN` deliberately does not exist in `pageFormat` (a screenplay page ends on a whole
 * line, so its bottom margin varies between `MARGIN_BOTTOM_MIN_IN` and `MARGIN_BOTTOM_MAX_IN`).
 * FDX wants a single fixed number, so this uses the nominal 1.0in that `BODY_HEIGHT_IN` itself is
 * derived from -- the same figure the specification already treats as the page's nominal bottom.
 */
function renderPageLayout(): string {
  return (
    `  <PageLayout BottomMargin="${pointsFromInches(NOMINAL_BOTTOM_MARGIN_IN)}"` +
    ` BreakDialogueAndActionAtSentences="Yes" DocumentLeading="Normal"` +
    ` FooterMargin="${pointsFromInches(PAGE_NUMBER_TOP_IN)}"` +
    ` HeaderMargin="${pointsFromInches(PAGE_NUMBER_TOP_IN)}"` +
    ` InvisiblesColor="#808080808080"` +
    ` TopMargin="${pointsFromInches(MARGIN_TOP_IN)}" UsesSmartQuotes="Yes">\n` +
    `    <PageSize Height="${PAGE_HEIGHT_IN.toFixed(2)}" Width="${PAGE_WIDTH_IN.toFixed(2)}"/>\n` +
    `    <AutoCastList AddParentheses="Yes" AutomaticallyGenerate="Yes" CastListElement="Cast List"/>\n` +
    `  </PageLayout>\n`
  );
}

/**
 * Final Draft's own `(MORE)`/`CONT'D` behaviour, driven by `documentSettings.autoMoreContinued`.
 *
 * This has to be emitted rather than left to Final Draft's defaults. A writer who turned the
 * setting off did so deliberately (`plan.md`'s "(MORE) and CONT'D" section makes it a document
 * setting), and Final Draft defaults it on -- so saying nothing would mean the exported file
 * re-adds exactly the markers we suppressed, and the page count would shift with them.
 */
function renderMoresAndContinueds(documentSettings: DocumentSettings): string {
  const on = documentSettings.autoMoreContinued ? 'Yes' : 'No';
  return (
    `  <MoresAndContinueds>\n` +
    `    ${REFERENCE_FONT_SPEC}\n` +
    `    <DialogueBreaks AutomaticCharacterContinueds="${on}" BottomOfPage="${on}"` +
    ` DialogueBottom="(MORE)" DialogueTop="(CONT&apos;D)" TopOfNext="${on}"/>\n` +
    `    <SceneBreaks ContinuedNumber="No" SceneBottom="(CONTINUED)" SceneBottomOfPage="No"` +
    ` SceneTop="CONTINUED:" SceneTopOfNext="No"/>\n` +
    `  </MoresAndContinueds>\n`
  );
}

/**
 * Scene-number display, driven by `documentSettings.sceneNumbersEnabled`.
 *
 * The reference independently corroborates two decisions this product already made from the
 * owner's own production notes: `ShowNumbersOnLeft`/`ShowNumbersOnRight` are both `Yes`, matching
 * plan.md's "Locked scripts" requirement that numbers print in **both** margins; and
 * `NumberScheme="1A"` is the suffix form (`25A`), not a prefix. Final Draft's own file format
 * agrees with the convention recorded in plan.md.
 *
 * `NumberScheme` is emitted unconditionally because it describes how numbers are *formed*, which
 * is a property of the locked-script convention rather than of whether they are currently shown.
 */
function renderSceneNumberOptions(documentSettings: DocumentSettings): string {
  const shown = documentSettings.sceneNumbersEnabled ? 'Yes' : 'No';
  // Attribute order here is the reference's own, which is NOT alphabetical for this element --
  // evidence that the alphabetical ordering seen on `Paragraph` is a per-element convention rather
  // than a document-wide rule, so each element's order is copied from the reference individually.
  return (
    `  <SceneNumberOptions LeftLocation="0.75" RightLocation="7.38"` +
    ` ShowNumbersOnLeft="${shown}" ShowNumbersOnRight="${shown}"` +
    ` NumberScheme="1A" AutoHideNumbersOnRight="No">\n` +
    `    ${REFERENCE_FONT_SPEC}\n` +
    `  </SceneNumberOptions>\n`
  );
}

function renderBody(
  blocks: readonly ScreenplayBlock[],
  documentSettings: DocumentSettings,
): string {
  const paragraphs: string[] = [];
  let pendingPageBreak = false;

  for (const block of blocks) {
    if (block.type === 'page_break') {
      pendingPageBreak = true;
      continue;
    }

    const startsNewPage = pendingPageBreak;
    pendingPageBreak = false;

    switch (block.type) {
      case 'scene_heading':
        paragraphs.push(
          bodyParagraph('Scene Heading', block.text, block.id, documentSettings, {
            ...(block.sceneNumber !== undefined ? { number: block.sceneNumber } : {}),
            startsNewPage,
          }),
        );
        break;
      case 'action':
        paragraphs.push(
          bodyParagraph('Action', block.text, block.id, documentSettings, { startsNewPage }),
        );
        break;
      case 'character':
        paragraphs.push(
          bodyParagraph('Character', block.text, block.id, documentSettings, { startsNewPage }),
        );
        break;
      case 'dialogue':
        paragraphs.push(
          bodyParagraph('Dialogue', block.text, block.id, documentSettings, { startsNewPage }),
        );
        break;
      case 'parenthetical':
        paragraphs.push(
          bodyParagraph('Parenthetical', block.text, block.id, documentSettings, { startsNewPage }),
        );
        break;
      case 'transition':
        paragraphs.push(
          bodyParagraph('Transition', block.text, block.id, documentSettings, { startsNewPage }),
        );
        break;
      case 'shot':
        paragraphs.push(
          bodyParagraph('Shot', block.text, block.id, documentSettings, { startsNewPage }),
        );
        break;
      case 'dual_dialogue':
        paragraphs.push(dualDialogueParagraph(block, documentSettings, startsNewPage));
        break;
      default: {
        // Unreachable while ScreenplayBlock's discriminated union covers exactly these cases --
        // this throws instead of silently skipping if the schema ever grows a new block type
        // before this package is updated to handle it (this scope's explicit requirement: "An
        // unhandled block type must throw, never be silently skipped").
        const unhandled: never = block;
        throw new Error(
          `screenplayToFdx cannot represent unknown block type: ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }

  return paragraphs.join('');
}

/**
 * 32-bit FNV-1a, used only to build a deterministic, UUID-*shaped* id for a title-page line (see
 * `deterministicTitlePageLineId`). Not cryptographic and not meant to be -- these ids carry no
 * meaning to import or to our own model, so collision resistance beyond "vanishingly unlikely
 * across a few dozen short, distinct seeds" is not a real requirement here.
 */
function fnv1a32(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The reference file gives every title-page paragraph -- including the blank filler lines -- a
 * unique `id`. Our canonical `TitlePage` has no per-line identity to give those slots: plan.md
 * deliberately models a title page as named fields, not a block list ("A flat list of blocks was
 * considered and rejected"), so unlike body blocks there is no natural id to take here. This
 * derives one deterministically from the title page's own id and the line's position, rather than
 * `crypto.randomUUID()`, because `screenplayToFdx` must stay pure -- the same screenplay must
 * always produce byte-identical output.
 */
function deterministicTitlePageLineId(titlePageId: string, lineIndex: number): string {
  const bytes: number[] = [];
  let state = fnv1a32(`${titlePageId}:${lineIndex}`);
  for (let index = 0; index < 16; index += 1) {
    state = fnv1a32(`${state}:${index}`);
    bytes.push(state & 0xff);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// The fixed formatting the reference gives every `Title Paragraph`, verbatim (confirmed
// byte-for-byte against `packages/fdx/fixtures/final-draft-13-reference.fdx`; there is no
// `ElementSettings` entry for `Title Paragraph` the way there is for every body type, so Final
// Draft bakes the complete paragraph spec into each instance instead of relying on a shared
// default). Not derived from our own specification: title-page formatting is not part of the six
// adjustable `documentSettings` values, and the reference gives one unvarying answer for it.
const TITLE_PAGE_PARAGRAPH_FIXED_ATTRS =
  'FirstIndent="0.00" Leading="Regular" LeftIndent="1.00" OutlineLevel="1" RightIndent="7.50" ' +
  'SpaceBefore="0" Spacing="1" StartsNewPage="No" Type="Title Paragraph"';

// Ground-truth line counts read directly from the reference's title page (17 blank lines, then
// Title; 3 blank centered lines, then credit; 2 blank centered lines, then each author; 4 blank
// centered lines, then source) -- not Beat's guessed constants, which produced a structurally
// wrong title page (centered-paragraph layout, no `Title Paragraph` type) and are gone entirely.
const TITLE_PAGE_LINES_BEFORE_TITLE = 17;
const TITLE_PAGE_LINES_BEFORE_CREDIT = 3;
const TITLE_PAGE_LINES_BEFORE_AUTHOR = 2;
const TITLE_PAGE_LINES_BEFORE_SOURCE = 4;
// `draftDate`/`contact` positioning is NOT confirmed by the reference: its test script leaves
// both fields blank, so the title page ends after `source` with no trailing content or padding.
// This reuses the same order-of-magnitude gap as the verified fields above rather than inventing
// an unrelated number. Needs the owner's check once a reference title page with these fields
// populated exists.
const TITLE_PAGE_LINES_BEFORE_DRAFT_DATE = 3;
const TITLE_PAGE_LINES_BEFORE_CONTACT = 3;

type TitlePageLine = {
  text: string;
  alignment: 'Left' | 'Center' | 'Right';
  styleTokens?: string[];
};

function titlePageLineXml(line: TitlePageLine, id: string): string {
  const openTag = `      <Paragraph Alignment="${line.alignment}" ${TITLE_PAGE_PARAGRAPH_FIXED_ATTRS} id="${id}"`;
  if (line.text.length === 0) {
    return `${openTag}/>\n`;
  }
  const styleAttr =
    line.styleTokens && line.styleTokens.length > 0 ? ` Style="${line.styleTokens.join('+')}"` : '';
  return (
    `${openTag}>\n` +
    `        <Text Font="Courier Final Draft" Size="12"${styleAttr}>${escapeFdxText(line.text)}</Text>\n` +
    `      </Paragraph>\n`
  );
}

/**
 * The ordered list of title-page paragraph lines. Structure and the four verified gap constants
 * come from the reference (see the constants above); `authors` repeating the same paragraph once
 * per array entry, and `contact`'s `Alignment="Right"` (plan.md: "A contact block in the lower
 * right"), are this function's extrapolations beyond what the reference directly shows -- flagged
 * in `progress/fdx-export.md`, not presented as confirmed. `contact`'s multiple lines join into
 * one paragraph's one `<Text>` with embedded `\n`, matching how a genuine (older) Final Draft file
 * represents a multi-line contact block; see that same progress entry for the provenance.
 */
function titlePageLines(titlePage: TitlePage): TitlePageLine[] {
  const lines: TitlePageLine[] = [];
  const pushBlank = (count: number, alignment: 'Left' | 'Center' | 'Right') => {
    for (let index = 0; index < count; index += 1) {
      lines.push({ text: '', alignment });
    }
  };

  pushBlank(TITLE_PAGE_LINES_BEFORE_TITLE, 'Left');

  if (titlePage.title !== undefined) {
    lines.push({
      text: titlePage.title,
      alignment: 'Center',
      styleTokens: ['Underline', 'AllCaps'],
    });
  }

  if (titlePage.credit !== undefined) {
    pushBlank(TITLE_PAGE_LINES_BEFORE_CREDIT, 'Center');
    lines.push({ text: titlePage.credit, alignment: 'Center' });
  }

  if (titlePage.authors !== undefined && titlePage.authors.length > 0) {
    pushBlank(TITLE_PAGE_LINES_BEFORE_AUTHOR, 'Center');
    for (const author of titlePage.authors) {
      lines.push({ text: author, alignment: 'Center' });
    }
  }

  if (titlePage.source !== undefined) {
    pushBlank(TITLE_PAGE_LINES_BEFORE_SOURCE, 'Center');
    lines.push({ text: titlePage.source, alignment: 'Center' });
  }

  if (titlePage.draftDate !== undefined) {
    pushBlank(TITLE_PAGE_LINES_BEFORE_DRAFT_DATE, 'Left');
    lines.push({ text: titlePage.draftDate, alignment: 'Left' });
  }

  if (titlePage.contact !== undefined && titlePage.contact.length > 0) {
    pushBlank(TITLE_PAGE_LINES_BEFORE_CONTACT, 'Right');
    lines.push({ text: titlePage.contact.join('\n'), alignment: 'Right' });
  }

  return lines;
}

/**
 * FDX's `<TitlePage>` element is singular in every source consulted while researching this
 * package (the genuine reference file, the earlier third-party sources, and Beat's exporter all
 * treat it as one element, never a list) -- there is no established way to represent more than
 * one. Our canonical schema allows up to ten (`MAX_TITLE_PAGES`) because the editor's restriction
 * to one is an editor policy, not a schema limit, so canonical input genuinely can carry more than
 * one once import lands. Exporting only the first would silently drop the rest, which this
 * project's "never silently skip" rule (stated for block types, but the same principle) extends to
 * cover: this throws instead. Unreachable today -- the editor never produces more than one title
 * page.
 */
function renderTitlePage(titlePages: readonly TitlePage[]): string {
  if (titlePages.length > 1) {
    throw new Error(
      `screenplayToFdx supports at most one title page; received ${titlePages.length}. FDX's ` +
        '<TitlePage> element is singular in every source consulted for this package -- see ' +
        'progress/fdx-export.md.',
    );
  }

  const [titlePage] = titlePages;
  if (titlePage === undefined) {
    return '';
  }

  const lines = titlePageLines(titlePage)
    .map((line, index) => titlePageLineXml(line, deterministicTitlePageLineId(titlePage.id, index)))
    .join('');
  return `  <TitlePage>\n    <Content>\n${lines}    </Content>\n  </TitlePage>\n`;
}

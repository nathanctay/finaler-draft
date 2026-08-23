/**
 * Renders `@finaler-draft/layout`'s page-and-line model as ProseMirror decorations.
 *
 * The technique (see progress/page-rendering.md, "The rendering technique"): the document stays
 * ONE contiguous ProseMirror flow -- no per-page containers, which is what keeps selection,
 * cursor movement, and undo working across a page boundary. At every break, a single widget
 * decoration is inserted that:
 *
 *  - draws the outgoing page's `(MORE)` line, if the break split a speech,
 *  - reserves a spacer exactly tall enough to absorb the outgoing page's unused remainder, the
 *    inter-page gap, and the incoming page's top margin, so every page occupies exactly
 *    `PAGE_HEIGHT_IN` of vertical space and the whole flow can be background-painted as a
 *    repeating gradient instead of per-page elements,
 *  - draws the incoming page's number (page 1 is never numbered) positioned relative to that
 *    spacer, and
 *  - draws the incoming page's `CONT'D` heading, if the break split a speech.
 *
 * Nothing here inserts, deletes, or otherwise touches document content: `(MORE)`, `CONT'D`, page
 * numbers, and inter-page spacing are all rendered as decorations precisely because plan.md
 * forbids materialising layout artifacts into the canonical screenplay (see "Page break rules" --
 * doing so would destabilise `canonical_hash`, pollute undo, and duplicate under collaboration).
 *
 * `PAGE_GAP_IN` is the one geometry figure in this module that is NOT sourced from
 * `@finaler-draft/screenplay/pageFormat`, deliberately: the gap between two page rectangles on
 * screen is how far apart the editor chooses to draw them, not a property of the physical
 * manuscript. Per "Manuscript and interface are separate type systems" in plan.md, an interface
 * measurement must not be folded into the page-format module that the PDF renderer and the layout
 * package also read. It is exposed as a CSS custom property (`--fd-page-gap`, set by `App.tsx`)
 * so `styles.css` never hardcodes it either -- this module stays its single source of truth.
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type {
  AuthoredLine,
  GeneratedLine,
  LayoutResult,
  Page,
  PageLine,
} from '@finaler-draft/layout';
import {
  MARGIN_TOP_IN,
  PAGE_HEIGHT_IN,
  PAGE_NUMBER_TOP_IN,
} from '@finaler-draft/screenplay/pageFormat';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@finaler-draft/screenplay';

/** Visual gap, in inches, drawn between two page rectangles in discrete page mode. See the module comment. */
export const PAGE_GAP_IN = 0.25;

/**
 * The minimum height, in inches, the `.page` element must reserve for `pageCount` pages of
 * manuscript. `.page` is content-sized (see the module comment on why: a single contiguous flow,
 * not per-page containers), so once the document's last page is only partly full, the element's
 * natural height stops where the text stops -- short of the repeating-gradient background's next
 * full page-and-gap cycle, leaving the last page's background painted only partway down. Reading
 * `pageCount` off the real `LayoutResult` and forcing `.page` at least this tall keeps the
 * background painting every page in full regardless of how much of the last one has content.
 *
 * Mixes a manuscript constant (`PAGE_HEIGHT_IN`) with an interface one (`PAGE_GAP_IN`) for the
 * same reason `computePageBreaks`'s `spacerHeightIn` does -- see the module comment -- so it lives
 * here rather than in `@finaler-draft/screenplay/pageFormat` (manuscript-only) or
 * `pageGeometryCss.ts` (single-page geometry only).
 *
 * `pageCount` is clamped to at least 1: an empty document still renders one (empty) manuscript
 * page, matching `.page`'s own `min-height: var(--fd-page-height)` fallback for before the first
 * pagination result exists.
 */
export function pageStackMinHeightIn(pageCount: number): number {
  const pages = Math.max(pageCount, 1);
  return pages * PAGE_HEIGHT_IN + (pages - 1) * PAGE_GAP_IN;
}

/**
 * A resolved break between page `pageNumber - 1` and `pageNumber`, in ProseMirror document
 * coordinates. `pos` is where the composite widget (optional `(MORE)`, spacer, optional
 * `CONT'D`) is inserted -- the position immediately after the last authored character that
 * landed on the outgoing page.
 */
export type PageBreak = {
  readonly pos: number;
  readonly spacerHeightIn: number;
  readonly more: GeneratedLine | undefined;
  readonly continued: GeneratedLine | undefined;
  readonly pageNumber: number;
};

/** A page whose first line is a whole new block (not a mid-block continuation after `CONT'D`). */
export type PageTopBlock = {
  readonly pos: number;
  readonly nodeSize: number;
};

/**
 * Maps every top-level `screenplayBlock` node's stable id to its ProseMirror position. The
 * screenplay document is flat (`content: 'screenplayBlock*'`), so a single top-level walk is
 * sufficient and exact -- no recursion into block content is needed to locate a block's start.
 */
export function computeBlockStarts(doc: ProseMirrorNode): ReadonlyMap<string, number> {
  const starts = new Map<string, number>();
  doc.forEach((node, offset) => {
    const id: unknown = node.attrs.id;
    if (typeof id === 'string') {
      starts.set(id, offset);
    }
  });
  return starts;
}

/**
 * The last authored line placed on a page, skipping a trailing `(MORE)` line (which is generated,
 * not part of the document, and so cannot itself anchor a document position). Returns `undefined`
 * for a page with no authored content at all, which `paginateScreenplay` never actually produces
 * for a non-empty document but which this module still guards against rather than assuming.
 */
function lastAuthoredLine(lines: readonly PageLine[]): AuthoredLine | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.kind === 'authored') {
      return line;
    }
    if (line?.kind === 'blank') {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Every page's leading whole-block, if it has one: a page whose first line is an `AuthoredLine`
 * starting at offset 0 of its block, i.e. a block that begins fresh on this page rather than
 * continuing wrapped text (or a `CONT'D` heading) from the page before. Only these blocks need
 * their space-before suppressed -- see "Space before is suppressed at the top of every page" in
 * plan.md and requirement 1 in progress/page-rendering.md. A page whose first line continues a
 * block from the previous page carries no block-level margin at all (mid-block wrap never does),
 * so there is nothing to suppress there.
 */
export function computePageTopBlocks(
  doc: ProseMirrorNode,
  blockStarts: ReadonlyMap<string, number>,
  layout: LayoutResult,
): PageTopBlock[] {
  const topBlocks: PageTopBlock[] = [];
  for (const page of layout.pages) {
    const first = page.lines[0];
    if (first === undefined || first.kind !== 'authored' || first.startOffset !== 0) {
      continue;
    }
    const pos = blockStarts.get(first.blockId);
    if (pos === undefined) {
      continue;
    }
    const node = doc.nodeAt(pos);
    if (!node) {
      continue;
    }
    topBlocks.push({ pos, nodeSize: node.nodeSize });
  }
  return topBlocks;
}

/**
 * Resolves every page break to a document position and the visual data its widget needs.
 * `spacerHeightIn` implements the formula from progress/page-rendering.md exactly:
 * `PAGE_HEIGHT - (TOP_MARGIN + lineCount * LINE_HEIGHT) + GAP + TOP_MARGIN`. The first term,
 * `PAGE_HEIGHT - (TOP_MARGIN + lineCount * LINE_HEIGHT)`, is precisely `Page.bottomMarginIn` as
 * already computed by the layout engine, so it is read from the model directly rather than
 * recomputed from `lineCount` here -- this module has exactly one source for that arithmetic.
 *
 * A break whose last authored line ends exactly at the end of its block is anchored *after* the
 * block node, not at the last character inside it. The distinction is not cosmetic. A widget
 * anchored inside a textblock is rendered as a child of that block's element, and ProseMirror
 * appends an `img.ProseMirror-separator` after a widget that ends a textblock so the cursor
 * position past it stays addressable. That image is an inline box, so it generates a line box of
 * its own: every such break silently added exactly one line of height that the layout engine
 * knows nothing about, and the error accumulated page over page, pushing later pages' content
 * below the page background painted for it. Anchoring between the two blocks makes the widget a
 * sibling in the body's block flow, where it contributes its spacer height and nothing else.
 *
 * A mid-block break -- a dialogue split, where `(MORE)` and `CONT'D` fall between two wrapped
 * lines of one block -- has no block boundary to sit at and is still anchored inside the block.
 * There the widget is followed by the rest of the block's text rather than ending it, so no
 * separator is generated.
 */
export function computePageBreaks(
  doc: ProseMirrorNode,
  blockStarts: ReadonlyMap<string, number>,
  layout: LayoutResult,
): PageBreak[] {
  const breaks: PageBreak[] = [];
  for (let index = 0; index < layout.pages.length - 1; index += 1) {
    const page = layout.pages[index];
    const nextPage = layout.pages[index + 1];
    if (!page || !nextPage) {
      continue;
    }
    const last = lastAuthoredLine(page.lines);
    if (!last) {
      continue;
    }
    const blockStart = blockStarts.get(last.blockId);
    if (blockStart === undefined) {
      continue;
    }
    const block = doc.nodeAt(blockStart);
    if (!block) {
      continue;
    }
    const endsBlock = last.endOffset >= block.content.size;
    const pos = endsBlock ? blockStart + block.nodeSize : blockStart + 1 + last.endOffset;
    const trailing = page.lines[page.lines.length - 1];
    const more =
      trailing?.kind === 'generated' && trailing.reason === 'more' ? trailing : undefined;
    const leading = nextPage.lines[0];
    const continued =
      leading?.kind === 'generated' && leading.reason === 'continued' ? leading : undefined;
    const spacerHeightIn = page.bottomMarginIn + PAGE_GAP_IN + MARGIN_TOP_IN;
    breaks.push({ continued, more, pageNumber: nextPage.pageNumber, pos, spacerHeightIn });
  }
  return breaks;
}

/**
 * Roman-numeral digit table, largest value first, including the four subtractive pairs (CM, CD,
 * XC, XL, IX, IV) so the greedy algorithm below never needs special-casing for them. Page numbers
 * never reach anywhere near the traditional 3999 ceiling, so no thousands-of-thousands extension
 * is needed.
 */
const ROMAN_NUMERAL_DIGITS: ReadonlyArray<readonly [value: number, numeral: string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function toRomanNumeral(value: number): string {
  let remaining = value;
  let numeral = '';
  for (const [digitValue, digitNumeral] of ROMAN_NUMERAL_DIGITS) {
    while (remaining >= digitValue) {
      numeral += digitNumeral;
      remaining -= digitValue;
    }
  }
  return numeral;
}

/**
 * Formats a 1-based page number per `documentSettings.pageNumberStyle` -- plan.md's "Page
 * numbering": "Roman numerals are available as a document setting." The engine's own
 * `Page.pageNumber` is a position, never a printed label (see `packages/layout`'s `model.ts`), so
 * choosing the numeral system is entirely this renderer's job; nothing about it reaches the
 * layout package.
 */
function formatPageNumber(pageNumber: number, style: DocumentSettings['pageNumberStyle']): string {
  return style === 'roman' ? toRomanNumeral(pageNumber) : String(pageNumber);
}

/**
 * Builds the composite DOM widget for one page break: an optional `(MORE)` line at the character
 * indent, a spacer sized to `spacerHeightIn`, the incoming page's number positioned relative to
 * that spacer, and an optional `CONT'D` heading. All of it is `contenteditable="false"` -- none of
 * it is document content, so none of it should be selectable or editable (requirement 4).
 *
 * The page number is positioned relative to the spacer rather than the page: the spacer's own
 * bottom edge is exactly the incoming page's top margin (by construction of `spacerHeightIn`), so
 * `spacerHeightIn - MARGIN_TOP_IN` is the incoming page's physical top, measured from the
 * spacer's own top. Anchoring there (via the spacer's `position: relative`) is what lets the
 * number land correctly without a per-page container to position it against.
 *
 * `pageNumberStyle` defaults to `'arabic'`, matching every other document-settings-aware function
 * in this codebase, so the existing direct callers of this function (its own test file) keep
 * passing unchanged.
 */
export function buildPageBreakWidget(
  pageBreak: PageBreak,
  pageNumberStyle: DocumentSettings['pageNumberStyle'] = 'arabic',
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'page-break-widget';
  wrapper.contentEditable = 'false';
  wrapper.setAttribute('data-page-break', String(pageBreak.pageNumber));

  if (pageBreak.more) {
    const more = document.createElement('div');
    more.className = 'page-break-cue-line page-break-more';
    more.textContent = pageBreak.more.text;
    wrapper.appendChild(more);
  }

  const spacer = document.createElement('div');
  spacer.className = 'page-break-spacer';
  spacer.style.height = `${pageBreak.spacerHeightIn}in`;

  // The seam: two full-width edges, each casting the same box-shadow `.page` and `.title-page`
  // already use, so a body-page boundary reads as two shadowed sheets instead of a grey stripe
  // through one sheet -- see progress/page-separation.md. Both positions are pure arithmetic on
  // `spacerHeightIn` (itself `page.bottomMarginIn + PAGE_GAP_IN + MARGIN_TOP_IN`, per
  // `computePageBreaks`), so no field beyond what the decoration key already encodes
  // (`buildPaginationDecorations`) feeds either one:
  //  - the outgoing edge sits at the outgoing page's bottom margin -- where the background's
  //    white band ends and the gap band begins,
  //  - the incoming edge sits `PAGE_GAP_IN` further down -- where the gap band ends and the
  //    incoming page's top margin begins.
  // Each edge is a small clipped "mask" (styles.css) containing a `.page-break-edge-caster` child
  // much taller than the shadow's own blur radius. A box-shadow's falloff along a straight edge
  // needs the casting box to be tall relative to the blur radius to read as a real sheet edge
  // (verified directly: the same box-shadow rule on a too-short box painted a visibly flatter
  // shadow than `.page`'s, which is 11in tall) -- see the caster's own comment in styles.css.
  // Only the caster's near edge -- the one flush with the physical boundary -- is ever within the
  // mask's clipped strip, so the mask shows exactly the falloff a real tall sheet edge would cast,
  // without the caster's far edge (which sits nowhere near the boundary) contributing anything.
  //
  // The top offset is set as a CSS custom property, not `style.top` directly, because the incoming
  // mask's own `top` (styles.css) has to subtract its clip depth from this value with `calc()`,
  // which only works against a custom property, not an already-resolved inline `top`. styles.css
  // positions both masks full page width by breaking out of .script-body's own margins, the same
  // technique .page-break-number already uses against --fd-page-number-right, and hides them in
  // continuous mode, which draws no page edges at all.
  // Painted first, so the two edge shadows below land on top of it. `.page`'s own box-shadow is
  // cast by a single element spanning every page, so it runs continuously down the left and right
  // of the whole column -- straight through each gap, which made the gap read as a band belonging
  // to the sheets rather than as the canvas showing between them. This covers that bleed with the
  // canvas colour, extending past both page edges far enough to clear the shadow's blur.
  const gapCover = document.createElement('div');
  gapCover.className = 'page-break-gap';
  gapCover.style.setProperty(
    '--fd-page-break-edge-top',
    `${pageBreak.spacerHeightIn - PAGE_GAP_IN - MARGIN_TOP_IN}in`,
  );
  spacer.appendChild(gapCover);

  const outgoingEdge = document.createElement('div');
  outgoingEdge.className = 'page-break-edge page-break-edge-outgoing';
  outgoingEdge.style.setProperty(
    '--fd-page-break-edge-top',
    `${pageBreak.spacerHeightIn - PAGE_GAP_IN - MARGIN_TOP_IN}in`,
  );
  outgoingEdge.appendChild(document.createElement('div')).className = 'page-break-edge-caster';
  spacer.appendChild(outgoingEdge);

  const incomingEdge = document.createElement('div');
  incomingEdge.className = 'page-break-edge page-break-edge-incoming';
  incomingEdge.style.setProperty(
    '--fd-page-break-edge-top',
    `${pageBreak.spacerHeightIn - MARGIN_TOP_IN}in`,
  );
  incomingEdge.appendChild(document.createElement('div')).className = 'page-break-edge-caster';
  spacer.appendChild(incomingEdge);

  const pageNumber = document.createElement('div');
  pageNumber.className = 'page-break-number';
  pageNumber.textContent = `${formatPageNumber(pageBreak.pageNumber, pageNumberStyle)}.`;
  pageNumber.style.top = `${pageBreak.spacerHeightIn - MARGIN_TOP_IN + PAGE_NUMBER_TOP_IN}in`;
  spacer.appendChild(pageNumber);
  wrapper.appendChild(spacer);

  if (pageBreak.continued) {
    const continued = document.createElement('div');
    continued.className = 'page-break-cue-line page-break-continued';
    continued.textContent = pageBreak.continued.text;
    wrapper.appendChild(continued);
  }

  return wrapper;
}

/**
 * One node decoration per scene heading, in document order, numbering them 1-based -- plan.md's
 * "Scene numbers": "every scene heading receives a number, right-aligned." A node decoration
 * (rather than a widget) attaches `data-scene-number` to the block's own DOM node, which
 * `styles.css`'s `::after { content: attr(data-scene-number) }` renders without touching the
 * block's actual text content -- the same convention `computePageTopBlocks`'s `page-top` class
 * already uses for suppressing space-before, and it composes with that decoration cleanly since
 * ProseMirror merges multiple node decorations on the same node.
 *
 * This walks `doc` directly rather than reading the canonical `sceneNumber` field: **scene
 * numbers are never written into the document or persisted onto `sceneNumber`** (that field is
 * reserved for the distinct, not-yet-built Phase 5 locked-numbering feature -- see plan.md's
 * "Scene numbers" section). Numbering here is purely a rendering decoration, recomputed from the
 * live document on every repagination, which is exactly what lets it renumber freely as scenes
 * move without ever touching `canonical_hash`.
 *
 * An empty scene heading -- the ordinary transient state of a heading the writer has not started
 * typing yet -- is skipped entirely: it neither receives a decoration nor consumes a number.
 * plan.md gives no rule for this case, so this is a deliberate choice, not an oversight, made for
 * two reasons. First, the alternative (numbering it but hiding the number, since there is no text
 * to draw a number `::after`) makes the *visible* sequence non-contiguous -- a writer who can see
 * scenes 1, 3, 4 but never 2 reads that as a bug, not as "scene 2 exists but is blank." Second,
 * plan.md already establishes that this numbering "renumbers freely as scenes move" -- a shift is
 * an expected, already-accepted property of this feature, not a new kind of surprise -- so an
 * empty heading claiming its number only once the writer types its first character is the same
 * kind of shift, just triggered by authoring the heading rather than reordering it.
 */
function buildSceneNumberWidget(label: string): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'scene-number';
  wrapper.contentEditable = 'false';
  wrapper.setAttribute('data-scene-number', label);

  const left = document.createElement('span');
  left.className = 'scene-number-left';
  left.textContent = label;

  // The right-margin copy is the same number a second time, purely so the printed page reads
  // correctly when scanned from either edge. Announcing it again would make a screen reader say
  // every scene number twice, so only the left copy is exposed.
  const right = document.createElement('span');
  right.className = 'scene-number-right';
  right.textContent = label;
  right.setAttribute('aria-hidden', 'true');

  wrapper.append(left, right);
  return wrapper;
}

export function computeSceneNumberDecorations(doc: ProseMirrorNode): Decoration[] {
  const decorations: Decoration[] = [];
  let sceneNumber = 0;
  doc.forEach((node, offset) => {
    if (node.attrs.element !== 'scene_heading' || node.textContent === '') {
      return;
    }
    sceneNumber += 1;
    const label = String(sceneNumber);
    // Anchored at `offset + 1` -- just inside the scene heading's own textblock, not between two
    // block nodes. A widget placed *between* blocks makes ProseMirror emit its
    // `img.ProseMirror-separator`, which adds a line box and shifts the page grid (see
    // `computePageBreaks`'s own anchoring comment for the same trap). Inside a textblock is the
    // ordinary, safe position for a widget.
    //
    // `side: -1` keeps it before any text at that position, and `ignoreSelection` stops it
    // capturing a cursor placed at the start of the heading -- the number is display, never a
    // place the writer can put the caret.
    decorations.push(
      Decoration.widget(offset + 1, () => buildSceneNumberWidget(label), {
        ignoreSelection: true,
        key: `scene-number|${label}`,
        side: -1,
      }),
    );
  });
  return decorations;
}

/**
 * Builds the full decoration set for a paginated document: one node decoration per page-top block
 * (suppressing its space-before), one node decoration per scene heading when
 * `documentSettings.sceneNumbersEnabled` (see `computeSceneNumberDecorations`), and one widget
 * decoration per break. Both view modes (discrete pages and continuous scroll) call this with the
 * identical `layout`, so the decorations -- therefore the page count and break positions -- are
 * byte-identical between them by construction. The two modes differ only in `styles.css`'s
 * `.page`/`.page.continuous` background rules; nothing here reads or reacts to the view mode at
 * all.
 *
 * `documentSettings` defaults to the specification's current fixed values (scene numbers off,
 * Arabic page numbers), matching every other document-settings-aware function in this codebase,
 * so this function's own test file's existing calls keep passing unchanged.
 */
export function buildPaginationDecorations(
  doc: ProseMirrorNode,
  layout: LayoutResult,
  documentSettings: DocumentSettings = DEFAULT_DOCUMENT_SETTINGS,
): DecorationSet {
  const blockStarts = computeBlockStarts(doc);
  const decorations: Decoration[] = [];

  for (const topBlock of computePageTopBlocks(doc, blockStarts, layout)) {
    decorations.push(
      Decoration.node(topBlock.pos, topBlock.pos + topBlock.nodeSize, { class: 'page-top' }),
    );
  }

  if (documentSettings.sceneNumbersEnabled) {
    decorations.push(...computeSceneNumberDecorations(doc));
  }

  for (const pageBreak of computePageBreaks(doc, blockStarts, layout)) {
    decorations.push(
      Decoration.widget(
        pageBreak.pos,
        () => buildPageBreakWidget(pageBreak, documentSettings.pageNumberStyle),
        {
          // The key must encode everything the widget draws, not just which page it introduces.
          // ProseMirror treats two widgets with equal keys as the same widget and reuses the
          // existing DOM node without calling the render function again. Keyed on the page number
          // alone, a break whose spacer height changed -- which happens on every edit that changes
          // the outgoing page's line count without moving a block across the boundary -- kept the
          // stale spacer, so the incoming page's frame and its number sat a line or more off, and
          // the correction only appeared on a later edit that happened to change the key.
          // `pageNumberStyle` is included for the identical reason: toggling it changes the
          // rendered text (`4.` vs `IV.`) without changing `pageBreak.pageNumber` itself, so
          // omitting it here would leave the stale numeral system's DOM node in place after the
          // writer switched. Every field `buildPageBreakWidget` reads appears here.
          key: [
            'page-break',
            pageBreak.pageNumber,
            pageBreak.spacerHeightIn,
            pageBreak.more?.text ?? '',
            pageBreak.continued?.text ?? '',
            documentSettings.pageNumberStyle,
          ].join('|'),
          side: 1,
        },
      ),
    );
  }

  return DecorationSet.create(doc, decorations);
}

/** Re-exported for callers (tests, the extension) that need to reason about a raw `Page`. */
export type { LayoutResult, Page };

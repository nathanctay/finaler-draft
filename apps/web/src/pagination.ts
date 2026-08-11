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
 */
export function buildPageBreakWidget(pageBreak: PageBreak): HTMLElement {
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

  const pageNumber = document.createElement('div');
  pageNumber.className = 'page-break-number';
  pageNumber.textContent = `${pageBreak.pageNumber}.`;
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
 * Builds the full decoration set for a paginated document: one node decoration per page-top block
 * (suppressing its space-before) and one widget decoration per break. Both view modes (discrete
 * pages and continuous scroll) call this with the identical `layout`, so the decorations --
 * therefore the page count and break positions -- are byte-identical between them by
 * construction. The two modes differ only in `styles.css`'s `.page`/`.page.continuous` background
 * rules; nothing here reads or reacts to the view mode at all.
 */
export function buildPaginationDecorations(
  doc: ProseMirrorNode,
  layout: LayoutResult,
): DecorationSet {
  const blockStarts = computeBlockStarts(doc);
  const decorations: Decoration[] = [];

  for (const topBlock of computePageTopBlocks(doc, blockStarts, layout)) {
    decorations.push(
      Decoration.node(topBlock.pos, topBlock.pos + topBlock.nodeSize, { class: 'page-top' }),
    );
  }

  for (const pageBreak of computePageBreaks(doc, blockStarts, layout)) {
    decorations.push(
      Decoration.widget(pageBreak.pos, () => buildPageBreakWidget(pageBreak), {
        // The key must encode everything the widget draws, not just which page it introduces.
        // ProseMirror treats two widgets with equal keys as the same widget and reuses the
        // existing DOM node without calling the render function again. Keyed on the page number
        // alone, a break whose spacer height changed -- which happens on every edit that changes
        // the outgoing page's line count without moving a block across the boundary -- kept the
        // stale spacer, so the incoming page's frame and its number sat a line or more off, and
        // the correction only appeared on a later edit that happened to change the key. Every
        // field `buildPageBreakWidget` reads appears here.
        key: [
          'page-break',
          pageBreak.pageNumber,
          pageBreak.spacerHeightIn,
          pageBreak.more?.text ?? '',
          pageBreak.continued?.text ?? '',
        ].join('|'),
        side: 1,
      }),
    );
  }

  return DecorationSet.create(doc, decorations);
}

/** Re-exported for callers (tests, the extension) that need to reason about a raw `Page`. */
export type { LayoutResult, Page };

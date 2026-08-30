/**
 * The caret at a mid-block page seam.
 *
 * `pagination.ts` anchors a mid-block page break INSIDE the block it splits (`computePageBreaks`:
 * `blockStart + 1 + last.endOffset` when the last line on the outgoing page does not end the
 * block), so a long action beat or speech renders as two runs of text with the break widget
 * between them. A writer who clicks at the visual start of page 2 sees the caret appear at the end
 * of page 1.
 *
 * What a spike measured in real Chrome, against the real editor, before any of this was written
 * (recorded in full in progress/page-seam-caret.md):
 *
 *  1. The seam is ONE document position with two DOM realizations. `posAtDOM` from the text node
 *     before the widget and from the text node after it return the same integer under either
 *     `bias`; a widget decoration consumes no document range, so there is genuinely only one
 *     position. This is caret affinity, not two positions.
 *  2. `posAtCoords` for a click at the top of page 2 returns that same position -- there is no
 *     downstream position for it to resolve to -- and ProseMirror then renders the selection at
 *     the upstream DOM anchor.
 *  3. Setting the DOM selection to the downstream node holds for one frame and is rewritten back
 *     upstream by ProseMirror's own selection sync, with no dispatch involved. A click handler
 *     that moves the DOM selection is therefore not durable.
 *  4. Flipping the break widget's decoration `side` from `1` to `-1` makes a downstream click
 *     stick, but only inverts the defect (the end of page 1 then renders downstream) and is a
 *     global choice that cannot express which side a particular writer meant.
 *  5. Keyboard navigation across the seam is unaffected: Right and Down both walk it cleanly.
 *     Only pixel-coordinate clicks at the boundary are wrong.
 *
 * So this module does not fight ProseMirror's selection. The real selection is left exactly where
 * ProseMirror puts it -- one position, upstream DOM anchor, untouched -- and when the click says
 * the writer meant the downstream side, the native caret is suppressed for that one block and a
 * caret is drawn at the downstream DOM position instead.
 *
 * That is cosmetic by construction rather than by hope, and the reason is worth stating exactly:
 * both sides of the seam ARE the same document position. Text typed there enters the document at
 * that position whichever side the caret was drawn on; pagination then recomputes and the break
 * lands where the layout model says it lands. Nothing downstream of this module can observe which
 * side was drawn -- not the canonical screenplay, not `canonical_hash`, not a save, not an export.
 * The only thing that differs is which of two pixels the writer is looking at.
 *
 * Three properties are load-bearing:
 *
 *  1. **Nothing enters the document.** Every transaction this module dispatches carries no steps,
 *     exactly like `smartTypeGhost.ts`'s dismiss and `paginationExtension.ts`'s repagination, so
 *     the document never changes and `App.tsx`'s `onUpdate`-driven save never fires. The drawn
 *     caret is a plain DOM element owned by this plugin, not a decoration and not a node in the
 *     document.
 *  2. **The drawn caret takes no part in layout.** It is `position: absolute` inside
 *     `.editor-region`, which is already `position: relative` and is the element that scrolls, so
 *     the caret is outside `.page`'s box tree entirely -- it cannot wrap a line or move a break --
 *     while still scrolling with the manuscript with no scroll listener. This defect class
 *     (an overlay displacing the manuscript) has been fixed four times; the claim is measured in
 *     `page-rendering-persistence.spec.ts` rather than asserted.
 *  3. **The suppression is exactly co-extensive with the drawing.** `caret-color: transparent` is
 *     applied by a node decoration to the single block hosting the seam, and only while a caret is
 *     drawn for it. There is no document-wide rule, and the invariant below guarantees the real
 *     selection is inside that block whenever the class is on it.
 *
 * The invariant that makes all of the above safe: `downstream` is a position this module is
 * drawing at, and it is only ever drawn while the real selection is an empty selection at exactly
 * that position. Every clearing rule in `apply` follows from that one sentence.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { BODY_WIDTH_IN, MARGIN_TOP_IN } from '@finaler-draft/screenplay/pageFormat';
import { paginationPluginKey } from './paginationExtension.js';

/**
 * The CSS specification's fixed definition of the `in` unit. Not a page-format figure -- nothing
 * about the manuscript decides it -- so it is stated here rather than sourced from
 * `pageGeometryCss.ts`, which owns the specification's own inch values and nothing else. It is
 * used only to turn a measured post-zoom pixels-per-inch back into the page's zoom factor.
 */
const CSS_PX_PER_IN = 96;

/** How many DOM siblings past the seam's upstream anchor to look for the break widget. The widget is the immediate next sibling in every case observed in a real browser; the small budget covers a `ProseMirror-separator` or a future sibling decoration without becoming an open-ended scan. */
const SEAM_WIDGET_SEARCH_LIMIT = 3;

/**
 * `downstream` is the seam position currently being drawn at, or `undefined`. `decorations` is the
 * `caret-color: transparent` node decoration for the block that hosts it, carried in state rather
 * than rebuilt per `props.decorations` call so that the frame-rate transactions the pagination and
 * SmartType plugins already dispatch do not each redraw a decoration that has not changed.
 */
export type SeamCaretState = {
  readonly decorations: DecorationSet;
  readonly downstream: number | undefined;
};

type SeamCaretMeta = { readonly downstream: number | undefined };

export const seamCaretPluginKey = new PluginKey<SeamCaretState>('seamCaret');

/**
 * The one node decoration: `caret-color: transparent` (styles.css) on the block that hosts the
 * seam. A node decoration rather than a written-through style attribute because the block's DOM
 * belongs to ProseMirror -- the same convention `computePageTopBlocks`'s `page-top` class and
 * `computeSceneNumberDecorations`'s `data-scene-number` already use.
 *
 * The block, not the editor and not the document: `.ProseMirror` hosts every block, and a
 * `caret-color` there would suppress the caret everywhere the writer might later click. The
 * invariant above is what makes the narrow form sufficient -- the real selection is always inside
 * this block while this decoration exists, so this is the only element whose caret could be
 * painted at all.
 */
function suppressionDecorations(state: EditorState, downstream: number): DecorationSet {
  const $seam = state.doc.resolve(downstream);
  if (!$seam.parent.isTextblock) {
    return DecorationSet.empty;
  }
  return DecorationSet.create(state.doc, [
    Decoration.node($seam.before($seam.depth), $seam.after($seam.depth), {
      class: 'page-seam-caret-host',
    }),
  ]);
}

/**
 * Whether `pos` is a page break anchored inside a text block -- the only shape that has two DOM
 * realizations and therefore the only shape this module has anything to say about. A break that
 * falls between two blocks (`endsBlock` in `computePageBreaks`) anchors the widget as a sibling in
 * `.script-body`'s flow, where the position before it and the position after it are genuinely
 * different document positions and ordinary selection already does the right thing.
 *
 * Read off the pagination plugin's own live decoration set rather than recomputed here: the seam
 * positions are exactly the positions that plugin decorated, and a second derivation would be a
 * second thing free to disagree with it about where a page breaks.
 */
function isMidBlockSeam(state: EditorState, pos: number): boolean {
  const decorations = paginationPluginKey.getState(state)?.decorations;
  if (!decorations) {
    return false;
  }
  const breaks = decorations.find(
    pos,
    pos,
    (spec: { key?: unknown }) => typeof spec.key === 'string' && spec.key.startsWith('page-break|'),
  );
  return breaks.length > 0 && state.doc.resolve(pos).parent.isTextblock;
}

/** The seam's two DOM halves: the break widget between them, and the text node the downstream half starts. */
type SeamDom = {
  readonly downstreamText: Text;
  readonly widget: HTMLElement;
};

/**
 * Resolves a seam position to its DOM, or `undefined` when the DOM is not in the shape this
 * module understands (which is the safe answer everywhere it is called -- nothing is drawn and
 * nothing is suppressed, leaving today's behaviour).
 *
 * `domAtPos(pos, -1)` asks for the upstream side of the seam, which lands either inside the text
 * node that ends the outgoing page or on the block element at the child index just before the
 * widget; both are one step from the widget itself. In a real browser the block's children at a
 * mid-block seam are exactly `[#text, div.page-break-widget, #text]` -- measured, not assumed --
 * so the walk below terminates immediately in practice.
 */
function resolveSeamDom(view: EditorView, pos: number): SeamDom | undefined {
  const upstream = view.domAtPos(pos, -1);
  let candidate: ChildNode | null =
    upstream.node.nodeType === Node.TEXT_NODE
      ? upstream.node.nextSibling
      : (upstream.node.childNodes[upstream.offset] ?? null);

  for (let steps = 0; candidate !== null && steps < SEAM_WIDGET_SEARCH_LIMIT; steps += 1) {
    if (
      candidate instanceof HTMLElement &&
      candidate.classList.contains('page-break-widget') &&
      candidate.nextSibling !== null &&
      candidate.nextSibling.nodeType === Node.TEXT_NODE
    ) {
      return { downstreamText: candidate.nextSibling as Text, widget: candidate };
    }
    candidate = candidate.nextSibling;
  }
  return undefined;
}

/**
 * The rectangle the browser itself reports for a collapsed range at the downstream DOM position --
 * that is, the rectangle it would paint a native caret into if the selection were anchored there.
 * Taking the browser's own answer rather than reconstructing a line box from the type size is what
 * makes "match the native caret" a definition instead of an approximation: the drawn caret's top,
 * height and left are literally the values the native caret would have had.
 */
function downstreamCaretRect(downstreamText: Text): DOMRect {
  const range = document.createRange();
  range.setStart(downstreamText, 0);
  range.setEnd(downstreamText, 0);
  const rects = range.getClientRects();
  return rects[0] ?? range.getBoundingClientRect();
}

/**
 * Post-zoom pixels per manuscript inch, measured off the break widget itself. `.page-break-widget`
 * is given an explicit `width: var(--fd-body-width)` in styles.css (see that rule's own comment
 * for why), so its painted width divided by `BODY_WIDTH_IN` is the page's current scale expressed
 * in the one unit this module needs. Measuring rather than reading `App.tsx`'s zoom state keeps
 * this module free of the application's view state, and reading it off an element that is already
 * in hand avoids a second `querySelector` for `.page`.
 */
function pixelsPerInch(widget: HTMLElement): number {
  const width = widget.getBoundingClientRect().width;
  return width > 0 ? width / BODY_WIDTH_IN : CSS_PX_PER_IN;
}

/**
 * The y coordinate, in viewport pixels, of the incoming sheet's own top edge -- the seam.
 *
 * `.page-break-spacer`'s bottom edge is, by construction in `computePageBreaks`
 * (`spacerHeightIn = page.bottomMarginIn + PAGE_GAP_IN + MARGIN_TOP_IN`), the incoming page's
 * first line position, so exactly `MARGIN_TOP_IN` above it is where that page's paper begins. The
 * spacer is used rather than `.page-break-gap`, which paints the canvas band between the two
 * sheets and would be the more obvious choice, because that element is `display: none` in
 * continuous-scroll mode (styles.css) while the spacer -- the thing that reserves the page's
 * height -- is present and correctly sized in both view modes.
 */
function incomingSheetTopY(widget: HTMLElement): number | undefined {
  const spacer = widget.querySelector('.page-break-spacer');
  if (!spacer) {
    return undefined;
  }
  return spacer.getBoundingClientRect().bottom - MARGIN_TOP_IN * pixelsPerInch(widget);
}

/**
 * Which side of the seam a click at `clientY` meant.
 *
 * The test is the physical one: the writer clicked on the incoming sheet, or they did not. Below
 * the incoming page's top paper edge is page 2 -- its top margin and every line of text on it.
 * At or above that edge is page 1's last line, page 1's own bottom margin, and the canvas gap
 * between the two sheets, all of which are page 1. Choosing the paper edge rather than, say, the
 * midpoint between the two text realizations means the answer is a property of the page geometry
 * and not of how full the outgoing page happened to be.
 *
 * Everything above the edge resolves to `false`, which is precisely today's behaviour: a click at
 * the end of page 1 sets nothing, draws nothing, suppresses nothing.
 */
function clickedIncomingSheet(widget: HTMLElement, clientY: number): boolean {
  const sheetTop = incomingSheetTopY(widget);
  return sheetTop !== undefined && clientY >= sheetTop;
}

/**
 * Records (or clears) the seam position this module should draw at. The transaction carries no
 * steps: no document change, nothing undoable, no save. Exported for the tests that drive the
 * state machine directly; `handleClick` below is the only caller in the application.
 */
export function setSeamCaretDownstream(view: EditorView, downstream: number | undefined): void {
  const meta: SeamCaretMeta = { downstream };
  view.dispatch(view.state.tr.setMeta(seamCaretPluginKey, meta));
}

/**
 * The invariant, in one place: a caret may be drawn at `downstream` only while the real selection
 * is an empty selection at exactly that position. Both `apply` (to decide whether the state
 * survives a transaction) and the view (to decide whether to paint this frame) ask this same
 * question, so the suppression class and the drawn caret can never disagree about it.
 */
function selectionIsAtSeam(state: EditorState, downstream: number): boolean {
  return state.selection.empty && state.selection.from === downstream;
}

const EMPTY_STATE: SeamCaretState = { decorations: DecorationSet.empty, downstream: undefined };

/**
 * The drawn caret's own DOM, and the arithmetic that puts it where the native caret would have
 * been.
 *
 * The element is appended to `.editor-region` -- an ancestor of the editor, never a descendant of
 * `.ProseMirror`. Two reasons, both hard requirements rather than preferences. A node injected
 * into ProseMirror's `contentDOM` is seen by its `DOMObserver` as a document edit and would be
 * read back into the document, which is the one thing this feature must never do. And
 * `.editor-region` is already `position: relative` and is the element that scrolls, so an
 * absolutely positioned child of it is positioned against its padding box and scrolls with the
 * manuscript for free -- no scroll listener, no per-frame reposition, and clipped to the region by
 * its own `overflow: auto` when the seam scrolls out of view.
 */
class SeamCaretView {
  private element: HTMLDivElement | undefined;

  constructor(private readonly view: EditorView) {}

  destroy(): void {
    this.remove();
  }

  /**
   * Paints, moves, or removes the caret for the current state. Called on every view update, which
   * is what keeps the drawn position correct across a repagination that moves the seam's pixels
   * without changing the document (a document-settings change is the one way that happens, since
   * every edit clears the state outright).
   */
  sync(): void {
    const downstream = seamCaretPluginKey.getState(this.view.state)?.downstream;
    if (downstream === undefined || !selectionIsAtSeam(this.view.state, downstream)) {
      this.remove();
      return;
    }
    const seam = resolveSeamDom(this.view, downstream);
    const region = this.view.dom.closest('.editor-region');
    if (!seam || !(region instanceof HTMLElement)) {
      this.remove();
      return;
    }

    const rect = downstreamCaretRect(seam.downstreamText);
    const regionRect = region.getBoundingClientRect();
    const element = this.element ?? this.create(region);
    // Region content coordinates, not viewport ones: the caret is positioned against
    // `.editor-region`'s padding box, whose origin sits at scroll offset zero, so adding the
    // current scroll offset to a viewport measurement converts between the two exactly once and
    // the browser handles every subsequent scroll.
    element.style.top = `${rect.top - regionRect.top + region.scrollTop}px`;
    element.style.left = `${rect.left - regionRect.left + region.scrollLeft}px`;
    element.style.height = `${rect.height}px`;
    // A native caret is a device-independent hairline that scales with the page, and the drawn one
    // sits outside `.page`'s transform, so it has to carry that scale itself to stay the same
    // width as the caret it is standing in for.
    element.style.width = `${pixelsPerInch(seam.widget) / CSS_PX_PER_IN}px`;
  }

  private create(region: HTMLElement): HTMLDivElement {
    const element = document.createElement('div');
    element.className = 'page-seam-caret';
    // Decoration, not content: it must never be read by a screen reader as part of the
    // manuscript, and it must never take a click that belongs to the text beneath it.
    element.setAttribute('aria-hidden', 'true');
    region.append(element);
    this.element = element;
    return element;
  }

  private remove(): void {
    this.element?.remove();
    this.element = undefined;
  }
}

/**
 * The seam caret. Installed from `App.tsx` alongside `PaginationExtension`, whose decorations it
 * reads, rather than inside `screenplayExtensions`: like pagination, the ghost, and the element
 * menu, it is a layer over the screenplay editor and not part of what a block is, so every test
 * that builds a bare editor keeps getting one without it.
 */
export const SeamCaretExtension = Extension.create({
  addProseMirrorPlugins() {
    return [
      new Plugin<SeamCaretState>({
        key: seamCaretPluginKey,
        props: {
          decorations(state) {
            return seamCaretPluginKey.getState(state)?.decorations;
          },
          /**
           * Focus loss clears the drawn caret for the same reason the browser stops painting the
           * native one: a caret is where typing would go, and nothing typed goes there while the
           * manuscript does not have focus. This also covers every piece of chrome the writer
           * might reach for next -- the zoom buttons, a panel toggle, the element selector -- each
           * of which takes focus and any of which could move the manuscript under a caret that had
           * outlived it.
           */
          handleDOMEvents: {
            blur(view) {
              if (seamCaretPluginKey.getState(view.state)?.downstream !== undefined) {
                setSeamCaretDownstream(view, undefined);
              }
              return false;
            },
          },
          /**
           * The whole of the intent decision. Runs after ProseMirror has placed the selection and
           * returns `false` in every case, so the selection this click produced is exactly the
           * selection it produced before this module existed -- including at the end of page 1,
           * where `clickedIncomingSheet` is false and this handler's only effect is to clear a
           * caret drawn by some earlier click.
           */
          handleClick(view, pos, event) {
            const seam = isMidBlockSeam(view.state, pos) ? resolveSeamDom(view, pos) : undefined;
            const downstream =
              seam && clickedIncomingSheet(seam.widget, event.clientY) ? pos : undefined;
            if (downstream !== seamCaretPluginKey.getState(view.state)?.downstream) {
              setSeamCaretDownstream(view, downstream);
            }
            return false;
          },
        },
        state: {
          /**
           * What clears a drawn caret, and why each is the right rule:
           *
           *  - **An edit** (`tr.docChanged`). The seam is a consequence of where the text falls;
           *    changing the text repaginates, and the position drawn at is about to mean something
           *    else. Clearing here also means the writer's first keystroke hands the caret back to
           *    the browser at the moment the two sides stop being interchangeable.
           *  - **A caret move, or a selection.** Both show up as the selection no longer being an
           *    empty selection at the drawn position -- arrow keys, a click anywhere else, a drag,
           *    a command that moves the cursor. This is the invariant stated at the top of the
           *    module, enforced on every transaction rather than at a list of call sites.
           *  - **Focus loss**, via `handleDOMEvents.blur` above.
           *
           * Deliberately NOT a clearing rule: a transaction that changes neither the document nor
           * the selection. The pagination plugin dispatches one of those per animation frame and
           * the SmartType vocabulary refresh dispatches more; a caret that vanished on the next
           * frame would be no feature at all.
           */
          apply(tr, previous, _oldState, newState) {
            const meta = tr.getMeta(seamCaretPluginKey) as SeamCaretMeta | undefined;
            if (meta) {
              return meta.downstream === undefined
                ? EMPTY_STATE
                : {
                    decorations: suppressionDecorations(newState, meta.downstream),
                    downstream: meta.downstream,
                  };
            }
            if (previous.downstream === undefined) {
              return previous;
            }
            if (tr.docChanged || !selectionIsAtSeam(newState, previous.downstream)) {
              return EMPTY_STATE;
            }
            return previous;
          },
          init() {
            return EMPTY_STATE;
          },
        },
        view(editorView) {
          const caret = new SeamCaretView(editorView);
          /**
           * A window resize moves the manuscript without producing a transaction: `.page` is a
           * fixed width centred in `.editor-region`, so a narrower window slides it sideways under
           * a caret that has no other reason to be recomputed. Zoom and panel toggles need no
           * listener of their own -- each is a click on a control, which takes focus from the
           * manuscript, which clears the caret entirely.
           */
          const resync = () => caret.sync();
          window.addEventListener('resize', resync);
          return {
            destroy() {
              window.removeEventListener('resize', resync);
              caret.destroy();
            },
            update() {
              caret.sync();
            },
          };
        },
      }),
    ];
  },
  name: 'seamCaret',
});

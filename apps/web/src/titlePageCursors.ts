import { useEffect, useRef, type RefObject } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import {
  buildRemoteCursorWidget,
  createGlowController,
  isRecentlyActive,
  markPresenceActive,
  PRESENCE_ACTIVE_WINDOW_MS,
  type PresenceUser,
} from '@finaler-draft/screenplay-editor';
import type { TitlePageFieldName } from './titlePageEditor.js';

/**
 * Remote cursors on the title page (progress/collaboration-title-page.md's own "known
 * limitations": slice 2's `createRemotePresenceExtension` is bound to the ProseMirror body via
 * `ySyncPlugin`/`yCursorPlugin`, and the title page -- bare `contentEditable` divs, not a
 * ProseMirror document -- has no decoration surface to attach to at all).
 *
 * This module deliberately does *not* bind the title page to ProseMirror to get one. Instead it
 * extends the awareness state slice 2 already carries with one more optional field
 * (`TitlePageCursor`) and renders it directly against measured DOM geometry, reusing slice 2's own
 * colour/name/expiry machinery (`@finaler-draft/screenplay-editor`'s `presence.ts`) wholesale --
 * see that module's own top-of-file comment for the list of exactly what is shared and why nothing
 * here reimplements it. What *is* new here, because nothing in slice 2 needed it: the title page's
 * fields carry no selection tracking at all before this module, so `titlePageCursorFromSelection`
 * below is this module's own local-cursor signal, not an existing one being read.
 *
 * ## Positioning, and why it is a measured `Range` rect, not arithmetic
 *
 * The screenplay body is a fixed character grid (`NOMINAL_CHARACTERS_PER_INCH`), so a remote
 * caret there can in principle be placed by counting columns. Title-page fields are *centred*
 * text (`.title-page-center`, `.title-page-contact`'s right alignment) -- there is no fixed
 * column width to count from, so the only honest anchor is where the browser itself lays the text
 * out: a collapsed DOM `Range` at the target character offset, read with `getClientRects()`
 * (falling back to `getBoundingClientRect()` for an empty field, matching
 * `presence-persistence.spec.ts`'s own `measureCaretPlacement` convention for the body).
 *
 * ## Staying correct under zoom
 *
 * `.title-page` lives inside `.pages`, the element `App.tsx` applies CSS `zoom` to
 * (`style={{ zoom: zoomPercent / 100 }}`). `getBoundingClientRect()`/`getClientRects()` already
 * report *rendered* (post-zoom) pixel positions, but a value assigned to `style.top`/`style.left`
 * on a descendant of a zoomed ancestor is itself scaled by that same zoom factor again when the
 * browser paints it -- so a rendered-pixel delta cannot be assigned directly, or the caret would
 * end up doubly (or fractionally) displaced the moment zoom is anything but 100%.
 * `computeOverlayPosition` divides the measured delta by the current zoom fraction before
 * returning it, exactly undoing that second scaling; the caller (`useTitlePagePresence`) reads the
 * current zoom fraction from a ref updated on every render, so a zoom change alone (with no
 * awareness event) still triggers a reposition.
 *
 * ## Never inside the `contentEditable` subtree
 *
 * Every widget this module builds is appended as a direct child of the `.title-page` `<article>`
 * itself (the element `containerRef` points at) -- a sibling of `.title-page-center`/
 * `.title-page-contact`, never a descendant of any `[data-title-page-field]` element.
 * `TitlePageField`'s own `onInput` reads `event.currentTarget.textContent`
 * (`titlePageEditor.tsx`), so a caret element rendered *inside* that subtree would become part of
 * the writer's own field value the instant it re-reads `textContent` on their next keystroke --
 * silent data corruption written straight into `TITLE_PAGE_YJS_MAP`. `.title-page` is flex-laid-out
 * (`display: flex; flex-direction: column;`), and an out-of-flow (`position: absolute`, reused
 * from `.remote-cursor`'s existing rule) sibling is excluded from flex space distribution entirely
 * -- it cannot displace `.title-page-center`/`.title-page-contact` regardless of how many widgets
 * are appended.
 *
 * ## An accepted limitation: offsets can go stale on a concurrent edit
 *
 * Title-page fields are plain last-write-wins strings, not `Y.Text`
 * (`progress/collaboration-title-page.md`), so there is no relative-position concept (the body's
 * `Y.RelativePosition`) to keep a remote peer's offset correct across someone else's edit to the
 * *same* field. If the local writer (or the cursor's own owner) changes that field's text, a
 * cursor built from a now-stale offset is re-measured against the *new* text the next time this
 * renders -- clamped (`measureCaretRect`) so it never throws, but not guaranteed to still land
 * where the remote writer's caret visually is until they move it again and broadcast a fresh
 * offset. This is the same cost the owner already accepted for the field's content itself
 * ("a genuinely simultaneous edit... drops one writer's keystroke"), extended to the cursor that
 * marks where that content is being edited.
 */

/** The vocabulary `TitlePageField`'s own `data-title-page-field` attribute uses
 * (`titlePageEditor.tsx`). Re-declared as a value (not only imported as a type) so this module can
 * validate an inbound awareness value against it without trusting the peer's claim. */
const TITLE_PAGE_CURSOR_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'credit',
  'source',
  'draft-date',
  'author',
  'contact',
]);

function isTitlePageFieldName(value: string): value is TitlePageFieldName {
  return TITLE_PAGE_CURSOR_FIELDS.has(value);
}

function isMultiLineField(field: TitlePageFieldName): field is 'author' | 'contact' {
  return field === 'author' || field === 'contact';
}

/** The awareness state this module adds to slice 2's shape: which field a writer's caret is in,
 * which line of a multi-line list (`author`/`contact`) if any, and a plain character offset within
 * that field's own text. Sanitized server-side by `apps/collab/src/presence.ts`'s
 * `sanitizeTitlePageCursor` -- that module duplicates `TITLE_PAGE_CURSOR_FIELDS`' vocabulary rather
 * than importing this one, since the server package must never depend on `apps/web`. */
export type TitlePageCursor = {
  readonly field: TitlePageFieldName;
  readonly lineIndex?: number;
  readonly offset: number;
};

/** The awareness field name both this module's writer and `apps/collab/src/presence.ts`'s reader
 * agree on. Kept as one named constant rather than a repeated string literal so a typo cannot
 * silently desynchronize the two. */
const TITLE_PAGE_CURSOR_AWARENESS_FIELD = 'titlePageCursor';

/** Given a field element and a DOM `Range`'s own `startContainer`/`startOffset` landing somewhere
 * inside it, resolves the plain character offset `TitlePageCursor.offset` needs. A field holds at
 * most one child (a lone `Text` node, `TitlePageField`'s own "uncontrolled but synced" convention)
 * or none at all when empty, so `startContainer` is either that `Text` node (an ordinary character
 * offset) or the field element itself (a *child-index* offset per the DOM Range spec -- `0` before
 * the one child, `1` after it, never anything else given at most one child) -- the second case is
 * what a browser reports for a caret collapsed at the very end of a field's text, and is
 * deliberately translated to "the text's own length" rather than misread as "offset zero". */
function offsetWithinField(
  fieldEl: Element,
  startContainer: Node,
  startOffset: number,
): number | undefined {
  if (startContainer.nodeType === Node.TEXT_NODE && startContainer.parentElement === fieldEl) {
    return startOffset;
  }
  if (startContainer === fieldEl) {
    return startOffset <= 0 ? 0 : (fieldEl.textContent?.length ?? 0);
  }
  return undefined;
}

/**
 * The local half: what this writer's own selection implies about their title-page cursor, or
 * `undefined` if the current selection is not inside `root` (the `.title-page` element) at all --
 * leaving the title page (a click into the manuscript body, or anywhere else) must read as "no
 * cursor here" the same way `yCursorPlugin`'s own `focusout` handler clears the body's `cursor`.
 *
 * `selection` is taken as a parameter, not read from `document.getSelection()` internally, so this
 * pure function is directly testable against a real, hand-built `Range`/`Selection` -- jsdom
 * implements the Selection/Range *tree* API fully; only its *geometry* (`getClientRects`,
 * `getBoundingClientRect`) is the well-documented gap `apps/web/src/test/setup.ts` polyfills, which
 * this function never touches.
 */
export function titlePageCursorFromSelection(
  root: Element,
  selection: Selection | null,
): TitlePageCursor | undefined {
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const anchor = range.startContainer;
  const anchorElement = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
  if (!(anchorElement instanceof Element)) return undefined;
  const fieldEl = anchorElement.closest('[data-title-page-field]');
  if (!fieldEl || !root.contains(fieldEl)) return undefined;

  const fieldAttr = fieldEl.getAttribute('data-title-page-field');
  if (!fieldAttr || !isTitlePageFieldName(fieldAttr)) return undefined;

  const offset = offsetWithinField(fieldEl, anchor, range.startOffset);
  if (offset === undefined) return undefined;

  if (!isMultiLineField(fieldAttr)) {
    return { field: fieldAttr, offset };
  }
  const lines = Array.from(root.querySelectorAll(`[data-title-page-field="${fieldAttr}"]`));
  const lineIndex = lines.indexOf(fieldEl);
  if (lineIndex === -1) return undefined;
  return { field: fieldAttr, lineIndex, offset };
}

/**
 * The remote half: which live field element a peer's `TitlePageCursor` names, or `undefined` if it
 * names a line index that no longer exists (the writer removed that author/contact line since the
 * cursor was broadcast) -- dropped rather than guessed, the same "malformed becomes no cursor
 * shown" convention `apps/collab/src/presence.ts`'s own sanitizers use.
 */
export function locateTitlePageCursorField(
  root: Element,
  cursor: TitlePageCursor,
): HTMLElement | undefined {
  if (isMultiLineField(cursor.field)) {
    if (cursor.lineIndex === undefined) return undefined;
    const lines = root.querySelectorAll(`[data-title-page-field="${cursor.field}"]`);
    const line = lines[cursor.lineIndex];
    return line instanceof HTMLElement ? line : undefined;
  }
  const field = root.querySelector(`[data-title-page-field="${cursor.field}"]`);
  return field instanceof HTMLElement ? field : undefined;
}

/**
 * The caret's own rendered rect at `offset` characters into `fieldEl`'s text -- a collapsed
 * `Range`, read the same way `presence-persistence.spec.ts`'s `measureCaretPlacement` reads the
 * body's own anchor position. `offset` is clamped to the field's *current* text length rather than
 * trusted, since the remote writer who broadcast it may have measured it against a since-changed
 * length (this module's own top-of-file comment on why that staleness is accepted, not solved).
 *
 * An empty field (no text node at all -- `TitlePageField`'s own convention, since `textContent =
 * ''` leaves zero children) has nothing for a `Range` to anchor to; the field's own bounding rect
 * stands in, landing the caret at the field's top-left corner, matching where a real blinking
 * caret sits in an empty `contentEditable` region.
 */
export function measureCaretRect(fieldEl: HTMLElement, offset: number): DOMRect {
  const textNode = fieldEl.firstChild;
  if (!(textNode instanceof Text)) {
    return fieldEl.getBoundingClientRect();
  }
  const length = textNode.textContent?.length ?? 0;
  const clamped = Math.min(Math.max(offset, 0), length);
  const range = document.createRange();
  range.setStart(textNode, clamped);
  range.setEnd(textNode, clamped);
  return range.getClientRects()[0] ?? range.getBoundingClientRect();
}

/**
 * Translates a caret's rendered rect into the local (pre-zoom) `top`/`left` a widget appended
 * directly inside `containerRect`'s own element should use -- see this module's own top-of-file
 * comment ("Staying correct under zoom") for why the division by `zoomFraction` is required, not
 * optional, the moment zoom is anything other than 1. `zoomFraction` is defensively floored at a
 * tiny positive number rather than allowed to be zero (which would divide by zero into `Infinity`)
 * -- `ZOOM_MIN_PERCENT` (zoom.ts) already keeps the real UI from ever reaching zero, so this only
 * guards a caller passing a raw, unvalidated number directly.
 */
export function computeOverlayPosition(
  caretRect: DOMRect,
  containerRect: DOMRect,
  zoomFraction: number,
): { top: number; left: number } {
  const fraction = zoomFraction > 0 ? zoomFraction : 1;
  return {
    top: (caretRect.top - containerRect.top) / fraction,
    left: (caretRect.left - containerRect.left) / fraction,
  };
}

/**
 * The click-through fix for this surface -- the owner's own words, "when another user's cursor is
 * clicked on, it should move your cursor there as if you had clicked on the spot without any other
 * cursor there" -- applied to the title page's own remote-cursor widgets (`buildRemoteCursorWidget`,
 * appended directly into `.title-page`, per this module's top-of-file comment).
 *
 * The manuscript body (`presence.ts`'s `forwardRemoteCursorClick`) can lean on `EditorView.
 * posAtCoords`, ProseMirror's own pixel-to-position mapping, which measures the *underlying* text's
 * own rendered rects rather than asking the browser which element is topmost at a point -- so the
 * widget sitting on top of that text never enters into it. The title page has no such API: it is
 * bare `contentEditable` divs, not a ProseMirror document, so the only tool available is the DOM's
 * own point-to-caret lookup (`caretPositionFromPoint`/`caretRangeFromPoint`), and unlike
 * `posAtCoords`, that lookup *is* ordinary hit-testing -- it returns a position inside whichever
 * element is actually topmost at the point, respecting `pointer-events` exactly the way a real
 * click would (the same property `pointer-events: none` on `.remote-cursor-label` already relies on
 * to let clicks fall through to whatever is under it). Landing on `.remote-cursor-caret` -- the
 * widget's own hit-testable child, kept deliberately wider than its painted stripe for an easy
 * hover target (`styles.css`'s own comment) -- would therefore resolve to a position *inside* the
 * widget itself, not the field text under it, exactly the defect this exists to fix.
 *
 * `suppressPointerEvents` is the fix for that gap: it sets the caret's own `pointer-events` to
 * `none` for the single synchronous duration of the lookup call, then restores whatever value was
 * there before. This is deliberately *not* the same thing `styles.css`'s own comment warns against
 * ("`pointer-events: none` is the wrong fix") -- that warning is about a permanent CSS rule, which
 * would make the widget unhoverable for as long as it is mounted. This toggle exists for exactly
 * one synchronous call, inside one mousedown handler, with no repaint in between the `none` and the
 * restore (both DOM writes happen in the same JS task, before the browser's next paint) -- so
 * `:hover` never has a chance to visibly drop, and every other moment (including the very next
 * frame) the widget is precisely as hoverable as it was before this handler ran.
 *
 * This is also this module's own answer to "one shared mechanism or two" (`presence.ts`'s own
 * comment on the identical question makes the case for the body's half): the two surfaces' hit-
 * testing models are genuinely different -- one measures text geometry directly and is immune to
 * DOM z-order, the other is native point-in-element hit-testing that has to be told, per call, to
 * look through one specific element -- so forcing them through one shared function would mean
 * branching on which model applies inside a supposedly-shared abstraction, which is not sharing,
 * it is one function pretending to be two. Two small, surface-specific implementations, not one
 * general one, is the same call `presence.ts`'s own click-through comment reaches for the body.
 */
function suppressPointerEvents(element: HTMLElement): () => void {
  const previous = element.style.pointerEvents;
  element.style.pointerEvents = 'none';
  return () => {
    element.style.pointerEvents = previous;
  };
}

/**
 * Resolves the DOM `(node, offset)` nearest `(x, y)` via the standard `Document.
 * caretPositionFromPoint`, falling back to WebKit's older, non-standard `caretRangeFromPoint` where
 * the standard method is not implemented (Safari, as of this writing -- both are fully typed in
 * this project's DOM lib, so this is a runtime feature check, not a type-level one). Returns
 * `undefined` for whichever of "neither API exists" or "the point resolved to nothing" applies --
 * both read as "no position found" to every caller here, which already treats that as "do not
 * intercept this click" rather than a distinct error to report.
 */
export function resolveCaretFromPoint(
  x: number,
  y: number,
): { node: Node; offset: number } | undefined {
  if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(x, y);
    if (!position) return undefined;
    return { node: position.offsetNode, offset: position.offset };
  }
  if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(x, y);
    if (!range) return undefined;
    return { node: range.startContainer, offset: range.startOffset };
  }
  return undefined;
}

/** Which live `[data-title-page-field]` element `node` (a text node, or the field element itself
 * for an empty field -- the same two shapes `titlePageCursorFromSelection`'s own `startContainer`
 * handles) sits inside, or `undefined` if it names no field at all -- a click that, despite landing
 * on a remote-cursor widget, resolves somewhere outside every field once the widget is looked
 * through (not expected in practice, since the widget is always positioned exactly at some field's
 * own caret rect, but never assumed). */
function fieldContainingCaretTarget(node: Node): HTMLElement | undefined {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const field = element instanceof Element ? element.closest('[data-title-page-field]') : null;
  return field instanceof HTMLElement ? field : undefined;
}

/**
 * The whole of the title page's click-through fix: given the widget a mousedown landed on and the
 * pointer's own viewport coordinates, looks through that widget (`suppressPointerEvents`), resolves
 * the field position underneath it (`resolveCaretFromPoint` + `fieldContainingCaretTarget`), and --
 * only once both succeed -- focuses that field and collapses the real DOM selection there, exactly
 * where an ordinary click at those same coordinates would have landed had the widget never been
 * there at all. Returns `false`, doing nothing else, for every case that does not reach that point,
 * so the caller (`useTitlePagePresence`'s own mousedown listener) knows whether to suppress the
 * browser's own default handling of the event or leave it alone.
 *
 * `root` scopes the result to one mounted title page (matching `titlePageCursorFromSelection`'s own
 * `root.contains` check) -- defensive, not load-bearing in the single-title-page-per-document shape
 * this app has today, but keeps this function honest about what it actually guarantees rather than
 * assuming there is only ever one `.title-page` in the document.
 */
export function forwardTitlePageRemoteCursorClick(
  root: Element,
  widget: Element,
  clientX: number,
  clientY: number,
): boolean {
  const caret = widget.querySelector('.remote-cursor-caret');
  const restore = caret instanceof HTMLElement ? suppressPointerEvents(caret) : undefined;
  let resolved: { node: Node; offset: number } | undefined;
  try {
    resolved = resolveCaretFromPoint(clientX, clientY);
  } finally {
    restore?.();
  }
  if (!resolved) return false;

  const fieldEl = fieldContainingCaretTarget(resolved.node);
  if (!fieldEl || !root.contains(fieldEl)) return false;

  fieldEl.focus();
  const selection = document.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.setStart(resolved.node, resolved.offset);
  range.setEnd(resolved.node, resolved.offset);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Wires the local broadcast and the remote render together for one mounted title page. `awareness`
 * is `undefined` in local, no-collaboration-server mode (matching `createRemotePresenceExtension`'s
 * own omission in that mode, `App.tsx`) -- there is no other participant who could ever appear, and
 * this hook does nothing at all in that case.
 */
export function useTitlePagePresence({
  awareness,
  containerRef,
  zoomPercent,
}: {
  readonly awareness: Awareness | undefined;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly zoomPercent: number;
}): void {
  // Read by the render effect below without that effect needing to re-run (and therefore rebuild
  // every remote widget) on every zoom change -- see the module comment on why zoom still needs a
  // reposition even with no dependency-array change.
  const zoomPercentRef = useRef(zoomPercent);
  zoomPercentRef.current = zoomPercent;
  const renderRef = useRef<(() => void) | undefined>(undefined);

  // Local: broadcast this writer's own title-page cursor -- the new signal this module adds; the
  // fields have no selection tracking at all before this. `selectionchange` is document-level
  // (there is no per-field "focus moved within me" event that also covers a caret moving via arrow
  // keys or a click), so every firing is checked against `containerRef.current` to tell "still on
  // this title page" apart from "moved to the manuscript body, or anywhere else in the app" --
  // exactly the case that must clear the cursor, the same way `yCursorPlugin`'s own `focusout`
  // handler clears the body's `cursor` field.
  useEffect(() => {
    if (!awareness) return;
    const container = containerRef.current;
    if (!container) return;

    const handleSelectionChange = () => {
      const cursor = titlePageCursorFromSelection(container, document.getSelection());
      awareness.setLocalStateField(TITLE_PAGE_CURSOR_AWARENESS_FIELD, cursor);
      // Real, locally-originated activity -- typing or moving a caret in the title page is just as
      // much "this writer is here" as a keystroke in the manuscript body, so it feeds the identical
      // `lastActiveAt` the body's own heartbeat plugin writes (`markPresenceActive`, reused, not
      // re-derived), which is what the participant indicator and the typing-glow reveal both read.
      if (cursor) markPresenceActive(awareness);
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      // A departing writer's own stale title-page cursor must not linger for peers who are still
      // connected -- clears the field rather than leaving whatever position was last broadcast.
      awareness.setLocalStateField(TITLE_PAGE_CURSOR_AWARENESS_FIELD, undefined);
    };
  }, [awareness, containerRef]);

  // Remote: render every other present writer's title-page cursor. One `createGlowController`
  // instance scoped to this hook's own widgets -- a second, independent instance of the same
  // controller the body's `createRemotePresenceExtension` also runs against the same `Awareness`;
  // see that function's own comment on why two instances never interfere.
  useEffect(() => {
    if (!awareness) return;
    const container = containerRef.current;
    if (!container) return;

    const glow = createGlowController(awareness);
    const nodes = new Map<number, HTMLElement>();

    const render = () => {
      const now = Date.now();
      const seen = new Set<number>();
      const containerRect = container.getBoundingClientRect();
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const user = (state as { user?: PresenceUser }).user;
        const cursor = (state as { titlePageCursor?: TitlePageCursor }).titlePageCursor;
        if (!user || !cursor) return;
        // The same "present" window the participant list and the body's own remote cursor use --
        // reused, not a second definition of what counts as active (this module's own top-of-file
        // comment).
        if (!isRecentlyActive(user.lastActiveAt, now, PRESENCE_ACTIVE_WINDOW_MS)) return;
        const fieldEl = locateTitlePageCursorField(container, cursor);
        if (!fieldEl) return;

        seen.add(clientId);
        let widget = nodes.get(clientId);
        if (!widget) {
          // Built once per peer, then reused and only repositioned -- `createGlowController`'s own
          // `awareness.on('change', ...)` listener (registered by `glow.register` below) is what
          // makes the label re-light or expire on its own for *this* element from here on, exactly
          // as it already does for the body's own widgets; rebuilding it on every render would
          // still be caught correctly (each `register` call reschedules against whichever element
          // it is given), but would needlessly discard and recreate a DOM node on every position
          // update.
          widget = buildRemoteCursorWidget(user);
          nodes.set(clientId, widget);
          container.append(widget);
          glow.register(clientId, widget, user.lastActiveAt);
        }
        const caretRect = measureCaretRect(fieldEl, cursor.offset);
        const { top, left } = computeOverlayPosition(
          caretRect,
          containerRect,
          zoomPercentRef.current / 100,
        );
        widget.style.top = `${top}px`;
        widget.style.left = `${left}px`;
      });

      // Anyone not seen this pass -- disconnected, or simply no longer has an active title-page
      // cursor (moved to the manuscript body, went idle past the active window) -- is removed and
      // forgotten, including its own pending glow-expiry timer (`glow.forget`, exported from
      // `presence.ts` for exactly this case: unlike a real disconnect, this is not a `removed`
      // awareness client id at all, so nothing inside `createGlowController` itself would ever stop
      // tracking it on its own).
      for (const [clientId, widget] of nodes) {
        if (!seen.has(clientId)) {
          widget.remove();
          nodes.delete(clientId);
          glow.forget(clientId);
        }
      }
    };

    renderRef.current = render;
    // Renders whatever the awareness states already hold at mount, not only future changes --
    // the exact defect slice 2's own brief names as previously shipped and caught: "cursors of
    // collaborators already present did not appear on join."
    render();
    awareness.on('change', render);

    // The click-through fix (see `forwardTitlePageRemoteCursorClick`'s own comment for the full
    // mechanism): a mousedown whose target is one of *this* hook's own widgets is forwarded to the
    // field position underneath it; every other mousedown -- including one that lands on this same
    // container but misses every widget -- is left completely alone.
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const widget = target.closest('.remote-cursor');
      if (!widget || !container.contains(widget)) return;
      const handled = forwardTitlePageRemoteCursorClick(
        container,
        widget,
        event.clientX,
        event.clientY,
      );
      if (handled) event.preventDefault();
    };
    container.addEventListener('mousedown', handleMouseDown);

    return () => {
      awareness.off('change', render);
      container.removeEventListener('mousedown', handleMouseDown);
      renderRef.current = undefined;
      glow.destroy();
      for (const widget of nodes.values()) widget.remove();
      nodes.clear();
    };
  }, [awareness, containerRef]);

  // Zoom changes the caret's rendered position with no awareness event of its own to trigger a
  // reposition -- re-invokes the same render closure the effect above owns, rather than tearing
  // down and rebuilding every widget (which changing `zoomPercent` in that effect's own dependency
  // array would do).
  //
  // Deliberately skips its own first run. A `useEffect` fires on mount as well as on change, so
  // without this it would render a second time at mount, immediately after the effect above
  // already did -- harmless in itself, but it would make that effect's own mount-time `render()`
  // redundant, and a redundant line is one no test can hold: removing it would leave every test
  // green while silently reintroducing "cursors of collaborators already present do not appear on
  // join," which is exactly the defect the owner found in slice 2. One mount-render authority, so
  // that one is the one under test.
  const zoomSettled = useRef(false);
  useEffect(() => {
    if (!zoomSettled.current) {
      zoomSettled.current = true;
      return;
    }
    renderRef.current?.();
  }, [zoomPercent]);
}

/**
 * Zoom as a mode, not only a number (plan.md's "Zoom controls"): "Storing the computed percentage
 * instead is the mistake that makes fit silently stop fitting after the first resize." `ZoomMode`
 * is the writer's actual request -- a fixed percentage, or one of the two fit modes -- and is what
 * `App.tsx` keeps in state. The percentage a fit mode currently resolves to is a *derived* value,
 * recomputed by `resolveZoomPercent` below whenever the available area changes; it is never itself
 * the thing stored, so a later resize can recompute it rather than being stuck with whatever the
 * fit mode happened to produce once.
 *
 * Deliberately has no `overlay` breakpoint case: plan.md's "Zoom controls" names "entering or
 * leaving the overlay breakpoint" as a third recompute trigger alongside resize and panel
 * toggling, but no such application state exists in this codebase yet (`styles.css`'s narrow-width
 * rules are plain CSS media queries with no corresponding React state) -- see
 * `progress/zoom-modes.md` for why this is scoped out rather than invented.
 */
export type ZoomMode =
  | { readonly kind: 'fixed'; readonly percent: number }
  | { readonly kind: 'fit-page' }
  | { readonly kind: 'fit-width' };

/**
 * The floor moved from 70 to 50 in this slice. At 100% the page is 8.5in, roughly 816px
 * (`PAGE_WIDTH_IN * CSS_PX_PER_IN` below); fit-width lands around 60-85% on ordinary windows, so
 * 50% only binds where 12pt Courier is already at the edge of legibility. A fit mode clamps to
 * this floor rather than overriding it -- the *mode* survives the clamp, so a later resize that
 * creates room recomputes and un-clamps on its own (`resolveZoomPercent` below). At the clamp,
 * fit-width genuinely does not fit and horizontal scroll appears; that is accepted, not a defect
 * to design around.
 */
export const ZOOM_MIN_PERCENT = 50;
/** Unchanged from before this slice. */
export const ZOOM_MAX_PERCENT = 150;
/** The step the zoom in/out controls and their keyboard equivalents move by -- unchanged from the
 * pre-existing `updateZoom(10)` / `updateZoom(-10)` calls this slice replaces. */
export const ZOOM_STEP_PERCENT = 10;
export const ZOOM_DEFAULT_PERCENT = 100;

/** The preset dropdown's fixed-percentage options (plan.md: "a set of fixed percentages plus
 * 'Fit page' and 'Fit width'"). Deliberately includes both new boundary values -- 50, the new
 * floor, and 150, the unchanged ceiling -- so every reachable fixed extreme is one click away, not
 * only reachable by repeatedly pressing the stepper. */
export const ZOOM_PRESET_PERCENTS = [50, 60, 70, 80, 90, 100, 110, 125, 150] as const;

export function clampZoomPercent(percent: number): number {
  return Math.min(ZOOM_MAX_PERCENT, Math.max(ZOOM_MIN_PERCENT, percent));
}

/** The CSS specification's fixed definition of the `in` unit -- 96px per inch, always, regardless
 * of zoom or device pixel ratio (a browser's own page zoom scales every CSS pixel together, so the
 * ratio between `in` and `px` never moves). The same constant `paginationExtension.ts` and
 * `seamCaret.ts` already carry under this exact name, for the same reason each gives it: not a
 * page-format figure (`pageGeometryCss.ts` owns those), so it is stated here rather than sourced
 * from there. Not duplicated by import from either of those modules because both scope it to their
 * own file privately; three small, identically-justified constants read better than one imported
 * across module boundaries that otherwise have nothing to do with each other. */
const CSS_PX_PER_IN = 96;

/** The rectangle `.editor-region` actually has available to lay the page out in -- its content
 * box, in real screen CSS pixels, after its own padding is subtracted. Every field is a plain
 * number so the pure functions below never touch the DOM themselves; see `measureAvailableArea`
 * for the one place that reads it off a real element. */
export type AvailableArea = {
  readonly widthPx: number;
  readonly heightPx: number;
};

/**
 * The percent that would make the page's natural (unscaled) box exactly fill `available`, for
 * `mode`. `pageWidthIn`/`pageHeightIn` are the physical page dimensions (`PAGE_WIDTH_IN` /
 * `PAGE_HEIGHT_IN`, `@finaler-draft/screenplay/pageFormat`) -- passed in rather than imported, so
 * this module stays pure arithmetic and every case is a unit test with plain numbers, not a fixture
 * that has to import the screenplay package's constants to be meaningful.
 *
 * The natural page box is `pageWidthIn * CSS_PX_PER_IN` by `pageHeightIn * CSS_PX_PER_IN` -- a
 * fixed, deterministic figure that never needs measuring off `.page` itself (unlike
 * `paginationExtension.ts`'s own `pixelsPerInch`, which measures the *current*, already-scaled
 * `.page` because it needs today's on-screen pixel density; this function computes the *target*
 * scale from scratch, so it starts from the unscaled figure instead).
 */
export function computeFitPercent(
  mode: 'fit-page' | 'fit-width',
  available: AvailableArea,
  pageWidthIn: number,
  pageHeightIn: number,
): number {
  const naturalWidthPx = pageWidthIn * CSS_PX_PER_IN;
  const widthFraction = available.widthPx / naturalWidthPx;
  if (mode === 'fit-width') {
    return widthFraction * 100;
  }
  const naturalHeightPx = pageHeightIn * CSS_PX_PER_IN;
  const heightFraction = available.heightPx / naturalHeightPx;
  return Math.min(widthFraction, heightFraction) * 100;
}

/**
 * Resolves `mode` to the percent that should actually render right now. A fixed mode is only ever
 * clamped to the 50-150 range; a fit mode is computed from `available` and then clamped the same
 * way -- the clamp is the only thing the two cases share, so it is applied once, here, rather than
 * separately at each call site.
 *
 * This is the function a fit mode's recompute runs through on every call: it is stateless and
 * takes the current `available` area fresh each time, so calling it again after a resize or a
 * panel toggle -- with nothing else about `mode` having changed -- is what makes fit keep fitting,
 * per this module's own top-of-file comment.
 */
export function resolveZoomPercent(
  mode: ZoomMode,
  available: AvailableArea,
  pageWidthIn: number,
  pageHeightIn: number,
): number {
  if (mode.kind === 'fixed') {
    return clampZoomPercent(mode.percent);
  }
  return clampZoomPercent(computeFitPercent(mode.kind, available, pageWidthIn, pageHeightIn));
}

/**
 * `.editor-region`'s content box (its own padding subtracted out), read off the real element --
 * the one place in this module that touches the DOM. `getComputedStyle` rather than a hardcoded
 * padding figure because `styles.css` changes `.editor-region`'s padding at its own narrow-width
 * breakpoints (824px and below); reading it fresh here means a fit mode's recompute is correct at
 * every breakpoint without this module needing to know any of them exist.
 *
 * `null` (not yet mounted, or torn down) resolves to a zero-area rectangle rather than throwing:
 * `resolveZoomPercent` then clamps whatever `computeFitPercent` does with zero width/height down
 * to `ZOOM_MIN_PERCENT`, which is a safe, visible floor rather than `NaN` or a divide-by-zero
 * artifact reaching a CSS `transform`.
 */
export function measureAvailableArea(region: HTMLElement | null): AvailableArea {
  if (!region) {
    return { heightPx: 0, widthPx: 0 };
  }
  const style = window.getComputedStyle(region);
  const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  return {
    heightPx: Math.max(0, region.clientHeight - paddingY),
    widthPx: Math.max(0, region.clientWidth - paddingX),
  };
}

/**
 * Centred zoom (the owner's explicit decision, superseding two earlier ones tried in this same
 * slice -- caret-anchored, then proportional-scroll -- both rejected once he saw the alternatives
 * stated precisely): the content sitting at `.editor-region`'s vertical *centre* stays at that
 * same vertical centre across a zoom change. Not the caret (view state a zoom change has no
 * reason to know or care about -- see `App.tsx`'s own note on why this module never touches
 * `Editor`/`EditorView`), and not a preserved scroll *fraction* (which anchors the wrong point:
 * "65% of the way down" drifts away from whatever the writer was actually looking at unless that
 * happens to sit exactly at the fraction boundary).
 *
 * `captureCentredScroll` records the region's `scrollTop` and the percent in effect *before* the
 * change (needed to compute the scale ratio once the new percent is known); `restoreCentredScroll`
 * applies the formula once the new scale has actually rendered. Split across the two the same way
 * `App.tsx`'s zoom-mode recompute already is: a zoom change is a React state update, not something
 * synchronous this module could wrap end-to-end the way `paginationExtension.ts`'s
 * `compensateScrollForRepagination` wraps a ProseMirror `dispatch()`.
 */
export type ZoomScrollCapture = {
  readonly oldPercent: number;
  readonly scrollTop: number;
};

/** Captures what `restoreCentredScroll` needs, just before a zoom change is requested. `null`
 * (not yet mounted, or torn down) resolves to `undefined`, matching `measureAvailableArea`'s own
 * convention -- `restoreCentredScroll` then has nothing to restore and is a no-op. */
export function captureCentredScroll(
  region: HTMLElement | null,
  oldPercent: number,
): ZoomScrollCapture | undefined {
  if (!region) {
    return undefined;
  }
  return { oldPercent, scrollTop: region.scrollTop };
}

/**
 * `newScrollTop = clamp((oldScrollTop + clientHeight / 2) * ratio - clientHeight / 2, 0,
 * scrollHeight - clientHeight)`, the owner's own formula: the point `clientHeight / 2` below
 * `oldScrollTop` (the viewport's vertical centre) is `ratio` times as far from the top of the
 * scaled content as it used to be, since the whole document scales by exactly `ratio` from its own
 * top edge -- CSS `zoom` on `.pages` (App.tsx), not `transform: scale()` as of this slice; see
 * progress/zoom-modes.md for why the switch was made -- so subtracting `clientHeight / 2` back off
 * centres the viewport on that same point again rather than pinning its top edge there.
 *
 * `region.scrollHeight`/`region.clientHeight` are read here, not captured earlier, deliberately:
 * they must reflect the *new* scale, already rendered by the time this runs (`App.tsx` calls this
 * from a `useLayoutEffect` keyed on the applied `zoomPercent`, after the DOM commit but before the
 * browser paints) -- clamping against a stale pre-zoom `scrollHeight` would either stop short of a
 * target that only became valid once the content grew (zooming in) or fail to clamp one that
 * became invalid once it shrank (zooming out).
 *
 * A document that does not scroll at all (`scrollHeight - clientHeight <= 0` -- shorter than the
 * viewport, or not yet laid out) is left alone entirely: there is no "centre" to anchor when
 * nothing scrolls, and forcing `scrollTop` to 0 here would be a write with no reason behind it.
 *
 * **A known, deliberate consequence, not a bug to special-case**: at `scrollTop` 0, zooming in
 * (`ratio > 1`) yields a positive target, so the very top of the document scrolls up out of view.
 * The owner was told this in exactly those terms before choosing centred anchoring over the
 * proportional alternative, and chose it anyway -- see progress/zoom-modes.md.
 */
export function restoreCentredScroll(
  region: HTMLElement | null,
  capture: ZoomScrollCapture | undefined,
  newPercent: number,
): void {
  if (!region || !capture) {
    return;
  }
  const scrollableExtent = region.scrollHeight - region.clientHeight;
  if (scrollableExtent <= 0) {
    return;
  }
  const ratio = newPercent / capture.oldPercent;
  const clientHeight = region.clientHeight;
  const target = (capture.scrollTop + clientHeight / 2) * ratio - clientHeight / 2;
  region.scrollTop = Math.min(Math.max(target, 0), scrollableExtent);
}

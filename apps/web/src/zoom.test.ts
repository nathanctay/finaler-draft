import { describe, expect, it } from 'vitest';
import {
  applyPinchWheelDelta,
  captureCentredScroll,
  capturePointerAnchoredScroll,
  clampZoomPercent,
  computeFitPercent,
  measureAvailableArea,
  resolveZoomPercent,
  restoreCentredScroll,
  restorePointerAnchoredScroll,
  zoomRatioFromWheelDelta,
  ZOOM_MAX_PERCENT,
  ZOOM_MIN_PERCENT,
  type PointerZoomCapture,
  type ZoomMode,
  type ZoomScrollCapture,
} from './zoom.js';

describe('clampZoomPercent', () => {
  it('leaves an in-range value untouched', () => {
    expect(clampZoomPercent(100)).toBe(100);
  });

  it('clamps below the floor up to it', () => {
    expect(clampZoomPercent(1)).toBe(ZOOM_MIN_PERCENT);
  });

  it('clamps above the ceiling down to it', () => {
    expect(clampZoomPercent(999)).toBe(ZOOM_MAX_PERCENT);
  });

  it('holds exactly at each boundary, not just near it', () => {
    expect(clampZoomPercent(ZOOM_MIN_PERCENT)).toBe(ZOOM_MIN_PERCENT);
    expect(clampZoomPercent(ZOOM_MAX_PERCENT)).toBe(ZOOM_MAX_PERCENT);
  });
});

// PAGE_WIDTH_IN/PAGE_HEIGHT_IN are 8.5/11 in the real spec; this module never imports them (see
// its own top-of-file comment on why), so every case below states its own page dimensions,
// chosen to make the arithmetic land on clean numbers rather than borrowing the real ones.
describe('computeFitPercent', () => {
  it('fit-width: the percent that makes the natural page width exactly fill the available width', () => {
    // 10in page * 96px/in = 960px natural width; 480px available is exactly half.
    expect(computeFitPercent('fit-width', { heightPx: 100000, widthPx: 480 }, 10, 20)).toBeCloseTo(
      50,
      10,
    );
  });

  it('fit-width ignores the available height entirely', () => {
    const withRoom = computeFitPercent('fit-width', { heightPx: 1, widthPx: 480 }, 10, 20);
    const withoutRoom = computeFitPercent('fit-width', { heightPx: 100000, widthPx: 480 }, 10, 20);
    expect(withRoom).toBe(withoutRoom);
  });

  it('fit-page: takes the smaller of the width-bound and height-bound percent', () => {
    // Width bound: 480 / (10*96) = 50%. Height bound: 480 / (20*96) = 25%. Width alone is
    // roomier, so height is the binding constraint -- fit-page must pick the smaller one, or the
    // page would overflow the available height while claiming to "fit".
    expect(computeFitPercent('fit-page', { heightPx: 480, widthPx: 480 }, 10, 20)).toBeCloseTo(
      25,
      10,
    );
  });

  it('fit-page: picks width when it is the tighter bound instead', () => {
    // Width bound: 240 / (10*96) = 25%. Height bound: 960 / (20*96) = 50%. Now width binds.
    expect(computeFitPercent('fit-page', { heightPx: 960, widthPx: 240 }, 10, 20)).toBeCloseTo(
      25,
      10,
    );
  });

  it('a zero available area resolves to a zero percent rather than throwing or dividing to Infinity oddly', () => {
    expect(computeFitPercent('fit-width', { heightPx: 0, widthPx: 0 }, 10, 20)).toBe(0);
    expect(computeFitPercent('fit-page', { heightPx: 0, widthPx: 0 }, 10, 20)).toBe(0);
  });
});

describe('resolveZoomPercent', () => {
  it('a fixed mode passes its own percent through the clamp, ignoring the available area entirely', () => {
    const mode: ZoomMode = { kind: 'fixed', percent: 100 };
    const small = resolveZoomPercent(mode, { heightPx: 1, widthPx: 1 }, 10, 20);
    const large = resolveZoomPercent(mode, { heightPx: 100000, widthPx: 100000 }, 10, 20);
    expect(small).toBe(100);
    expect(large).toBe(100);
  });

  it('a fixed mode above the ceiling clamps down', () => {
    expect(
      resolveZoomPercent({ kind: 'fixed', percent: 400 }, { heightPx: 1, widthPx: 1 }, 10, 20),
    ).toBe(ZOOM_MAX_PERCENT);
  });

  it('a fit mode is computed fresh from the available area every call -- the exact "fit must recompute" property plan.md names', () => {
    const mode: ZoomMode = { kind: 'fit-width' };
    // 10in * 96px/in = 960px natural width.
    const narrow = resolveZoomPercent(mode, { heightPx: 100000, widthPx: 480 }, 10, 20);
    const wide = resolveZoomPercent(mode, { heightPx: 100000, widthPx: 960 }, 10, 20);
    expect(narrow).toBeCloseTo(50, 10);
    expect(wide).toBeCloseTo(100, 10);
    // Nothing about `mode` itself changed between the two calls -- it is still plain
    // `{ kind: 'fit-width' }` -- yet the resolved percent tracked the new, larger available area.
    // A version of this function that instead returned whatever it computed the *first* time
    // (the exact regression plan.md's "Zoom controls" warns against: "storing the computed
    // percentage instead is the mistake that makes fit silently stop fitting after the first
    // resize") would fail this assertion.
    expect(narrow).not.toBe(wide);
  });

  it('a fit mode clamps to the floor when the available area is too small to fit, without losing the mode', () => {
    // 10in * 96px/in = 960px; 48px available is 5%, well under the 50% floor.
    const percent = resolveZoomPercent(
      { kind: 'fit-width' },
      { heightPx: 100000, widthPx: 48 },
      10,
      20,
    );
    expect(percent).toBe(ZOOM_MIN_PERCENT);
  });
});

describe('measureAvailableArea', () => {
  it('a null region resolves to a zero-area rectangle rather than throwing', () => {
    expect(measureAvailableArea(null)).toEqual({ heightPx: 0, widthPx: 0 });
  });

  it("subtracts the region's own padding from its client box, matching .editor-region's real CSS", () => {
    const region = document.createElement('div');
    // Inline styles resolve through jsdom's getComputedStyle without needing real layout --
    // `.editor-region`'s own default padding (styles.css), stated directly here rather than
    // measured off a stylesheet, following floatingPanel.test.ts's "state it, don't measure it"
    // precedent for anything jsdom cannot lay out for real.
    region.style.padding = '44px 56px';
    document.body.append(region);
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 500 });

    expect(measureAvailableArea(region)).toEqual({
      heightPx: 500 - 44 * 2,
      widthPx: 1000 - 56 * 2,
    });
  });

  it('clamps a content box to zero rather than going negative when padding exceeds the client box', () => {
    const region = document.createElement('div');
    region.style.padding = '100px 200px';
    document.body.append(region);
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 50 });
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 50 });

    expect(measureAvailableArea(region)).toEqual({ heightPx: 0, widthPx: 0 });
  });
});

/** A `.editor-region` stand-in with `scrollTop`/`scrollHeight`/`clientHeight` all stated directly
 * -- jsdom lays nothing out, so all three default to 0; the house precedent for stating a rect
 * rather than measuring one is `floatingPanel.test.ts:29-33`. `scrollTop` is left as jsdom's own
 * plain writable property (unlike a real browser, jsdom applies no clamping of its own), so
 * reading it back after `restoreCentredScroll` runs is exactly what was written, nothing more. */
function regionWithScroll(options: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): HTMLElement {
  const region = document.createElement('div');
  region.scrollTop = options.scrollTop;
  Object.defineProperty(region, 'scrollHeight', {
    configurable: true,
    value: options.scrollHeight,
  });
  Object.defineProperty(region, 'clientHeight', {
    configurable: true,
    value: options.clientHeight,
  });
  return region;
}

describe('captureCentredScroll', () => {
  it('returns undefined for a null region', () => {
    expect(captureCentredScroll(null, 100)).toBeUndefined();
  });

  it("captures the region's current scrollTop alongside the percent passed in", () => {
    const region = regionWithScroll({ clientHeight: 200, scrollHeight: 1000, scrollTop: 137 });
    expect(captureCentredScroll(region, 80)).toEqual({ oldPercent: 80, scrollTop: 137 });
  });
});

describe('restoreCentredScroll', () => {
  it('is a no-op for a null region', () => {
    const capture: ZoomScrollCapture = { oldPercent: 100, scrollTop: 50 };
    // No region to assert against -- this only proves the call does not throw.
    expect(() => restoreCentredScroll(null, capture, 150)).not.toThrow();
  });

  it('is a no-op when there is nothing captured (e.g. .editor-region had not mounted at capture time)', () => {
    const region = regionWithScroll({ clientHeight: 200, scrollHeight: 1000, scrollTop: 55 });
    restoreCentredScroll(region, undefined, 150);
    expect(region.scrollTop).toBe(55);
  });

  it('leaves a document no taller than the viewport alone -- the degenerate case the owner named explicitly', () => {
    // scrollHeight - clientHeight <= 0: nothing scrolls, so there is no centre to anchor.
    const region = regionWithScroll({ clientHeight: 600, scrollHeight: 600, scrollTop: 0 });
    const capture: ZoomScrollCapture = { oldPercent: 100, scrollTop: 0 };
    restoreCentredScroll(region, capture, 150);
    expect(region.scrollTop).toBe(0);
  });

  it('also treats a shrunk-below-viewport document (scrollHeight < clientHeight) as degenerate', () => {
    const region = regionWithScroll({ clientHeight: 600, scrollHeight: 400, scrollTop: 0 });
    const capture: ZoomScrollCapture = { oldPercent: 100, scrollTop: 0 };
    restoreCentredScroll(region, capture, 50);
    expect(region.scrollTop).toBe(0);
  });

  it("applies the owner's formula exactly when zooming in: (oldScrollTop + clientHeight/2) * ratio - clientHeight/2", () => {
    // scrollTop 100, clientHeight 200 -> viewport centre was 200px into the document. Ratio 2
    // (100% -> 200%) doubles that to 400, then the formula re-centres the viewport on it: 400 -
    // 100 = 300. Comfortably inside [0, 800] (scrollHeight 1000 - clientHeight 200), so no clamp.
    const region = regionWithScroll({ clientHeight: 200, scrollHeight: 1000, scrollTop: 100 });
    const capture: ZoomScrollCapture = { oldPercent: 100, scrollTop: 100 };
    restoreCentredScroll(region, capture, 200);
    expect(region.scrollTop).toBe(300);
  });

  it('applies the formula exactly when zooming out too', () => {
    // Centre was at 300 + 100 = 400. Ratio 0.5 (100% -> 50%) halves that to 200, then centres:
    // 200 - 100 = 100.
    const region = regionWithScroll({ clientHeight: 200, scrollHeight: 1000, scrollTop: 300 });
    const capture: ZoomScrollCapture = { oldPercent: 100, scrollTop: 300 };
    restoreCentredScroll(region, capture, 50);
    expect(region.scrollTop).toBe(100);
  });

  it('clamps to 0 rather than going negative -- zooming out from near the top', () => {
    // Centre was at 0 + 100 = 100. Ratio 0.5 halves that to 50, then centres: 50 - 100 = -50,
    // which must clamp to 0, not go negative.
    const region = regionWithScroll({ clientHeight: 200, scrollHeight: 1000, scrollTop: 0 });
    const capture: ZoomScrollCapture = { oldPercent: 100, scrollTop: 0 };
    restoreCentredScroll(region, capture, 50);
    expect(region.scrollTop).toBe(0);
  });

  it('clamps to the maximum scrollTop rather than overshooting -- zooming in from near the bottom', () => {
    // scrollableExtent = 1000 - 200 = 800. Centre was at 790 + 100 = 890. Ratio 2 doubles that to
    // 1780, then centres: 1780 - 100 = 1680, far past 800 -- must clamp to exactly 800.
    const region = regionWithScroll({ clientHeight: 200, scrollHeight: 1000, scrollTop: 790 });
    const capture: ZoomScrollCapture = { oldPercent: 100, scrollTop: 790 };
    restoreCentredScroll(region, capture, 200);
    expect(region.scrollTop).toBe(800);
  });

  it('reads scrollHeight/clientHeight fresh -- the post-layout clamp bound, not a stale pre-zoom one', () => {
    // The capture only ever carries scrollTop and the old percent (zoom.ts's own doc comment);
    // this proves the clamp itself is computed from whatever scrollHeight/clientHeight the region
    // reports at the moment restoreCentredScroll runs, not from anything captured earlier -- a
    // version that (incorrectly) captured scrollHeight/clientHeight up front and clamped against
    // the stale figure would produce a different answer here (either stopping at 500, the old
    // extent, or none at all).
    const region = regionWithScroll({ clientHeight: 100, scrollHeight: 1200, scrollTop: 190 });
    // Pretend the capture happened against a smaller, now-stale scrollHeight of 600
    // (scrollableExtent 500) -- restoreCentredScroll must ignore that entirely and use the
    // region's current 1200/100 (scrollableExtent 1100) instead.
    const capture: ZoomScrollCapture = { oldPercent: 100, scrollTop: 190 };
    restoreCentredScroll(region, capture, 300);
    // Centre was 190 + 50 = 240; ratio 3 -> 720; centred: 720 - 50 = 670, inside [0, 1100].
    expect(region.scrollTop).toBe(670);
  });
});

describe('zoomRatioFromWheelDelta', () => {
  it('deltaY = 0 is the identity -- no wheel movement means no zoom change', () => {
    expect(zoomRatioFromWheelDelta(0)).toBe(1);
  });

  it('a negative deltaY (pinch-out / zoom in, per the browsers’ own de facto sign convention) yields a ratio above 1', () => {
    expect(zoomRatioFromWheelDelta(-40)).toBeGreaterThan(1);
  });

  it('a positive deltaY (pinch-in / zoom out) yields a ratio below 1', () => {
    expect(zoomRatioFromWheelDelta(40)).toBeLessThan(1);
  });

  it('is multiplicatively symmetric under a sign flip: ratio(d) * ratio(-d) = 1 exactly', () => {
    // The exponential-response property the module comment claims: two opposite deltas of the
    // same magnitude exactly undo one another, regardless of which magnitude is chosen -- a
    // linear response could not make this hold exactly for every d.
    for (const d of [1, 17, 100, 250]) {
      expect(zoomRatioFromWheelDelta(d) * zoomRatioFromWheelDelta(-d)).toBeCloseTo(1, 10);
    }
  });

  it('a larger magnitude moves the ratio further from 1 than a smaller one, in the same direction', () => {
    const small = zoomRatioFromWheelDelta(-10);
    const large = zoomRatioFromWheelDelta(-100);
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(1);
  });
});

describe('applyPinchWheelDelta', () => {
  it('deltaY = 0 leaves the current percent unchanged', () => {
    expect(applyPinchWheelDelta(80, 0)).toBe(80);
  });

  it('a zoom-in delta increases the percent, a zoom-out delta decreases it', () => {
    expect(applyPinchWheelDelta(100, -40)).toBeGreaterThan(100);
    expect(applyPinchWheelDelta(100, 40)).toBeLessThan(100);
  });

  it('clamps at the 150 ceiling for a large enough zoom-in gesture', () => {
    expect(applyPinchWheelDelta(149, -100000)).toBe(ZOOM_MAX_PERCENT);
  });

  it('clamps at the 50 floor for a large enough zoom-out gesture', () => {
    expect(applyPinchWheelDelta(51, 100000)).toBe(ZOOM_MIN_PERCENT);
  });

  it('stores a fractional result rather than rounding -- pinch is continuous, per plan.md:662', () => {
    const result = applyPinchWheelDelta(100, -3);
    expect(Number.isInteger(result)).toBe(false);
  });
});

/** A `.editor-region` stand-in carrying both axes of scroll state -- the state
 * `restorePointerAnchoredScroll` needs to compute a target and clamp it. Its own
 * `getBoundingClientRect` is deliberately not stubbed here, unlike an earlier version of this
 * helper: neither `capturePointerAnchoredScroll` nor `restorePointerAnchoredScroll` reads the
 * region's own rect any more (progress/pinch-zoom.md) -- only `.pages`'s rect matters, via
 * `pagesElementWithRect` below. */
function regionWithBothAxesScroll(options: {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}): HTMLElement {
  const region = document.createElement('div');
  region.scrollTop = options.scrollTop;
  region.scrollLeft = options.scrollLeft;
  Object.defineProperty(region, 'scrollHeight', {
    configurable: true,
    value: options.scrollHeight,
  });
  Object.defineProperty(region, 'scrollWidth', { configurable: true, value: options.scrollWidth });
  Object.defineProperty(region, 'clientHeight', {
    configurable: true,
    value: options.clientHeight,
  });
  Object.defineProperty(region, 'clientWidth', { configurable: true, value: options.clientWidth });
  return region;
}

/** A `.pages` stand-in carrying only a stubbed `getBoundingClientRect` -- the one thing
 * `capturePointerAnchoredScroll` reads off it. Measuring the pointer's offset against `.pages`
 * itself, rather than `.editor-region`, is the fix for both the vertical and horizontal
 * pointer-anchor defects progress/pinch-zoom.md documents; see zoom.ts's own top-of-section
 * comment on `capturePointerAnchoredScroll`/`restorePointerAnchoredScroll` for the full
 * derivation. */
function pagesElementWithRect(rectTop: number, rectLeft: number): HTMLElement {
  const pages = document.createElement('div');
  pages.getBoundingClientRect = () =>
    ({
      bottom: rectTop,
      height: 0,
      left: rectLeft,
      right: rectLeft,
      top: rectTop,
      width: 0,
      x: rectLeft,
      y: rectTop,
      toJSON: () => ({}),
    }) as DOMRect;
  return pages;
}

describe('capturePointerAnchoredScroll', () => {
  it('returns undefined for a null region', () => {
    const pages = pagesElementWithRect(0, 0);
    expect(capturePointerAnchoredScroll(null, pages, 100, 50, 50)).toBeUndefined();
  });

  it('returns undefined for a null pages element', () => {
    const region = regionWithBothAxesScroll({
      clientHeight: 200,
      clientWidth: 300,
      scrollHeight: 1000,
      scrollLeft: 60,
      scrollTop: 137,
      scrollWidth: 500,
    });
    expect(capturePointerAnchoredScroll(region, null, 100, 50, 50)).toBeUndefined();
  });

  it("captures both scroll axes and the pointer's offset from .pages's own top-left corner -- never .editor-region's", () => {
    const region = regionWithBothAxesScroll({
      clientHeight: 200,
      clientWidth: 300,
      scrollHeight: 1000,
      scrollLeft: 60,
      scrollTop: 137,
      scrollWidth: 500,
    });
    // .pages sits at viewport (40, 20) here -- an arbitrary point, deliberately not derived from
    // `region` at all, to prove this function never consults the region's own rect (only its
    // scrollTop/scrollLeft).
    const pages = pagesElementWithRect(20, 40);
    // Pointer at viewport (140, 220): 140 - 40 = 100 from .pages's left edge, 220 - 20 = 200 from
    // its top edge -- the offsets restorePointerAnchoredScroll must hold fixed.
    expect(capturePointerAnchoredScroll(region, pages, 80, 140, 220)).toEqual({
      anchorOffsetX: 100,
      anchorOffsetY: 200,
      oldPercent: 80,
      scrollLeft: 60,
      scrollTop: 137,
    });
  });
});

/**
 * `restorePointerAnchoredScroll`'s formula (progress/pinch-zoom.md: "the vertical imprecision"
 * and "the horizontal anchor defect", both fixed together): `newScroll = oldScroll +
 * anchorOffset * (ratio - 1)`, not the earlier `(oldScroll + anchorOffset) * ratio - anchorOffset`
 * -- see zoom.ts's own comment on the pair for the full derivation. The two forms are not always
 * numerically distinguishable: they agree exactly whenever `oldScroll` is `0` (the earlier form
 * reduces algebraically to the current one in that case), so several of the tests below that
 * happen to start at `scrollTop`/`scrollLeft` `0` -- or that clamp to the same boundary either
 * way -- keep the same expected numbers as before this rewrite; the ones that do not start at `0`
 * and do not clamp (marked below) have different, updated expected values, and are the ones that
 * actually distinguish the two formulas.
 */
describe('restorePointerAnchoredScroll', () => {
  it('is a no-op for a null region', () => {
    const capture: PointerZoomCapture = {
      anchorOffsetX: 10,
      anchorOffsetY: 10,
      oldPercent: 100,
      scrollLeft: 0,
      scrollTop: 50,
    };
    expect(() => restorePointerAnchoredScroll(null, capture, 150)).not.toThrow();
  });

  it('is a no-op when there is nothing captured', () => {
    const region = regionWithBothAxesScroll({
      clientHeight: 200,
      clientWidth: 300,
      scrollHeight: 1000,
      scrollLeft: 20,
      scrollTop: 55,
      scrollWidth: 500,
    });
    restorePointerAnchoredScroll(region, undefined, 150);
    expect(region.scrollTop).toBe(55);
    expect(region.scrollLeft).toBe(20);
  });

  it('leaves both axes alone in the degenerate case -- neither axis actually scrolls', () => {
    const region = regionWithBothAxesScroll({
      clientHeight: 600,
      clientWidth: 800,
      scrollHeight: 600,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 800,
    });
    const capture: PointerZoomCapture = {
      anchorOffsetX: 100,
      anchorOffsetY: 100,
      oldPercent: 100,
      scrollLeft: 0,
      scrollTop: 0,
    };
    restorePointerAnchoredScroll(region, capture, 150);
    expect(region.scrollTop).toBe(0);
    expect(region.scrollLeft).toBe(0);
  });

  it('anchors the vertical axis on the pointer, not the viewport centre', () => {
    // scrollTop 100, anchorOffsetY 30 (the pointer sits 30px below .pages's own top edge, not
    // the viewport's centre) -> newScrollTop = 100 + 30 * (ratio - 1). Ratio 200/100 = 2 ->
    // 100 + 30 * 1 = 130.
    const region = regionWithBothAxesScroll({
      clientHeight: 200,
      clientWidth: 100,
      scrollHeight: 1000,
      scrollLeft: 0,
      scrollTop: 100,
      scrollWidth: 100,
    });
    const capture: PointerZoomCapture = {
      anchorOffsetX: 0,
      anchorOffsetY: 30,
      oldPercent: 100,
      scrollLeft: 0,
      scrollTop: 100,
    };
    restorePointerAnchoredScroll(region, capture, 200);
    expect(region.scrollTop).toBe(130);
    // No horizontal overflow (scrollWidth === clientWidth) -- must stay untouched.
    expect(region.scrollLeft).toBe(0);
  });

  it('anchors the horizontal axis independently, the same formula applied to scrollLeft/scrollWidth', () => {
    // scrollLeft 40, anchorOffsetX 60 -> newScrollLeft = 40 + 60 * (ratio - 1). Ratio 150/100 =
    // 1.5 -> 40 + 60 * 0.5 = 70.
    const region = regionWithBothAxesScroll({
      clientHeight: 100,
      clientWidth: 200,
      scrollHeight: 100,
      scrollLeft: 40,
      scrollTop: 0,
      scrollWidth: 800,
    });
    const capture: PointerZoomCapture = {
      anchorOffsetX: 60,
      anchorOffsetY: 0,
      oldPercent: 100,
      scrollLeft: 40,
      scrollTop: 0,
    };
    restorePointerAnchoredScroll(region, capture, 150);
    expect(region.scrollLeft).toBe(70);
    // No vertical overflow (scrollHeight === clientHeight) -- must stay untouched.
    expect(region.scrollTop).toBe(0);
  });

  it('clamps the vertical axis to 0 rather than going negative', () => {
    const region = regionWithBothAxesScroll({
      clientHeight: 200,
      clientWidth: 100,
      scrollHeight: 1000,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 100,
    });
    const capture: PointerZoomCapture = {
      anchorOffsetX: 0,
      anchorOffsetY: 100,
      oldPercent: 100,
      scrollLeft: 0,
      scrollTop: 0,
    };
    // 0 + 100 * (0.5 - 1) = 0 + 100 * -0.5 = -50, must clamp to 0.
    restorePointerAnchoredScroll(region, capture, 50);
    expect(region.scrollTop).toBe(0);
  });

  it('clamps the vertical axis to the maximum scrollTop rather than overshooting', () => {
    const region = regionWithBothAxesScroll({
      clientHeight: 200,
      clientWidth: 100,
      scrollHeight: 1000,
      scrollLeft: 0,
      scrollTop: 790,
      scrollWidth: 100,
    });
    const capture: PointerZoomCapture = {
      anchorOffsetX: 0,
      anchorOffsetY: 100,
      oldPercent: 100,
      scrollLeft: 0,
      scrollTop: 790,
    };
    // scrollableExtent = 800. 790 + 100 * (2 - 1) = 890, far past 800 -- must clamp to exactly
    // 800 (the same clamped result the earlier formula also produced here, from a different
    // pre-clamp target -- this case does not by itself distinguish the two formulas, only the
    // clamp).
    restorePointerAnchoredScroll(region, capture, 200);
    expect(region.scrollTop).toBe(800);
  });

  it('clamps the horizontal axis to 0 and to the maximum scrollLeft the same way', () => {
    const clampedLow = regionWithBothAxesScroll({
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 100,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 900,
    });
    restorePointerAnchoredScroll(
      clampedLow,
      { anchorOffsetX: 100, anchorOffsetY: 0, oldPercent: 100, scrollLeft: 0, scrollTop: 0 },
      50,
    );
    expect(clampedLow.scrollLeft).toBe(0);

    const clampedHigh = regionWithBothAxesScroll({
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 100,
      scrollLeft: 790,
      scrollTop: 0,
      scrollWidth: 900,
    });
    restorePointerAnchoredScroll(
      clampedHigh,
      { anchorOffsetX: 100, anchorOffsetY: 0, oldPercent: 100, scrollLeft: 790, scrollTop: 0 },
      200,
    );
    // scrollableExtent (horizontal) = 900 - 100 = 800. 790 + 100 * (2 - 1) = 890, clamps to 800.
    expect(clampedHigh.scrollLeft).toBe(800);
  });

  it('reads scrollHeight/scrollWidth/clientHeight/clientWidth fresh -- the post-layout clamp bound, not anything captured earlier', () => {
    const region = regionWithBothAxesScroll({
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 1200,
      scrollLeft: 0,
      scrollTop: 190,
      scrollWidth: 100,
    });
    const capture: PointerZoomCapture = {
      anchorOffsetX: 0,
      anchorOffsetY: 50,
      oldPercent: 100,
      scrollLeft: 0,
      scrollTop: 190,
    };
    restorePointerAnchoredScroll(region, capture, 300);
    // 190 + 50 * (3 - 1) = 190 + 100 = 290, inside [0, 1100] (scrollHeight 1200 - clientHeight
    // 100) -- distinguishes the two formulas (the earlier one gave 670 here).
    expect(region.scrollTop).toBe(290);
  });

  it('both axes move together, independently, in the same call', () => {
    const region = regionWithBothAxesScroll({
      clientHeight: 200,
      clientWidth: 200,
      scrollHeight: 1000,
      scrollLeft: 100,
      scrollTop: 100,
      scrollWidth: 1000,
    });
    const capture: PointerZoomCapture = {
      anchorOffsetX: 50,
      anchorOffsetY: 50,
      oldPercent: 100,
      scrollLeft: 100,
      scrollTop: 100,
    };
    // Both axes share the identical formula and inputs here (symmetric fixture): 100 + 50 *
    // (2 - 1) = 150, on each axis independently (the earlier formula gave 250 here).
    restorePointerAnchoredScroll(region, capture, 200);
    expect(region.scrollTop).toBe(150);
    expect(region.scrollLeft).toBe(150);
  });
});

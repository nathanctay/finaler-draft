import { describe, expect, it } from 'vitest';
import {
  captureCentredScroll,
  clampZoomPercent,
  computeFitPercent,
  measureAvailableArea,
  resolveZoomPercent,
  restoreCentredScroll,
  ZOOM_MAX_PERCENT,
  ZOOM_MIN_PERCENT,
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

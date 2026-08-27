import { afterEach, describe, expect, it } from 'vitest';
import { placeAtCaret } from './floatingPanel.js';

/**
 * Pure geometry, so it is tested as geometry: a fake panel of a known size, a caret rectangle, and
 * a window of a known size. This is the one part of either floating panel that a real browser test
 * cannot pin down cheaply -- `page-rendering-persistence.spec.ts` can show that a panel lands under
 * the caret in a comfortable window, but not what happens in a window too short for it, which is
 * where every branch below lives.
 */

const WINDOW_WIDTH = 1000;
const WINDOW_HEIGHT = 800;

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

function resizeWindow(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

afterEach(() => {
  resizeWindow(originalWidth, originalHeight);
});

/** A panel of a fixed size. jsdom lays nothing out, so its box is stated rather than measured --
 * which is also what makes each case below an exact arithmetic claim rather than an approximation. */
function panelOf(width: number, height: number): HTMLElement {
  const panel = document.createElement('ul');
  panel.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
  return panel;
}

function place(caret: DOMRect, panelWidth = 160, panelHeight = 120) {
  const panel = panelOf(panelWidth, panelHeight);
  placeAtCaret(panel, caret);
  return { left: panel.style.left, top: panel.style.top };
}

describe('placeAtCaret', () => {
  it('sits just below the caret and flush with its left edge when there is room', () => {
    resizeWindow(WINDOW_WIDTH, WINDOW_HEIGHT);

    // Caret at y 200..216 (one 16px line), so the panel's top is 216 + the 4px gap.
    expect(place(new DOMRect(300, 200, 1, 16))).toEqual({ left: '300px', top: '220px' });
  });

  it('flips above the caret when the space below would put rows off screen', () => {
    resizeWindow(WINDOW_WIDTH, 400);

    // Below would start at 384 and end at 504, past the 400px window: 380 - 4 - 120 = 256.
    expect(place(new DOMRect(300, 380, 1, 16))).toEqual({ left: '300px', top: '256px' });
  });

  /** A window too short for the panel on either side. Below is preferred rather than flipping to a
   * placement that is also off screen, and the clamp below keeps it reachable. */
  it('stays below, clamped into the viewport, when neither side has room', () => {
    resizeWindow(WINDOW_WIDTH, 150);

    // Above would be 40 - 4 - 120 = -84, less than the 8px margin, so below wins and is then
    // clamped to 150 - 8 - 120 = 22.
    expect(place(new DOMRect(300, 40, 1, 16))).toEqual({ left: '300px', top: '22px' });
  });

  it('never goes above the top margin, however short the window', () => {
    resizeWindow(WINDOW_WIDTH, 60);

    expect(place(new DOMRect(300, 20, 1, 16))).toEqual({ left: '300px', top: '8px' });
  });

  it('pulls back from the right edge so the whole panel stays on screen', () => {
    resizeWindow(WINDOW_WIDTH, WINDOW_HEIGHT);

    // 1000 - 8 - 160 = 832, rather than the caret's own 950.
    expect(place(new DOMRect(950, 200, 1, 16))).toEqual({ left: '832px', top: '220px' });
  });

  it('keeps the left margin when the panel is wider than the window', () => {
    resizeWindow(100, WINDOW_HEIGHT);

    expect(place(new DOMRect(40, 200, 1, 16))).toEqual({ left: '8px', top: '220px' });
  });
});

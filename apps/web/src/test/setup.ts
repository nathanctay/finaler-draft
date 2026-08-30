import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

/**
 * jsdom implements neither `Range.prototype.getClientRects` nor
 * `Range.prototype.getBoundingClientRect` at all (a long-standing jsdom gap, confirmed against the
 * installed jsdom 26.1.0: both are `undefined`, not present as degenerate stubs the way
 * `Element.prototype.getBoundingClientRect` already is). `prosemirror-view`'s `coordsAtPos` calls
 * both when resolving a position inside a text node (`singleRect`'s `target.getClientRects()`,
 * falling back to `target.getBoundingClientRect()`), which is exactly the geometry ProseMirror's
 * own native `EditorView.scrollToSelection()` reads whenever a dispatched transaction is marked
 * `.scrollIntoView()` -- every `prosemirror-commands` command does this, and so does this app's
 * own `splitScreenplayBlock` (screenplayEditor.ts, the Enter-scrolls-the-view fix,
 * progress/repagination-scroll-anchor.md).
 *
 * Without this, any test that dispatches such a transaction against a real (unmocked)
 * `coordsAtPos` -- not stubbed the way `paginationExtension.test.ts`'s own tests stub it --
 * throws `TypeError: target.getClientRects is not a function` from deep inside
 * `prosemirror-view`, surfaced via `fireEvent`'s real DOM event dispatch as an *uncaught*
 * exception (the DOM event spec reports a listener's thrown error to the global handler rather
 * than propagating it back to whatever called `dispatchEvent`), so the test's own assertions can
 * still pass while the run still fails on the stray error -- discovered exactly this way by
 * App.test.tsx's "dispatches keyboard transitions, splits selected text, and keeps ids unique".
 *
 * The polyfill returns an empty rect list / a zero rect: matching jsdom's own answer for
 * `Element.prototype.getBoundingClientRect` (a real, if degenerate, measurement -- jsdom lays out
 * nothing, so zero is the honest answer here too), not standing in for real geometry.
 */
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    return [] as unknown as DOMRectList;
  };
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return new DOMRect(0, 0, 0, 0);
  };
}

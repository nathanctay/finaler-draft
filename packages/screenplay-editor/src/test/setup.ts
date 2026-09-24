/**
 * jsdom implements neither `Range.prototype.getClientRects` nor
 * `Range.prototype.getBoundingClientRect` at all (a long-standing jsdom gap, confirmed against the
 * installed jsdom 26.1.0: both are `undefined`, not present as degenerate stubs the way
 * `Element.prototype.getBoundingClientRect` already is). `prosemirror-view`'s `coordsAtPos` calls
 * both when resolving a position inside a text node (`singleRect`'s `target.getClientRects()`,
 * falling back to `target.getBoundingClientRect()`), which is exactly the geometry ProseMirror's
 * own native `EditorView.scrollToSelection()` reads whenever a dispatched transaction is marked
 * `.scrollIntoView()` -- every `prosemirror-commands` command does this, `editor.commands
 * .focus('end')` included.
 *
 * Copied verbatim from `apps/web/src/test/setup.ts` (that file's own comment has the full
 * discovery story) rather than shared, matching this package's existing convention of a thin,
 * self-contained package with no runtime dependency on `apps/web`. `presence.test.ts`'s "refreshes
 * lastActiveAt on a real local edit" test is what first surfaced the gap in this package
 * specifically: it is this package's first test to call `editor.commands.focus(...)` against a
 * real, unstubbed `EditorView` -- every other test that scrolls (`editing.test.ts`) either never
 * hit this path or was exercised before coverage instrumentation's own added overhead changed the
 * timing enough to surface it as an *unhandled* (asynchronous, `requestAnimationFrame`-deferred)
 * exception rather than a synchronous one. Without this polyfill, `pnpm test:coverage` -- and only
 * `test:coverage`, not the identical suite run without coverage -- failed this package's coverage
 * gate outright on an unrelated uncaught exception, confirmed directly by reproducing it, adding
 * this file, and reconfirming the same run clean.
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

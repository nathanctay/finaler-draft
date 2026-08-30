import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { ScreenplayBlock } from '@finaler-draft/screenplay';
import { BODY_WIDTH_IN, MARGIN_TOP_IN } from '@finaler-draft/screenplay/pageFormat';
import { screenplayExtensions } from './screenplayEditor.js';
import { PaginationExtension, paginationPluginKey } from './paginationExtension.js';
import { SeamCaretExtension, seamCaretPluginKey, setSeamCaretDownstream } from './seamCaret.js';

/**
 * These tests drive the plugin's own state machine directly, through the real editor and a real
 * mid-block page seam produced by the real pagination plugin -- not a hand-picked position -- so
 * the seam this file asserts against is exactly the shape `isMidBlockSeam` (seamCaret.ts) has
 * anything to say about. What they cannot exercise in jsdom is `SeamCaretView.sync`'s DOM
 * measurement (no font metrics, every `getClientRects` is empty), which is why the drawn caret's
 * geometry, its suppression of the native one, and the no-page-movement guarantee are all measured
 * in a real browser instead, in `page-rendering-persistence.spec.ts`.
 */

/**
 * The same 50-line-action / character / 4-line-dialogue recipe `paginationExtension.test.ts` uses
 * under the name `speechSplitBlocks`: a page 1 filled to room 5, forcing the 4-line speech to
 * split 2-and-2 across the break -- the one shape (`endOffset < block.text.length`) that anchors a
 * page break inside a text block rather than between two of them.
 */
function linesOfLength(budget: number, n: number): string {
  return 'x'.repeat(budget * (n - 1) + 1);
}

function speechSplitBlocks(): ScreenplayBlock[] {
  return [
    { id: '00000000-0000-4000-a000-000000000000', type: 'action', text: linesOfLength(60, 50) },
    { id: '00000000-0000-4000-a000-000000000001', type: 'character', text: 'ADA' },
    { id: '00000000-0000-4000-a000-000000000002', type: 'dialogue', text: linesOfLength(35, 4) },
  ];
}

function docContentFor(blocks: readonly ScreenplayBlock[]) {
  return {
    type: 'screenplayDocument' as const,
    content: blocks.map((block) => ({
      type: 'screenplayBlock' as const,
      attrs: { element: block.type, id: block.id },
      ...('text' in block && block.text !== ''
        ? { content: [{ type: 'text', text: block.text }] }
        : {}),
    })),
  };
}

function buildEditor(blocks: readonly ScreenplayBlock[]) {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({
    content: docContentFor(blocks),
    element: mount,
    extensions: [...screenplayExtensions, PaginationExtension, SeamCaretExtension],
  });
  return { editor, mount };
}

/**
 * The document position of the one mid-block page break `speechSplitBlocks` produces, read off
 * the pagination plugin's own live decorations -- the identical source `isMidBlockSeam` reads --
 * rather than recomputed by hand, so a change to `computePageBreaks`'s anchoring arithmetic cannot
 * silently desync this file from the code under test.
 */
function seamPosition(editor: Editor): number {
  const decorations = paginationPluginKey.getState(editor.state)?.decorations;
  const size = editor.state.doc.content.size;
  const found = decorations?.find(
    0,
    size,
    (spec: { key?: unknown }) => typeof spec.key === 'string' && spec.key.startsWith('page-break|'),
  );
  const seam = found?.[0];
  if (!seam) {
    throw new Error('speechSplitBlocks() produced no mid-block page break to seam-test against.');
  }
  return seam.from;
}

/** Places an empty selection at `pos`, the shape the invariant requires before drawing a caret there. */
function selectAt(editor: Editor, pos: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
}

/** Drives the plugin's `handleDOMEvents.blur` the same way a real focus change would, through the view's own registered DOM listener rather than by reaching into plugin internals. */
function blur(editor: Editor): void {
  editor.view.dom.dispatchEvent(new FocusEvent('blur'));
}

/**
 * Simulates a keystroke's two real stages, in the order a real browser produces them: `keydown`
 * first (through `view.someProp('handleKeyDown', ...)`, the same dispatch path
 * `screenplayEditor.test.ts`'s `pressKey` already uses -- this is what records the motion's shape
 * in the plugin's private `pendingKeyMotion`), then the selection actually landing at `pos`. jsdom
 * has no native contentEditable caret movement (the reason `resolveSeamDom`'s DOM measurement is
 * left to the e2e suite), so the second stage is a plain `setSelection` transaction standing in
 * for the selection-sync transaction `prosemirror-view`'s own DOM observer would dispatch once a
 * real browser had actually moved the caret -- the same substitution `selectAt` already makes for
 * a real click landing.
 */
function pressKeyTo(editor: Editor, key: string, pos: number, shiftKey = false): void {
  editor.view.someProp('handleKeyDown', (handler) =>
    handler(editor.view, new KeyboardEvent('keydown', { key, shiftKey })),
  );
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
}

/** Same as `pressKeyTo`, but the resulting selection is a genuine range rather than a collapsed caret -- what a real Shift-held arrow key produces. */
function pressKeyToRange(editor: Editor, key: string, from: number, to: number): void {
  editor.view.someProp('handleKeyDown', (handler) =>
    handler(editor.view, new KeyboardEvent('keydown', { key, shiftKey: true })),
  );
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
  );
}

function downstreamOf(editor: Editor): number | undefined {
  return seamCaretPluginKey.getState(editor.state)?.downstream;
}

/**
 * The ids of every block the plugin's own `.page-seam-caret-host` node decoration currently
 * renders onto, read from the real (jsdom) DOM the way `page-rendering-persistence.spec.ts` reads
 * it in a real browser -- `[data-screenplay-block].page-seam-caret-host` -- rather than by
 * introspecting `Decoration.node`'s private `type.attrs`, which is not part of its public surface.
 */
function suppressedBlockIds(mount: HTMLElement): string[] {
  return Array.from(mount.querySelectorAll('[data-screenplay-block].page-seam-caret-host')).map(
    (element) => element.getAttribute('data-block-id') ?? '',
  );
}

/**
 * Overrides one element's own `getBoundingClientRect`, the same technique -- and the same reason --
 * `floatingPanel.test.ts` uses it: jsdom lays nothing out, so a fixed `DOMRect` is what makes the
 * geometry under test an exact arithmetic claim rather than an approximation.
 */
function stubRect(element: Element, rect: DOMRect): void {
  element.getBoundingClientRect = () => rect;
}

/** `buildEditor`, but without `PaginationExtension` -- the shape `isMidBlockSeam`'s own `if
 * (!decorations)` guard exists for: a consumer that installs `SeamCaretExtension` without the
 * plugin it reads from. */
function buildEditorWithoutPagination(blocks: readonly ScreenplayBlock[]) {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({
    content: docContentFor(blocks),
    element: mount,
    extensions: [...screenplayExtensions, SeamCaretExtension],
  });
  return { editor, mount };
}

/**
 * `buildEditor`, but with the mount wrapped in a `.editor-region` ancestor -- the element
 * `SeamCaretView.sync` requires (`this.view.dom.closest('.editor-region')`) before it will draw
 * anything, matching `App.tsx:1086`'s real `<section className="editor-region">`. The bare
 * `buildEditor` above deliberately omits it: every other test in this file drives the plugin's
 * state machine only, and `sync`'s own DOM-measurement half is exactly what this omission was
 * documented (this file's header comment) to be leaving to the e2e suite.
 */
function buildEditorInRegion(blocks: readonly ScreenplayBlock[]) {
  const region = document.createElement('div');
  region.className = 'editor-region';
  document.body.append(region);
  const mount = document.createElement('div');
  region.append(mount);
  const editor = new Editor({
    content: docContentFor(blocks),
    element: mount,
    extensions: [...screenplayExtensions, PaginationExtension, SeamCaretExtension],
  });
  return { editor, region };
}

/**
 * Drives the seam caret plugin's own `handleClick` directly, with a synthetic event carrying only
 * the one field this module reads off it (`clientY`). Reached via `seamCaretPluginKey.get` rather
 * than `view.someProp('handleClick', ...)`: `someProp` returns the first *truthy* result across
 * every plugin's `handleClick`, and this module's own always returns `false` (its own doc comment:
 * "returns `false` in every case") -- `someProp` would report `undefined` regardless of what this
 * handler actually decided, and would skip calling it at all if an earlier-registered plugin's own
 * `handleClick` happened to return truthy for the same event first.
 */
function dispatchHandleClick(editor: Editor, pos: number, clientY: number): boolean | undefined {
  const handleClick = seamCaretPluginKey.get(editor.state)?.props.handleClick as
    | ((view: Editor['view'], pos: number, event: MouseEvent) => boolean | undefined)
    | undefined;
  if (!handleClick) {
    throw new Error('seamCaret plugin has no handleClick prop registered');
  }
  return handleClick(editor.view, pos, new MouseEvent('click', { clientY }));
}

describe('setSeamCaretDownstream', () => {
  it('records the seam position and decorates the block that hosts it', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam);

    setSeamCaretDownstream(editor.view, seam);

    expect(downstreamOf(editor)).toBe(seam);
    expect(suppressedBlockIds(mount)).toEqual(['00000000-0000-4000-a000-000000000002']);

    editor.destroy();
    mount.remove();
  });

  it('clears the recorded position and its decoration when set back to undefined', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam);
    setSeamCaretDownstream(editor.view, seam);

    setSeamCaretDownstream(editor.view, undefined);

    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  /**
   * The decoration lands on the dialogue block that hosts the seam -- and only that block, not the
   * action block above it or the document as a whole. `speechSplitBlocks` gives every block a
   * distinct id for exactly this: a decoration on the wrong block would still pass a test that
   * only checked "some decoration exists".
   */
  it('lands the suppression decoration on the seam block and no other', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam);

    setSeamCaretDownstream(editor.view, seam);

    // Exactly one decoration, spanning exactly the dialogue block's own node range -- not the
    // document, not the action block above it, not a sub-range inside the dialogue block's text.
    const decorations = seamCaretPluginKey.getState(editor.state)?.decorations;
    const size = editor.state.doc.content.size;
    const found = decorations?.find(0, size) ?? [];
    expect(found).toHaveLength(1);
    const $seam = editor.state.doc.resolve(seam);
    expect(found[0]?.from).toBe($seam.before($seam.depth));
    expect(found[0]?.to).toBe($seam.after($seam.depth));
    expect(suppressedBlockIds(mount)).toEqual(['00000000-0000-4000-a000-000000000002']);

    editor.destroy();
    mount.remove();
  });
});

describe('what clears a drawn seam caret', () => {
  it('an edit clears it, even one that leaves the selection exactly where it was', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam);
    setSeamCaretDownstream(editor.view, seam);
    expect(downstreamOf(editor)).toBe(seam);

    // A one-character insertion *after* the seam, at the very end of the document: mapping
    // through the transaction's own steps leaves a position before the insertion point --
    // `seam`, where the selection already sits -- untouched, so `newState.selection.from` is
    // still exactly `seam` afterward. This isolates `tr.docChanged` as the reason the caret
    // clears, independent of `selectionIsAtSeam`'s own separate clearing rule (covered by the
    // next test): a mutation that dropped the `docChanged` check but kept the selection check
    // would leave this test passing for the wrong reason if the edit also moved the selection
    // away, which is exactly why the insertion point is downstream of the seam rather than
    // upstream of it.
    const endOfDoc = editor.state.doc.content.size;
    editor.view.dispatch(editor.state.tr.insertText('!', endOfDoc));
    expect(editor.state.selection.from).toBe(seam);

    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  it('a selection move away from the seam clears it, with no document change at all', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam);
    setSeamCaretDownstream(editor.view, seam);
    expect(downstreamOf(editor)).toBe(seam);

    selectAt(editor, 1);

    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  it('losing focus clears it', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam);
    setSeamCaretDownstream(editor.view, seam);
    expect(downstreamOf(editor)).toBe(seam);

    blur(editor);

    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  /**
   * The case the whole state machine exists to get right. The pagination plugin dispatches a
   * transaction of exactly this shape -- `tr.setMeta(paginationPluginKey, ...)`, no steps, no
   * selection change -- once per animation frame (`paginationExtension.ts`'s `view().update`), and
   * SmartType's vocabulary refresh dispatches more of the same kind. A caret that vanished on the
   * very next frame would be no feature at all.
   */
  it('a same-frame no-op transaction of the kind pagination dispatches every frame does not clear it', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam);
    setSeamCaretDownstream(editor.view, seam);
    expect(downstreamOf(editor)).toBe(seam);

    const currentPaginationState = paginationPluginKey.getState(editor.state);
    editor.view.dispatch(editor.state.tr.setMeta(paginationPluginKey, currentPaginationState));

    expect(downstreamOf(editor)).toBe(seam);
    expect(suppressedBlockIds(mount)).toEqual(['00000000-0000-4000-a000-000000000002']);

    editor.destroy();
    mount.remove();
  });

  it('does nothing when no seam caret is currently drawn', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    expect(downstreamOf(editor)).toBeUndefined();

    editor.view.dispatch(editor.state.tr.insertText('!', 2));
    selectAt(editor, 1);
    blur(editor);

    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });
});

describe('handleKeyDown: per-motion affinity at the seam', () => {
  /**
   * The owner's rule (progress/page-seam-caret.md): horizontal motion arriving at the seam draws
   * downstream -- the visual start of page 2, the same rendering a click on the incoming sheet
   * already produces -- while vertical motion leaves it exactly where it already rendered before
   * this behaviour existed: upstream, at the end of page 1. Both `ArrowRight` from page 1's side
   * and `ArrowLeft` from page 2's side land on the identical seam position (the module header's
   * finding 1), which is why one arrival position is enough to exercise each key: the rule is
   * symmetric by construction and this module never has to know which side a keystroke travelled
   * from, only whether the keystroke was horizontal.
   */
  it.each(['ArrowLeft', 'ArrowRight', 'Home', 'End'])(
    '%s arriving at the seam draws downstream',
    (key) => {
      const { editor, mount } = buildEditor(speechSplitBlocks());
      const seam = seamPosition(editor);
      selectAt(editor, seam - 1);

      pressKeyTo(editor, key, seam);

      expect(downstreamOf(editor)).toBe(seam);
      expect(suppressedBlockIds(mount)).toEqual(['00000000-0000-4000-a000-000000000002']);

      editor.destroy();
      mount.remove();
    },
  );

  /**
   * `ArrowUp` from the right-hand end of page 2's first line resolves to this identical seam
   * position (module header, same finding), and the owner explicitly rejected drawing it
   * downstream there: it would make the caret appear to jump forward to page 2's margin instead
   * of moving back to page 1. These four keys are excluded from the horizontal set for exactly
   * that reason, not by oversight -- each is asserted here to leave `downstream` exactly as it
   * was before this feature existed: unset.
   */
  it.each(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'])(
    '%s arriving at the seam leaves it upstream',
    (key) => {
      const { editor, mount } = buildEditor(speechSplitBlocks());
      const seam = seamPosition(editor);
      selectAt(editor, seam - 1);

      pressKeyTo(editor, key, seam);

      expect(downstreamOf(editor)).toBeUndefined();
      expect(suppressedBlockIds(mount)).toEqual([]);

      editor.destroy();
      mount.remove();
    },
  );

  /**
   * Already guaranteed by the module's own invariant (`selectionIsAtSeam` requires
   * `selection.empty`) for every OTHER way a caret gets drawn, but not yet exercised against this
   * specific new code path -- a Shift-held arrow key produces a genuine range selection, not a
   * moved caret. This is the end-to-end behaviour a real Shift+ArrowRight must have; the two tests
   * below isolate the two separate guards that (redundantly, by design) both produce it.
   */
  it('Shift+ArrowRight extending onto the seam does not draw a caret', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam - 1);

    pressKeyToRange(editor, 'ArrowRight', seam - 1, seam);

    expect(editor.state.selection.empty).toBe(false);
    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  /**
   * Isolates `appendTransaction`'s own `!newState.selection.empty` guard from
   * `handleKeyDown`'s `shiftKey` branch above: `pendingKeyMotion` is set by a plain (non-Shift)
   * horizontal keydown here, and the transaction that follows just happens to land a range, not a
   * caret, with the seam as its `.from` end (the position `appendTransaction` actually reads) --
   * the shape a real Shift-held key produces, reached by a different route so a mutation that
   * removed the empty-selection guard specifically (rather than the `shiftKey` branch, which this
   * test does not exercise at all) is still caught on its own. The range runs `seam` to `seam + 2`,
   * not `seam - 2` to `seam`: `TextSelection.from` is always the smaller of the two ends
   * regardless of anchor/head order, so a range that put the seam at the larger end would leave
   * `.from` at a position this module has nothing to say about, and the guard's removal would go
   * unnoticed -- exactly the vacuous-test shape `progress/page-seam-caret.md`'s own mutation report
   * (M1) already warns about, caught here in the same way: by mutation testing, not by review.
   */
  it('a non-empty selection whose `.from` is the seam is never drawn downstream', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam);

    editor.view.someProp('handleKeyDown', (handler) =>
      handler(editor.view, new KeyboardEvent('keydown', { key: 'ArrowRight' })),
    );
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, seam, seam + 2)),
    );

    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  /**
   * Isolates the other side: `handleKeyDown`'s `shiftKey` branch specifically, independent of
   * `appendTransaction`'s empty-selection guard. A Shift-held key's own resulting transaction is
   * never dispatched here at all -- instead, after the Shift+ArrowRight keydown, an unrelated
   * COLLAPSED selection change lands on the seam with no keydown of its own (standing in for the
   * writer releasing Shift and then clicking, or focus moving programmatically). If
   * `handleKeyDown` did not clear `pendingKeyMotion` on a Shift-held key, that stale `horizontal`
   * would still be sitting there and this later, keyboardless, empty-selection arrival would pass
   * the empty-selection guard fine and draw -- which is exactly what a mutation removing the
   * `shiftKey` branch produces, and what the test above cannot see (its own Shift+ArrowRight
   * always produces a non-empty selection, which the *other* guard alone is already enough to
   * block).
   */
  it("a Shift-held key's motion does not leak onto a later, keyboardless arrival at the seam", () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam - 3);

    editor.view.someProp('handleKeyDown', (handler) =>
      handler(editor.view, new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true })),
    );
    selectAt(editor, seam);

    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  /**
   * `pendingKeyMotion` is consumed by the very next selection change, whatever it turns out to
   * be -- here, one that does not land at the seam at all -- so it must not still be "spent" on
   * some later, unrelated arrival at the seam that involved no keydown of its own (a plain
   * `selectAt`, standing in for a programmatic move or a click, neither of which touches the
   * keyboard). A mutation that only reset `pendingKeyMotion` inside the branch that actually
   * draws a caret (rather than on every observed selection change) would leave this test failing.
   */
  it('a horizontal key intent is spent on the next selection change, not reused for a later one', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam - 3);

    pressKeyTo(editor, 'ArrowRight', seam - 2);
    expect(downstreamOf(editor)).toBeUndefined();

    selectAt(editor, seam);

    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  /**
   * The other half of "spent on the next selection change" above: a same-frame no-op transaction
   * -- the exact shape `paginationExtension.ts` dispatches once per animation frame, no steps, no
   * selection change, already covered for the click-driven state machine by
   * `describe('what clears a drawn seam caret'`'s own test of the same name -- must not count as
   * that "next selection change" and consume the pending motion early. A real keydown and the
   * selection-sync transaction it eventually produces are not atomic with each other; a
   * pagination frame genuinely can land in between. Consuming the motion on this no-op would
   * mean the real move, when it finally arrives, finds nothing pending and silently fails to draw
   * -- while consuming it here also happens to draw nothing (the position the no-op observes
   * hasn't moved yet), so this test is the only thing standing between that regression and green.
   */
  it('a pending horizontal motion survives a same-frame no-op transaction and is spent by the real selection change', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam - 1);

    editor.view.someProp('handleKeyDown', (handler) =>
      handler(editor.view, new KeyboardEvent('keydown', { key: 'ArrowRight' })),
    );

    const currentPaginationState = paginationPluginKey.getState(editor.state);
    editor.view.dispatch(editor.state.tr.setMeta(paginationPluginKey, currentPaginationState));
    expect(downstreamOf(editor)).toBeUndefined();

    // The real selection-sync transaction, standing in for the browser's native caret movement
    // finally landing at the seam.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, seam)),
    );

    expect(downstreamOf(editor)).toBe(seam);
    expect(suppressedBlockIds(mount)).toEqual(['00000000-0000-4000-a000-000000000002']);

    editor.destroy();
    mount.remove();
  });

  /**
   * `handleClick`'s own decision is unconditional (it calls `setSeamCaretDownstream` with
   * whatever the click's geometry decided, every time, per its own doc comment above) and must
   * not be fought or second-guessed by a motion this module merely recorded from an earlier
   * keydown. `setSeamCaretDownstream` stands in for that decision here the same way it does in
   * every `describe('setSeamCaretDownstream', ...)` test above -- jsdom cannot exercise
   * `handleClick`'s own DOM geometry (this file's header comment), only the state machine every
   * caller of it, including `handleClick`, drives.
   */
  it('a click overrides a caret drawn downstream by an earlier horizontal key arrival', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam - 1);
    pressKeyTo(editor, 'ArrowRight', seam);
    expect(downstreamOf(editor)).toBe(seam);

    // Standing in for a click that landed above the incoming sheet's paper edge (behaviour 1 in
    // page-rendering-persistence.spec.ts): `handleClick` decides `undefined` there, unconditionally.
    setSeamCaretDownstream(editor.view, undefined);

    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });
});

/**
 * `handleClick`'s own geometry decision -- `pixelsPerInch`, `incomingSheetTopY` and
 * `clickedIncomingSheet` together (this file's header comment: none of the three is exported, so
 * the only way to exercise them without editing `seamCaret.ts` is through the one plugin prop that
 * calls all three). `resolveSeamDom`'s DOM walk runs first in every case here too, since
 * `handleClick` only calls the geometry functions once it has found the widget.
 *
 * Every expected `sheetTop` below is computed independently from the relationship stated in
 * `incomingSheetTopY`'s own doc comment -- `spacer.bottom - MARGIN_TOP_IN * pixelsPerInch` -- using
 * this file's own stubbed rects, not transcribed from the implementation's arithmetic, so a mutation
 * to that arithmetic has something to disagree with.
 */
describe('handleClick: the sheet-edge boundary', () => {
  it("a click below the incoming sheet's paper edge, at a non-1.0 zoom, records the seam position", () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    const widget = mount.querySelector('.page-break-widget') as HTMLElement;
    const spacer = widget.querySelector('.page-break-spacer') as HTMLElement;

    // pixelsPerInch = 864 / BODY_WIDTH_IN(6) = 144 -- a 1.5x-zoomed page, not the CSS default of 96,
    // because measuring off the widget rather than reading application zoom state only proves
    // anything if the scale it measures is not the default.
    stubRect(widget, new DOMRect(0, 0, 864, 0));
    stubRect(spacer, new DOMRect(0, 0, 0, 1000));
    const pixelsPerInch = 864 / BODY_WIDTH_IN;
    const sheetTop = 1000 - MARGIN_TOP_IN * pixelsPerInch; // 856

    const handled = dispatchHandleClick(editor, seam, sheetTop + 1);

    expect(handled).toBe(false);
    expect(downstreamOf(editor)).toBe(seam);
    expect(suppressedBlockIds(mount)).toEqual(['00000000-0000-4000-a000-000000000002']);

    editor.destroy();
    mount.remove();
  });

  it('a click exactly at the paper edge is inclusive: it also reads as the incoming sheet', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    const widget = mount.querySelector('.page-break-widget') as HTMLElement;
    const spacer = widget.querySelector('.page-break-spacer') as HTMLElement;

    stubRect(widget, new DOMRect(0, 0, 864, 0));
    stubRect(spacer, new DOMRect(0, 0, 0, 1000));
    const pixelsPerInch = 864 / BODY_WIDTH_IN;
    const sheetTop = 1000 - MARGIN_TOP_IN * pixelsPerInch; // 856

    const handled = dispatchHandleClick(editor, seam, sheetTop);

    expect(handled).toBe(false);
    expect(downstreamOf(editor)).toBe(seam);
    expect(suppressedBlockIds(mount)).toEqual(['00000000-0000-4000-a000-000000000002']);

    editor.destroy();
    mount.remove();
  });

  it('a click above the paper edge is page 1: it records nothing', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    const widget = mount.querySelector('.page-break-widget') as HTMLElement;
    const spacer = widget.querySelector('.page-break-spacer') as HTMLElement;

    stubRect(widget, new DOMRect(0, 0, 864, 0));
    stubRect(spacer, new DOMRect(0, 0, 0, 1000));
    const pixelsPerInch = 864 / BODY_WIDTH_IN;
    const sheetTop = 1000 - MARGIN_TOP_IN * pixelsPerInch; // 856

    const handled = dispatchHandleClick(editor, seam, sheetTop - 1);

    expect(handled).toBe(false);
    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  /**
   * `pixelsPerInch`'s own fallback branch: a widget that has not been laid out yet (width 0, e.g.
   * the very first paint) still needs a sane answer rather than a division that leaves the edge at
   * `spacer.bottom - 0`. `CSS_PX_PER_IN` (96) is the specification's fixed px-per-inch, stated in
   * `seamCaret.ts` rather than sourced from application state, so it is restated independently here
   * rather than imported.
   */
  it('a widget with no measured width falls back to the CSS px-per-inch instead of an infinite edge', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    const widget = mount.querySelector('.page-break-widget') as HTMLElement;
    const spacer = widget.querySelector('.page-break-spacer') as HTMLElement;

    stubRect(widget, new DOMRect(0, 0, 0, 0));
    stubRect(spacer, new DOMRect(0, 0, 0, 200));
    const cssPxPerIn = 96;
    const sheetTop = 200 - MARGIN_TOP_IN * cssPxPerIn; // 104

    expect(dispatchHandleClick(editor, seam, sheetTop + 1)).toBe(false);
    expect(downstreamOf(editor)).toBe(seam);

    expect(dispatchHandleClick(editor, seam, sheetTop - 1)).toBe(false);
    expect(downstreamOf(editor)).toBeUndefined();

    editor.destroy();
    mount.remove();
  });

  /**
   * `incomingSheetTopY`'s other guard: a widget whose spacer is missing entirely (not merely
   * mis-sized) yields no edge to compare against at all, and therefore no decision -- not even for
   * a `clientY` so large it would read as "below" any edge that could plausibly exist. This is the
   * fallback the module's own header comment calls "leaving today's behaviour" -- nothing drawn,
   * nothing suppressed.
   */
  it('a widget with no `.page-break-spacer` yields no decision at all, regardless of clientY', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    const widget = mount.querySelector('.page-break-widget') as HTMLElement;
    widget.querySelector('.page-break-spacer')?.remove();

    const handled = dispatchHandleClick(editor, seam, 999_999);

    expect(handled).toBe(false);
    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  /**
   * `isMidBlockSeam` gates `handleClick`'s whole decision (seamCaret.ts:431): a click at a document
   * position that is not a mid-block seam -- here, inside the action block's own text, nowhere near
   * a page break -- must record nothing, and must actively clear a caret an earlier click drew,
   * since `handleClick` runs unconditionally on every click per its own doc comment.
   */
  it('a click at a position that is not a mid-block seam records nothing, clearing an earlier decision', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    selectAt(editor, seam);
    setSeamCaretDownstream(editor.view, seam);
    expect(downstreamOf(editor)).toBe(seam);

    const handled = dispatchHandleClick(editor, 1, 0);

    expect(handled).toBe(false);
    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  /**
   * `resolveSeamDom`'s own fallback (seamCaret.ts:176-179): the module's doc comment states the
   * widget is the break's immediate DOM sibling "in every case observed in a real browser," and
   * this is what happens when that shape is not there -- the sibling-search loop runs out of
   * candidates within its budget and resolves to no DOM at all, rather than guessing. Corrupting
   * the one class the walk keys on (`page-break-widget`) is the narrowest way to break the shape
   * without breaking `isMidBlockSeam`'s own, unrelated, decoration-based check, so this test isolates
   * `resolveSeamDom`'s fallback specifically rather than `isMidBlockSeam`'s.
   */
  it('a widget whose DOM no longer has the class resolveSeamDom keys on yields no caret', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());
    const seam = seamPosition(editor);
    const widget = mount.querySelector('.page-break-widget') as HTMLElement;
    const spacer = widget.querySelector('.page-break-spacer') as HTMLElement;
    stubRect(widget, new DOMRect(0, 0, 864, 0));
    stubRect(spacer, new DOMRect(0, 0, 0, 1000));
    widget.classList.remove('page-break-widget');

    // Comfortably below the edge computed above (856) if the widget had resolved at all.
    const handled = dispatchHandleClick(editor, seam, 900);

    expect(handled).toBe(false);
    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });
});

describe('seam caret degradation: no pagination plugin, non-textblock positions', () => {
  /**
   * `isMidBlockSeam`'s own `if (!decorations) return false;` guard (seamCaret.ts:133-134): a
   * consumer that installs `SeamCaretExtension` without `PaginationExtension` -- not how `App.tsx`
   * wires them, but nothing in `SeamCaretExtension`'s own definition prevents it -- must not throw
   * reading a plugin state that was never registered, and must resolve to no decision.
   */
  it('degrades to no decision when the pagination plugin is not installed', () => {
    const { editor, mount } = buildEditorWithoutPagination(speechSplitBlocks());

    const handled = dispatchHandleClick(editor, 1, 0);

    expect(handled).toBe(false);
    expect(downstreamOf(editor)).toBeUndefined();
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });

  /**
   * `suppressionDecorations`' own `if (!$seam.parent.isTextblock) return DecorationSet.empty;`
   * guard (seamCaret.ts:109-111). Position 0's parent is the document's own top node, never a
   * textblock, and is reachable here only through the exported `setSeamCaretDownstream` --
   * `handleClick`'s own call site never passes a position outside a validated mid-block seam, so
   * this is a defensive guard on the state machine's public surface, not a shape a click can
   * trigger, and is tested as exactly that: the recorded position still updates, but nothing is
   * drawn or suppressed for it.
   */
  it('a recorded position whose parent is not a textblock draws no suppression decoration', () => {
    const { editor, mount } = buildEditor(speechSplitBlocks());

    setSeamCaretDownstream(editor.view, 0);

    expect(downstreamOf(editor)).toBe(0);
    expect(suppressedBlockIds(mount)).toEqual([]);

    editor.destroy();
    mount.remove();
  });
});

/**
 * `SeamCaretView`'s DOM half: the arithmetic `sync` uses to place the drawn caret, the resize
 * listener that keeps it correct across a window resize with no transaction of its own, and the
 * lifecycle that tears both down. This file's header comment explains why the other 22 tests in
 * this file cannot reach any of it: jsdom's `Range` has no `getClientRects` or `getBoundingClientRect`
 * at all (verified directly against this project's own jsdom, not assumed) -- calling either
 * unconditionally, the way `downstreamCaretRect` does, would throw. Both are stubbed on `Range.prototype`
 * for exactly the tests below, the same way `floatingPanel.test.ts` stubs `getBoundingClientRect` on
 * individual elements, and restored afterward so no other test in this project observes the stub.
 */
describe('SeamCaretView: drawing, resync, and lifecycle', () => {
  const originalGetClientRects = Range.prototype.getClientRects;
  const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;

  afterEach(() => {
    if (originalGetClientRects === undefined) {
      delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
    } else {
      Range.prototype.getClientRects = originalGetClientRects;
    }
    if (originalGetBoundingClientRect === undefined) {
      delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    } else {
      Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  /**
   * `downstreamCaretRect` takes the browser's own answer for "what would the native caret's rect
   * have been" (module doc comment) via `range.getClientRects()[0]`, falling back to
   * `range.getBoundingClientRect()` when that is empty -- the only shape jsdom can produce, since it
   * implements neither with real layout. Stubbing `getClientRects` to return `[]` therefore exercises
   * the exact fallback this module depends on, not a shortcut around it.
   *
   * The expected `top`/`left` are computed independently from `sync`'s own stated relationship (its
   * doc comment): region-content coordinates are the viewport rect minus the region's own viewport
   * origin, plus the region's current scroll offset.
   */
  it("draws a caret at the browser's own downstream rect, converted into the region's scroll coordinates", () => {
    const { editor, region } = buildEditorInRegion(speechSplitBlocks());
    const seam = seamPosition(editor);
    const widget = region.querySelector('.page-break-widget') as HTMLElement;
    stubRect(widget, new DOMRect(0, 0, 864, 0)); // pixelsPerInch = 144
    stubRect(region, new DOMRect(50, 20, 700, 900));
    region.scrollTop = 30;
    region.scrollLeft = 5;
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect(120, 260, 0, 16);

    selectAt(editor, seam);
    setSeamCaretDownstream(editor.view, seam);

    const caret = region.querySelector('.page-seam-caret') as HTMLDivElement | null;
    expect(caret).not.toBeNull();
    expect(caret?.getAttribute('aria-hidden')).toBe('true');
    expect(caret?.style.top).toBe('270px'); // 260 - 20 + 30
    expect(caret?.style.left).toBe('75px'); // 120 - 50 + 5
    expect(caret?.style.height).toBe('16px');
    expect(caret?.style.width).toBe('1.5px'); // (864 / BODY_WIDTH_IN) / 96

    editor.destroy();
    region.remove();
  });

  /**
   * The resize listener (seamCaret.ts:530-531): a window resize moves `.page` -- and this caret --
   * sideways with no transaction dispatched (module comment on the listener), so nothing in the
   * plugin state changes; only a fresh `region.getBoundingClientRect()` measurement would notice.
   * The region's stubbed rect is changed *after* the first draw and *before* the resize fires, so a
   * mutation that dropped the `window.addEventListener('resize', resync)` registration leaves the
   * caret at its stale position and this assertion catches it.
   */
  it('a window resize re-measures and moves the caret, with no transaction involved', () => {
    const { editor, region } = buildEditorInRegion(speechSplitBlocks());
    const seam = seamPosition(editor);
    const widget = region.querySelector('.page-break-widget') as HTMLElement;
    stubRect(widget, new DOMRect(0, 0, 576, 0)); // pixelsPerInch = 96
    let regionRect = new DOMRect(0, 0, 700, 900);
    region.getBoundingClientRect = () => regionRect;
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect(100, 200, 0, 16);

    selectAt(editor, seam);
    setSeamCaretDownstream(editor.view, seam);
    const caret = region.querySelector('.page-seam-caret') as HTMLDivElement;
    expect(caret.style.left).toBe('100px'); // 100 - 0 + 0

    regionRect = new DOMRect(-40, 0, 700, 900);
    window.dispatchEvent(new Event('resize'));

    expect(caret.style.left).toBe('140px'); // 100 - (-40) + 0

    editor.destroy();
    region.remove();
  });

  /**
   * `sync`'s own removal path, already exercised at the plugin-state level by `describe('what
   * clears a drawn seam caret'`'s "losing focus" test -- this isolates the DOM half that test
   * cannot see (the plugin state check there never reached `sync` successfully, for the same reason
   * this file's header comment gives): the painted element itself must actually leave the DOM, not
   * merely stop being reflected in plugin state.
   */
  it('losing focus removes the drawn element from the DOM, not just the plugin state', () => {
    const { editor, region } = buildEditorInRegion(speechSplitBlocks());
    const seam = seamPosition(editor);
    const widget = region.querySelector('.page-break-widget') as HTMLElement;
    stubRect(widget, new DOMRect(0, 0, 576, 0));
    stubRect(region, new DOMRect(0, 0, 700, 900));
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect(100, 200, 0, 16);

    selectAt(editor, seam);
    setSeamCaretDownstream(editor.view, seam);
    expect(region.querySelector('.page-seam-caret')).not.toBeNull();

    editor.view.dom.dispatchEvent(new FocusEvent('blur'));

    expect(region.querySelector('.page-seam-caret')).toBeNull();

    editor.destroy();
    region.remove();
  });

  /**
   * The other half of the resize listener's lifecycle: `destroy()` (seamCaret.ts:534) must remove
   * exactly the listener `view()` registered, or every editor this plugin was ever attached to
   * leaks one `resize` listener referencing a destroyed view for the lifetime of the page.
   */
  it('destroying the editor removes its window resize listener', () => {
    const { editor, region } = buildEditorInRegion(speechSplitBlocks());
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    editor.destroy();

    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));

    removeSpy.mockRestore();
    region.remove();
  });
});

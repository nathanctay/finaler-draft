import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { ScreenplayBlock } from '@finaler-draft/screenplay';
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

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

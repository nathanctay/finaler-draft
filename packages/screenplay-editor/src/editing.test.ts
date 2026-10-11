import { describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  SCREENPLAY_SCHEMA_VERSION,
  safeParseScreenplay,
  type Screenplay,
} from '@finaler-draft/screenplay';
import {
  convertActiveScreenplayBlock,
  createLocalScreenplayEditorInit,
  displayElement,
  editorContentFromScreenplay,
  findScreenplayBlockPosition,
  getActiveScreenplayBlock,
  projectDocumentScreenplay,
  projectEditorScreenplay,
  projectLocalScreenplay,
  type EditorContent,
  type ScreenplayElementType,
} from './index.js';

/**
 * Position 0 -- the document's own top level, before the first block's content -- is a real,
 * reachable caret position (`selectBeforeFirstBlock` in the paste tests further down relies on
 * this too), and `getActiveBlock`'s depth-walk finds no `screenplayBlock` ancestor there:
 * `$from.depth` is 0, so the loop in `getActiveBlock` never runs at all. Every keymap entry in
 * `ScreenplayBlockNode` (`Enter`, `Tab`, `Space`) and both of `getActiveScreenplayBlock`'s and
 * `convertActiveScreenplayBlock`'s own `if (!activeBlock)` guards exist for exactly this state --
 * a document that has content, just none the caret is currently inside. This block of describes
 * (through `editorContentFromScreenplay`, below) closes gaps `apps/web/src/screenplayEditor.test.ts`
 * left uncovered even before the code moved here -- see the coverage report cited in this
 * package's PR for the exact line ranges each one closes.
 */
function selectAtDocumentBoundary(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 0)));
}

/**
 * Moved here from `apps/web/src/screenplayEditor.test.ts` when the code these tests exercise
 * (element conversion, splitting, the leading-space guard, `projectDocumentScreenplay`, and paste
 * sanitisation) moved to this package. They kept importing from the `apps/web` re-export shim
 * after the move, which still ran them but credited their coverage to that one-line shim file, not
 * to this package's `index.ts` where the code actually lives -- `packages/screenplay-editor` was
 * shipping with a fraction of the coverage the code had on `main`. `index.test.ts` (this
 * directory's other test file) is unaffected: it already covered exactly the Yjs-facing seams that
 * have no other direct test, and continues to.
 */

/** Every test editor here is Yjs-backed (`createLocalScreenplayEditorInit` requires content), but
 * none of them exercise collaboration itself -- a fresh, local, unconnected `Y.Doc` seeded with
 * `content` is exactly as good a source for these tests as the old plain `content` editor option
 * was, and keeps every assertion below about editing behaviour, not about Yjs. */
function editorInitFor(content: EditorContent) {
  return createLocalScreenplayEditorInit(content);
}

/**
 * Pressing Enter is the only way a writer changes element while typing, so where the caret sits
 * when they press it decides whether they are starting the next element or breaking the current
 * one in two. These tests drive the real editor through the real keymap rather than calling the
 * split helper directly: the caret-position rule under test only means anything in terms of a real
 * selection in a real document.
 */

type Block = { element: ScreenplayElementType; text: string };

function buildEditor(blocks: readonly Block[]) {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({
    element: mount,
    ...editorInitFor({
      type: 'screenplayDocument' as const,
      content: blocks.map((block, index) => ({
        type: 'screenplayBlock' as const,
        attrs: { element: block.element, id: `block-${index}` },
        ...(block.text === '' ? {} : { content: [{ type: 'text', text: block.text }] }),
      })),
    }),
  });
  return { editor, mount };
}

/**
 * Places the caret at `offset` characters into the first block and presses Enter through the
 * editor's own keymap. `someProp('handleKeyDown')` is how ProseMirror dispatches a key event to the
 * plugins that registered for it, so this exercises the same path a real keypress takes.
 */
function pressEnterAt(editor: Editor, offset: number): void {
  const transaction = editor.state.tr.setSelection(
    TextSelection.create(editor.state.doc, 1 + offset),
  );
  editor.view.dispatch(transaction);
  const handled = editor.view.someProp('handleKeyDown', (handler) =>
    handler(editor.view, new KeyboardEvent('keydown', { key: 'Enter' })),
  );
  expect(handled).toBe(true);
}

function blocksOf(editor: Editor): Array<{ element: unknown; text: string }> {
  const result: Array<{ element: unknown; text: string }> = [];
  editor.state.doc.forEach((node) => {
    result.push({ element: node.attrs.element, text: node.textContent });
  });
  return result;
}

/**
 * Every top-level block's `id` attribute, in document order, untyped (`unknown`) on purpose: the
 * defect this closes is a `screenplayBlock` whose `id` is `null` rather than a string, and a test
 * asserting document integrity has to be able to see that, not have it coerced away.
 */
function idsOf(editor: Editor): unknown[] {
  const ids: unknown[] = [];
  editor.state.doc.forEach((node) => {
    ids.push(node.attrs.id);
  });
  return ids;
}

/**
 * Sets a selection inside the first (and, in the tests using this, only) block, `[from, to)`
 * characters into its text -- a collapsed caret when `to` is omitted. Shared by the parenthetical
 * and leading-space tests below, which need a caret or a range positioned precisely, not just at
 * the block's edge the way `pressEnterAt` above only ever needs.
 */
function setSelectionInFirstBlock(editor: Editor, from: number, to: number = from): void {
  const transaction = editor.state.tr.setSelection(
    TextSelection.create(editor.state.doc, 1 + from, 1 + to),
  );
  editor.view.dispatch(transaction);
}

/**
 * Dispatches `key` through the editor's real keymap, the same `someProp('handleKeyDown')` path
 * `pressEnterAt` above uses, and returns whether some handler claimed it -- unlike `pressEnterAt`,
 * callers here need to assert `false` (the guard under test declined to intervene) as often as
 * `true`, so this returns the result instead of asserting it itself.
 */
function pressKey(editor: Editor, key: string): boolean {
  return (
    editor.view.someProp('handleKeyDown', (handler) =>
      handler(editor.view, new KeyboardEvent('keydown', { key })),
    ) ?? false
  );
}

describe('Enter', () => {
  it('starts the next element when the caret is at the end of a block', () => {
    const { editor, mount } = buildEditor([{ element: 'character', text: 'ADA' }]);

    pressEnterAt(editor, 'ADA'.length);

    expect(blocksOf(editor)).toEqual([
      { element: 'character', text: 'ADA' },
      { element: 'dialogue', text: '' },
    ]);
    editor.destroy();
    mount.remove();
  });

  /**
   * Uses `scene_heading` rather than `action` deliberately. Action's entry in the convention maps
   * to action, so an action block splits to action whichever rule is in force and a test written
   * on it cannot fail. Every element used in this file is one whose convention target differs from
   * itself, so each test can actually detect the behaviour it describes.
   */
  it('keeps the element on both halves when the caret is mid-block', () => {
    const { editor, mount } = buildEditor([
      { element: 'scene_heading', text: 'INT. KITCHEN - NIGHT' },
    ]);

    pressEnterAt(editor, 'INT. KITCHEN'.length);

    expect(blocksOf(editor)).toEqual([
      { element: 'scene_heading', text: 'INT. KITCHEN' },
      { element: 'scene_heading', text: ' - NIGHT' },
    ]);
    editor.destroy();
    mount.remove();
  });

  /**
   * The regression this behaviour was added for: splitting a cue mid-word used to retype the
   * remainder as dialogue, because the new half was always given the next element in the
   * convention regardless of where the caret was.
   */
  it('does not convert the remainder when a non-action element is split mid-block', () => {
    const { editor, mount } = buildEditor([{ element: 'character', text: 'ADA MERCER' }]);

    pressEnterAt(editor, 'ADA '.length);

    expect(blocksOf(editor)).toEqual([
      { element: 'character', text: 'ADA ' },
      { element: 'character', text: 'MERCER' },
    ]);
    editor.destroy();
    mount.remove();
  });

  it('treats the caret at offset 0 as a mid-block split, not the start of a new element', () => {
    const { editor, mount } = buildEditor([{ element: 'dialogue', text: 'I never said that.' }]);

    pressEnterAt(editor, 0);

    expect(blocksOf(editor)).toEqual([
      { element: 'dialogue', text: '' },
      { element: 'dialogue', text: 'I never said that.' },
    ]);
    editor.destroy();
    mount.remove();
  });

  it('still advances on an empty block, which is both the start and the end of its text', () => {
    const { editor, mount } = buildEditor([{ element: 'character', text: '' }]);

    pressEnterAt(editor, 0);

    expect(blocksOf(editor)).toEqual([
      { element: 'character', text: '' },
      { element: 'dialogue', text: '' },
    ]);
    editor.destroy();
    mount.remove();
  });

  /**
   * The reported defect: at the bottom of the document and the bottom of the scroll, Enter split
   * the block but the view never scrolled -- it only scrolled once the writer typed a character
   * into the new line. jsdom lays nothing out, so this cannot observe an actual pixel scroll (that
   * is `page-rendering-persistence.spec.ts`'s job); what it can observe is the one thing that
   * decides whether ProseMirror will scroll at all -- every `prosemirror-commands` command marks
   * its own transaction with `.scrollIntoView()` (`Transaction.scrolledIntoView`,
   * `EditorState`'s `scrollToSelection` field only ever increments off it), and this split command
   * previously never did, which is exactly why typing afterward "fixed" it: ordinary text input
   * goes through ProseMirror's own `readDOMChange`, which always calls `tr.scrollIntoView()` on
   * its own separate transaction.
   *
   * Spies on `dispatch` rather than calling `splitScreenplayBlock` directly: this has to be the
   * transaction the real Enter keymap entry produces, not a hand-built one that could pass by
   * construction. `pressEnterAt` itself dispatches one transaction to place the selection before
   * triggering the keydown, so the split transaction is the *last* dispatch, not the only one.
   */
  it('asks the view to scroll the caret into view when Enter splits a block', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'Some action beat.' }]);
    const dispatchSpy = vi.spyOn(editor.view, 'dispatch');

    pressEnterAt(editor, 'Some action beat.'.length);

    const splitTransaction = dispatchSpy.mock.calls.at(-1)?.[0];
    expect(splitTransaction?.scrolledIntoView).toBe(true);
    editor.destroy();
    mount.remove();
  });
});

/**
 * plan.md, "Writing-flow behaviours borrowed from Final Draft": creating a parenthetical wraps
 * the block's text in `()` unless it is already wrapped; converting a parenthetical away strips a
 * leading `(` and trailing `)` only if both are present. Once written, the parentheses are
 * ordinary text -- there is nothing here exercising Backspace or Delete, because nothing in
 * `index.ts` treats them specially any more.
 */
describe('parentheticals own their parentheses', () => {
  it('wraps an empty block in () with the caret between them on conversion to parenthetical', () => {
    const { editor, mount } = buildEditor([{ element: 'dialogue', text: '' }]);
    setSelectionInFirstBlock(editor, 0);

    expect(convertActiveScreenplayBlock(editor, 'parenthetical')).toBe(true);

    expect(blocksOf(editor)).toEqual([{ element: 'parenthetical', text: '()' }]);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.to).toBe(2);
    editor.destroy();
    mount.remove();
  });

  it('wraps a non-empty, unwrapped block in () and keeps the caret at the same relative position', () => {
    const { editor, mount } = buildEditor([{ element: 'dialogue', text: 'to herself' }]);
    setSelectionInFirstBlock(editor, 3);

    expect(convertActiveScreenplayBlock(editor, 'parenthetical')).toBe(true);

    expect(blocksOf(editor)).toEqual([{ element: 'parenthetical', text: '(to herself)' }]);
    // Caret was 3 characters into "to herself"; it stays 3 characters past the same point, now
    // shifted one further by the inserted leading "(".
    expect(editor.state.selection.from).toBe(1 + 4);
    editor.destroy();
    mount.remove();
  });

  /**
   * The double-wrap guard, and the mutation most likely to pass vacuously if only tested against
   * freshly wrapped text (progress/writing-flow.md's own warning): text that already looks like a
   * parenthetical -- the shape an FDX-imported parenthetical arrives in -- must not be wrapped a
   * second time. Converting from `action` here (not `parenthetical`) is deliberate: it proves the
   * guard is about the text's shape, not about tracking where the block came from.
   */
  it('does not wrap text that already begins and ends with parentheses', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: '(already wrapped)' }]);
    setSelectionInFirstBlock(editor, 0);

    expect(convertActiveScreenplayBlock(editor, 'parenthetical')).toBe(true);

    expect(blocksOf(editor)).toEqual([{ element: 'parenthetical', text: '(already wrapped)' }]);
    editor.destroy();
    mount.remove();
  });

  it('strips both parentheses on conversion away from parenthetical', () => {
    const { editor, mount } = buildEditor([{ element: 'parenthetical', text: '(to herself)' }]);
    setSelectionInFirstBlock(editor, 6);

    expect(convertActiveScreenplayBlock(editor, 'dialogue')).toBe(true);

    expect(blocksOf(editor)).toEqual([{ element: 'dialogue', text: 'to herself' }]);
    expect(editor.state.selection.from).toBe(1 + 5);
    editor.destroy();
    mount.remove();
  });

  /**
   * The asymmetric case the owner called out explicitly: a writer can delete just one of the two
   * parentheses (ordinary text, ordinary Backspace) after creation, leaving a lone `(` or `)`.
   * Converting away must leave that alone rather than stripping the surviving parenthesis, which
   * would silently edit text the writer typed.
   */
  it('leaves a lone leading parenthesis alone on conversion away, rather than stripping it', () => {
    const { editor, mount } = buildEditor([{ element: 'parenthetical', text: '(beat' }]);
    setSelectionInFirstBlock(editor, 0);

    expect(convertActiveScreenplayBlock(editor, 'dialogue')).toBe(true);

    expect(blocksOf(editor)).toEqual([{ element: 'dialogue', text: '(beat' }]);
    editor.destroy();
    mount.remove();
  });

  it('leaves a lone trailing parenthesis alone on conversion away, rather than stripping it', () => {
    const { editor, mount } = buildEditor([{ element: 'parenthetical', text: 'beat)' }]);
    setSelectionInFirstBlock(editor, 0);

    expect(convertActiveScreenplayBlock(editor, 'dialogue')).toBe(true);

    expect(blocksOf(editor)).toEqual([{ element: 'dialogue', text: 'beat)' }]);
    editor.destroy();
    mount.remove();
  });

  it('leaves text with no real parentheses alone on conversion away from parenthetical', () => {
    const { editor, mount } = buildEditor([{ element: 'parenthetical', text: 'no parens here' }]);
    setSelectionInFirstBlock(editor, 0);

    expect(convertActiveScreenplayBlock(editor, 'dialogue')).toBe(true);

    expect(blocksOf(editor)).toEqual([{ element: 'dialogue', text: 'no parens here' }]);
    editor.destroy();
    mount.remove();
  });

  it('reaches the wrap behavior through the real Tab keymap, not only through calling the helper directly', () => {
    const { editor, mount } = buildEditor([{ element: 'dialogue', text: '' }]);
    setSelectionInFirstBlock(editor, 0);

    const handled = editor.view.someProp('handleKeyDown', (handler) =>
      handler(editor.view, new KeyboardEvent('keydown', { key: 'Tab' })),
    );

    expect(handled).toBe(true);
    expect(blocksOf(editor)).toEqual([{ element: 'parenthetical', text: '()' }]);
    editor.destroy();
    mount.remove();
  });
});

describe('a line cannot begin with a space', () => {
  it('blocks a space typed as the first character of an empty block', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: '' }]);
    setSelectionInFirstBlock(editor, 0);

    expect(pressKey(editor, ' ')).toBe(true);

    expect(blocksOf(editor)).toEqual([{ element: 'action', text: '' }]);
    editor.destroy();
    mount.remove();
  });

  it('blocks a space that would replace a range selection starting at the first character', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'Hello there.' }]);
    setSelectionInFirstBlock(editor, 0, 5);

    expect(pressKey(editor, ' ')).toBe(true);
    editor.destroy();
    mount.remove();
  });

  it('allows a space anywhere else in the block', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'Hello' }]);
    setSelectionInFirstBlock(editor, 5);

    expect(pressKey(editor, ' ')).toBe(false);
    editor.destroy();
    mount.remove();
  });
});

describe('projectDocumentScreenplay', () => {
  const sceneHeadingId = '00000000-0000-4000-8000-000000000301';

  function buildDocFor(text: string) {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      element: mount,
      ...editorInitFor({
        type: 'screenplayDocument',
        content: [
          {
            type: 'screenplayBlock',
            attrs: { element: 'scene_heading', id: sceneHeadingId },
            content: [{ type: 'text', text }],
          },
        ],
      }),
    });
    return { doc: editor.state.doc, editor, mount };
  }

  /**
   * The regression this increment fixed: the function used to take four positional parameters
   * with no `documentSettings` slot at all, so nothing ever reached `safeParseScreenplay` and the
   * schema's own `.default()` silently produced `DEFAULT_DOCUMENT_SETTINGS` regardless of what
   * the caller actually had. This is the narrowest possible reproduction of that bug, one level
   * below the full autosave-path regression in `App.test.tsx`.
   */
  it('threads a supplied documentSettings through to the projected screenplay, not the schema defaults', () => {
    const { doc, editor, mount } = buildDocFor('INT. WORKSHOP - NIGHT');
    const custom = {
      ...DEFAULT_DOCUMENT_SETTINGS,
      characterIndentIn: 4.2,
      sceneNumbersEnabled: true,
    };

    const projection = projectDocumentScreenplay(doc, { documentSettings: custom });

    expect(projection.valid).toBe(true);
    if (projection.valid) {
      expect(projection.screenplay.documentSettings).toEqual(custom);
    }
    editor.destroy();
    mount.remove();
  });

  it('falls back to the schema default when no documentSettings is supplied, matching every pre-existing call site', () => {
    const { doc, editor, mount } = buildDocFor('INT. WORKSHOP - NIGHT');

    const projection = projectDocumentScreenplay(doc);

    expect(projection.valid).toBe(true);
    if (projection.valid) {
      expect(projection.screenplay.documentSettings).toEqual(DEFAULT_DOCUMENT_SETTINGS);
    }
    editor.destroy();
    mount.remove();
  });
});

/**
 * `ScreenplayPasteSanitizer` (index.ts): the fix for `progress/paste-sanitization.md`.
 * These drive `EditorView.pasteHTML`/`pasteText`, the real paste pipeline (`transformPastedHTML`,
 * `DOMParser.fromSchema`, `transformPasted`), not a hand-rolled substitute -- the only thing not
 * exercised here is the browser's own HTML parser and the OS clipboard, which is what
 * `apps/web/e2e/persistence.spec.ts`'s real-browser paste test is for.
 */
describe('paste sanitisation', () => {
  const originalId = '00000000-0000-4000-8000-000000000401';
  const secondId = '00000000-0000-4000-8000-000000000402';
  const thirdId = '00000000-0000-4000-8000-000000000403';
  // Ids carried *by the clipboard*, as a same-document copy's serialised HTML does. No block the
  // paste produces may end up holding one of these: a pasted block is a new block.
  const pastedFirstId = '00000000-0000-4000-8000-000000000501';
  const pastedSecondId = '00000000-0000-4000-8000-000000000502';

  function buildPasteEditor(
    blocks: ReadonlyArray<{ element: ScreenplayElementType; id: string; text: string }>,
  ) {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      element: mount,
      ...editorInitFor({
        type: 'screenplayDocument' as const,
        content: blocks.map((block) => ({
          type: 'screenplayBlock' as const,
          attrs: { element: block.element, id: block.id },
          ...(block.text === '' ? {} : { content: [{ type: 'text', text: block.text }] }),
        })),
      }),
    });
    return { editor, mount };
  }

  /**
   * Positions the cursor before the very first block, at the document's own top level rather
   * than inside any block's text. `TextSelection.create` accepts this position directly (with a
   * harmless `console.warn` from `prosemirror-state`'s own sanity check, since position 0 has no
   * enclosing *inline* content -- it sits one level up, at the document) instead of snapping
   * inward the way `Selection.near`/`TextSelection.atStart` would. That distinction is exactly
   * what several tests below need: pasting a block-shaped slice at a genuine block boundary
   * inserts sibling blocks, while pasting the same slice at a position already inside a block's
   * text (what `Selection.near` would produce here) merges it into that block instead -- see the
   * dedicated mid-block test further down for that second case on its own.
   */
  function selectBeforeFirstBlock(editor: Editor): void {
    const selection = TextSelection.create(editor.state.doc, 0);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
  }

  // `pasteHTML`/`pasteText` take an optional `ClipboardEvent` only to forward to the
  // `handlePaste` hook, which nothing here registers -- jsdom has no `ClipboardEvent`
  // constructor, so an inert stand-in is enough to satisfy the call.
  function pasteHTML(editor: Editor, html: string): void {
    editor.view.pasteHTML(html, {} as unknown as ClipboardEvent);
  }

  function pasteText(editor: Editor, text: string): void {
    editor.view.pasteText(text, {} as unknown as ClipboardEvent);
  }

  it('gives a block pasted from a foreign site a fresh id, strips its formatting, and lands it as action', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'scene_heading', id: originalId, text: 'INT. HOUSE - DAY' },
    ]);
    selectBeforeFirstBlock(editor);

    // Representative of the `lipsum.com` paste from the bug report: a foreign paragraph with
    // inline formatting this schema has no mark for.
    pasteHTML(editor, '<p><strong>Lorem ipsum</strong> dolor sit amet.</p>');

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    expect(projection.screenplay.blocks).toHaveLength(2);
    // No residual markup and no unsupported-node rejection: the <strong> wrapper is dropped
    // (this schema defines no marks at all) while its text survives, landing as a plain `action`
    // block with a real id rather than the `null` id that used to make this "invalid screenplay
    // block".
    expect(projection.screenplay.blocks[0]).toMatchObject({
      text: 'Lorem ipsum dolor sit amet.',
      type: 'action',
    });
    expect(projection.screenplay.blocks[0]?.id).not.toBe(originalId);
    expect(projection.screenplay.blocks[1]?.id).toBe(originalId);
    editor.destroy();
    mount.remove();
  });

  it('regenerates the id of a block pasted from this editor, even back into the document it was copied from, and keeps its element', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'scene_heading', id: originalId, text: 'INT. HOUSE - DAY' },
    ]);
    selectBeforeFirstBlock(editor);

    // The exact clipboard shape `ScreenplayBlockNode.renderHTML` produces for this same block --
    // the reported "Stable id ... must be globally unique" case, reproduced by pasting a block
    // back into the very document it was copied from.
    pasteHTML(
      editor,
      `<div data-screenplay-block data-screenplay-element="scene_heading" data-block-id="${originalId}">INT. HOUSE - DAY</div>`,
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    expect(projection.screenplay.blocks).toHaveLength(2);
    const ids = projection.screenplay.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The scene heading stays a scene heading -- only its identity is new, not its semantics.
    expect(projection.screenplay.blocks[0]).toMatchObject({
      text: 'INT. HOUSE - DAY',
      type: 'scene_heading',
    });
    expect(projection.screenplay.blocks[0]?.id).not.toBe(originalId);
    editor.destroy();
    mount.remove();
  });

  it('regenerates every id in a multi-block paste copied from this editor, none colliding with each other or the existing document', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'scene_heading', id: originalId, text: 'INT. HOUSE - DAY' },
    ]);
    selectBeforeFirstBlock(editor);

    pasteHTML(
      editor,
      [
        `<div data-screenplay-block data-screenplay-element="character" data-block-id="${originalId}">ADA</div>`,
        `<div data-screenplay-block data-screenplay-element="dialogue" data-block-id="${secondId}">Hello.</div>`,
      ].join(''),
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    expect(projection.screenplay.blocks).toHaveLength(3);
    const ids = projection.screenplay.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(projection.screenplay.blocks.map((block) => block.type)).toEqual([
      'character',
      'dialogue',
      'scene_heading',
    ]);
    editor.destroy();
    mount.remove();
  });

  /**
   * The other three "own blocks" tests above hand-author the pasted HTML directly, which is
   * deliberately how `ScreenplayBlockNode.parseHTML()`'s `div[data-screenplay-block]` rule is
   * matched -- but it is not quite what a genuine same-session copy produces: an actual Ctrl+C in
   * a live ProseMirror view runs `EditorView.serializeForClipboard`, which also stamps a
   * `data-pm-slice` attribute recording the exact openness of the copied selection, and
   * `parseFromClipboard` (`prosemirror-view`'s `clipboard.ts`) takes a different branch when that
   * attribute is present. This test drives that real branch: it builds a `Slice` from an actual
   * cross-block `TextSelection` (spanning from inside one block into the next, the drag-select
   * that reproduces the owner's "copying from our own page" report -- copying a single block's
   * content in isolation is always fully open at both ends and merges as inline text, which is
   * exactly the mid-block case covered separately below), serializes it with the same method a
   * real copy uses, and pastes the resulting HTML back with `pasteHTML`.
   *
   * The exact shape of the merge at the paste point is ProseMirror's own default fitting
   * behaviour for an open slice edge (unchanged, and out of this scope's remit -- see
   * `regeneratePastedIds`'s doc comment), so this only asserts the property this slice actually
   * guards: the ids already in the document and every id the paste introduces are pairwise
   * distinct, and every text-carrying block. `index.ts`'s duplicate-id defect fails
   * exactly this assertion without `ScreenplayPasteSanitizer` in place.
   */
  it('regenerates ids for a real cross-block clipboard round trip, with no duplicate surviving the paste', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'character', id: originalId, text: 'ADA' },
      { element: 'dialogue', id: secondId, text: 'Hello there.' },
    ]);
    const doc = editor.state.doc;
    // From inside the first block's text through into the second block's text -- a genuine
    // cross-block drag-select, not a whole-document or single-block selection.
    const selection = TextSelection.create(doc, 2, doc.content.size - 1);
    const { dom } = editor.view.serializeForClipboard(selection.content());
    expect(dom.innerHTML).toContain('data-pm-slice');

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, editor.state.doc.content.size - 1),
      ),
    );
    pasteHTML(editor, dom.innerHTML);

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    const ids = projection.screenplay.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    editor.destroy();
    mount.remove();
  });

  /**
   * The split case, which no other test in this file reaches: every paste above lands at a block
   * boundary (`selectBeforeFirstBlock`, or the end of the document), where ProseMirror inserts
   * siblings and nothing is divided. A caret at offset 0 *inside* a block with text in it divides
   * that block instead, and `replace` gives both halves the original node's attrs -- its `id`
   * among them. Neither half came from the clipboard, so `regeneratePastedIds` cannot see it; the
   * duplicate is made by the paste, not carried in by it.
   *
   * This is the literal failure the whole paste scope exists to close ("Stable id ... must be
   * globally unique within a screenplay", and saving stops), reached by an ordinary action: caret
   * at the start of a line, paste two lines copied from the manuscript.
   */
  it('regenerates the id of a block split in two by a paste dropped inside it', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'INT. HOUSE - DAY' },
      { element: 'action', id: secondId, text: 'MARA enters the room.' },
    ]);
    // Offset 0 of the first block's own text -- inside the block, not at the boundary before it.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));

    pasteHTML(
      editor,
      [
        `<div data-screenplay-block data-screenplay-element="action" data-block-id="${originalId}" data-pm-slice="0 0 []">INT. HOUSE - DAY</div>`,
        `<div data-screenplay-block data-screenplay-element="action" data-block-id="${secondId}">MARA enters the room.</div>`,
      ].join(''),
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    const ids = projection.screenplay.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The writer's text is untouched by the sweep -- only identity is reissued.
    expect(
      projection.screenplay.blocks.map((block) => ('text' in block ? block.text : '')),
    ).toEqual([
      '',
      'INT. HOUSE - DAY',
      'MARA enters the room.',
      'INT. HOUSE - DAY',
      'MARA enters the room.',
    ]);
    editor.destroy();
    mount.remove();
  });

  /**
   * `progress/paste-split-block-identity.md`, and the defect the owner found in real use: he cut a
   * line from the bottom of a page and pasted it at the top, and the revision diff reported the
   * line that had merely been *pushed down one position* as removed and re-added. Nothing about
   * that line had changed; its id had moved off it.
   *
   * The tests from here to the end of this describe pin the whole rule, which is one sentence -- a
   * block id belongs to the text it was issued for and follows that text wherever the paste moves
   * it. They are deliberately every paste shape the rule has to answer differently, not only the
   * one that was reported: the bare caret at a line's start and at its end, a selection over a
   * line's first character, a selection over a whole line, a selection spanning two lines, a
   * single-block paste, a copy rather than a cut, and the real clipboard shape. The rule is only
   * right if it answers all of them, and several of them exist to catch the plausible *wrong*
   * fixes rather than the original defect -- a rule that always handed the id to the second block
   * would pass the first test here and corrupt the third.
   *
   * The duplicate-id guard tested above is a related but distinct property with a different cause
   * (`replace` copying one block's attrs onto two nodes), and it is still asserted where it
   * belongs. Restoring the old document-order tie-break leaves every test above this comment green
   * and fails five below it, which is why they are kept apart. See `reconcileBlockIds`'s own
   * comment for why the owner's case never produced a duplicate at all.
   */
  it("keeps a line's id with that line's own text when a multi-block paste lands at its start", () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'SECOND LINE' },
    ]);
    // Offset 0 of the first line's own text: the caret position a writer is at after pressing
    // Home, and where pasting a cut line puts it above the line they were on.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));

    pasteHTML(
      editor,
      [
        `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedFirstId}">CUT ONE</div>`,
        `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedSecondId}">CUT TWO</div>`,
      ].join(''),
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    const blocks = projection.screenplay.blocks.map((block) => ({
      id: block.id,
      text: 'text' in block ? block.text : '',
    }));
    // ProseMirror merges the open slice's first block into the target block and the target block's
    // own text into the slice's last block; the structure here is its doing, not this slice's.
    expect(blocks.map((block) => block.text)).toEqual([
      'CUT ONE',
      'CUT TWOFIRST LINE',
      'SECOND LINE',
    ]);
    // The writer's line keeps its identity even though it moved down a position and gained pasted
    // text at its front. This is the assertion the defect failed.
    expect(blocks[1]?.id).toBe(originalId);
    // And the block now holding only pasted text does not get to keep it, nor does it keep the id
    // the clipboard carried.
    expect(blocks[0]?.id).not.toBe(originalId);
    expect(blocks[0]?.id).not.toBe(pastedFirstId);
    expect(blocks[0]?.id).not.toBe(pastedSecondId);
    expect(blocks[2]?.id).toBe(secondId);
    editor.destroy();
    mount.remove();
  });

  /**
   * The same paste, through the clipboard shape a genuine cut actually produces rather than
   * hand-authored HTML -- the gap between the test above and the owner's real action. Selecting a
   * line includes its trailing line break, so `serializeForClipboard` records `openStart` 1,
   * `openEnd` 1 over two children (the second one empty) in `data-pm-slice`, and `parseFromClipboard`
   * takes its own branch for that. It is the openness that causes the defect: a *closed* slice
   * splits the target block and makes a duplicate, which the sweep above catches, while an open one
   * quietly moves the writer's text into a pasted node and makes no duplicate at all.
   */
  it("keeps a line's id with its text for the clipboard shape a real one-line cut produces", () => {
    const source = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'CUT ONE' },
      { element: 'action', id: thirdId, text: 'LAST LINE' },
    ]);
    // From the start of "CUT ONE" to the start of "LAST LINE" -- the whole line and its break,
    // which is what selecting a line and cutting it puts on the clipboard.
    const cutStart = 13;
    const { dom } = source.editor.view.serializeForClipboard(
      TextSelection.create(
        source.editor.state.doc,
        cutStart,
        cutStart + 'CUT ONE'.length + 2,
      ).content(),
    );
    const cutHTML = dom.innerHTML;
    expect(cutHTML).toContain('data-pm-slice="1 1 []"');
    source.editor.destroy();
    source.mount.remove();

    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'SECOND LINE' },
    ]);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));

    pasteHTML(editor, cutHTML);

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    const blocks = projection.screenplay.blocks.map((block) => ({
      id: block.id,
      text: 'text' in block ? block.text : '',
    }));
    expect(blocks.map((block) => block.text)).toEqual(['CUT ONE', 'FIRST LINE', 'SECOND LINE']);
    expect(blocks[1]?.id).toBe(originalId);
    // The relocated line is genuinely a new block, and a revision diff reporting it as removed and
    // added is correct: the editor cannot tell a cut from a copy at paste time, so a pasted line
    // must always be given a fresh id (see `reconcileBlockIds`). What must not happen -- and is
    // what this test exists for -- is the *other* line losing its identity to it.
    expect(blocks[0]?.id).not.toBe(originalId);
    expect(blocks[0]?.id).not.toBe(secondId);
    editor.destroy();
    mount.remove();
  });

  /**
   * The mirror image, and the case that rules out "give the id to the second half" as a fix: the
   * same two-block paste at the *end* of a line leaves all of the writer's text in the first block,
   * so that is where its id must stay. A tail-preferring rule would hand this line's id to a block
   * holding nothing but pasted text -- the identical defect, just at the other end of the line.
   */
  it("keeps a line's id with its text when the same paste lands at the end of the line instead", () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'SECOND LINE' },
    ]);
    // Offset 10 -- immediately after the last character of "FIRST LINE".
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 11)));

    pasteHTML(
      editor,
      [
        `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedFirstId}">CUT ONE</div>`,
        `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedSecondId}">CUT TWO</div>`,
      ].join(''),
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    const blocks = projection.screenplay.blocks.map((block) => ({
      id: block.id,
      text: 'text' in block ? block.text : '',
    }));
    expect(blocks.map((block) => block.text)).toEqual([
      'FIRST LINECUT ONE',
      'CUT TWO',
      'SECOND LINE',
    ]);
    expect(blocks[0]?.id).toBe(originalId);
    expect(blocks[1]?.id).not.toBe(originalId);
    editor.destroy();
    mount.remove();
  });

  /**
   * The one case with no right answer, recorded as such. A paste into the middle of a line divides
   * the writer's text between two blocks, and neither half is the line they typed -- so document
   * order decides, which is what the whole pass used to do unconditionally. The point of pinning it
   * is that the fallback is deliberate and narrow: it applies where the content was genuinely
   * divided, and nowhere else.
   */
  it('falls back to document order only when a paste divides a line between two blocks', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'SECOND LINE' },
    ]);
    // Offset 5, between "FIRST" and " LINE".
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)));

    pasteHTML(
      editor,
      [
        `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedFirstId}">CUT ONE</div>`,
        `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedSecondId}">CUT TWO</div>`,
      ].join(''),
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    const blocks = projection.screenplay.blocks.map((block) => ({
      id: block.id,
      text: 'text' in block ? block.text : '',
    }));
    expect(blocks.map((block) => block.text)).toEqual([
      'FIRSTCUT ONE',
      'CUT TWO LINE',
      'SECOND LINE',
    ]);
    expect(blocks[0]?.id).toBe(originalId);
    const ids = blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    editor.destroy();
    mount.remove();
  });

  /**
   * A single-block paste at the start of a line merges into that line outright -- no second block,
   * no split, nothing for identity to follow anywhere. Worth pinning because it is the case the
   * fix must leave completely alone: the line gains text at its front and keeps its id, which is
   * what typing at the start of a line does too.
   */
  it('merges a single-block paste at the start of a line into that line, id unchanged', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'SECOND LINE' },
    ]);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));

    pasteHTML(
      editor,
      `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedFirstId}">CUT ONE</div>`,
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    expect(projection.screenplay.blocks).toHaveLength(2);
    expect(projection.screenplay.blocks[0]).toMatchObject({
      id: originalId,
      text: 'CUT ONEFIRST LINE',
    });
    expect(projection.screenplay.blocks[1]?.id).toBe(secondId);
    editor.destroy();
    mount.remove();
  });

  /**
   * The constraint the fix must not break, stated as its own test: the editor cannot tell a cut
   * from a copy at paste time, so a *copied* line pasted at the start of another line must leave
   * the line it was copied from holding its own id, and must not take that id for itself. The
   * projection is asserted valid as well as id-unique, which is the check that actually matters in
   * production -- a duplicate makes `screenplayIdSchema` reject the document and the status bar
   * read "Not saving".
   */
  it('still mints a fresh id for a copied line pasted at the start of another, leaving the original where it was', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'COPY ME' },
      { element: 'action', id: thirdId, text: 'LAST LINE' },
    ]);
    // Copied, not cut: the source line stays in the document, so an id-preserving paste would
    // leave two blocks claiming `secondId`.
    const copyStart = 13;
    const { dom } = editor.view.serializeForClipboard(
      TextSelection.create(editor.state.doc, copyStart, copyStart + 'COPY ME'.length + 2).content(),
    );
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));

    pasteHTML(editor, dom.innerHTML);

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    const blocks = projection.screenplay.blocks.map((block) => ({
      id: block.id,
      text: 'text' in block ? block.text : '',
    }));
    expect(blocks.map((block) => block.text)).toEqual([
      'COPY ME',
      'FIRST LINE',
      'COPY ME',
      'LAST LINE',
    ]);
    const ids = blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every line that was already in the document keeps the id it had.
    expect(blocks[1]?.id).toBe(originalId);
    expect(blocks[2]?.id).toBe(secondId);
    expect(blocks[3]?.id).toBe(thirdId);
    // The pasted copy is a new block, with an id belonging to neither the clipboard nor any line
    // already here.
    expect(ids).not.toContain(pastedFirstId);
    editor.destroy();
    mount.remove();
  });

  /**
   * Identity follows the content that *survived*, which is not the same as following the block's
   * outermost content boundaries -- and this is the case that proves the difference. A paste over
   * the first character of a line has deleted that line's first character; a line is not a
   * different line for having lost its first letter. Reading the outermost boundary here would see
   * a deleted first character, give up, and leave the id where document order put it: on the block
   * holding nothing but pasted text. Which is the original defect, reached by a selection instead
   * of a bare caret.
   */
  it("keeps a line's id with its text when the paste replaces the line's first character", () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'SECOND LINE' },
    ]);
    // Just the "F": offsets 0 to 1 of the first line's text.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 2)),
    );

    pasteHTML(
      editor,
      [
        `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedFirstId}" data-pm-slice="1 1 []">CUT ONE</div>`,
        `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedSecondId}"></div>`,
      ].join(''),
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    const blocks = projection.screenplay.blocks.map((block) => ({
      id: block.id,
      text: 'text' in block ? block.text : '',
    }));
    expect(blocks.map((block) => block.text)).toEqual(['CUT ONE', 'IRST LINE', 'SECOND LINE']);
    expect(blocks[1]?.id).toBe(originalId);
    expect(blocks[0]?.id).not.toBe(originalId);
    expect(blocks[2]?.id).toBe(secondId);
    editor.destroy();
    mount.remove();
  });

  /**
   * The other direction, and the reason a block with *no* surviving content is given no heir at
   * all. A paste over a range running from the start of one line into the next replaces the first
   * line entirely and merges what is left into one block. The first line's content went nowhere --
   * but both of its content boundaries still map to the junction its removal left behind, which is
   * inside that surviving block. Treating that as "its content was carried there whole" would
   * stamp a deleted line's id onto the second line's text, and it would win the tie because it
   * comes first in the document. The surviving line keeps its own id instead, which is the whole
   * claim of this slice applied across a merge rather than a split.
   */
  it('gives a block no heir when none of its content survived, so the surviving line keeps its own id', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'SECOND LINE' },
    ]);
    // From the start of the first line's text through to the start of the second line's: the whole
    // of the first line, and the break after it.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 13)),
    );

    pasteHTML(
      editor,
      `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedFirstId}">PASTED</div>`,
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    expect(projection.screenplay.blocks).toHaveLength(1);
    expect(projection.screenplay.blocks[0]).toMatchObject({
      id: secondId,
      text: 'PASTEDSECOND LINE',
    });
    editor.destroy();
    mount.remove();
  });

  /**
   * Two lines can both have content in the one block a paste leaves behind -- a selection running
   * from the middle of one line into the next merges them -- and then two pre-paste ids have an
   * equally good claim on it. The earlier line in the document wins, which is also the id
   * ProseMirror's own join already left on that node, so the common case costs nothing and the
   * other id retires with the line that stopped existing. The alternative, letting the later
   * claimant overwrite, would rename a line the writer only edited the end of.
   */
  it('gives a block merged out of two lines the earlier line’s id, and retires the other', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'SECOND LINE' },
    ]);
    // From offset 5 of the first line ("FIRST| LINE") through to the start of the second line's
    // text: the end of one line, the break, and nothing of the other.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6, 13)),
    );

    pasteHTML(
      editor,
      `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedFirstId}">PASTED</div>`,
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    expect(projection.screenplay.blocks).toHaveLength(1);
    expect(projection.screenplay.blocks[0]).toMatchObject({
      id: originalId,
      text: 'FIRSTPASTEDSECOND LINE',
    });
    editor.destroy();
    mount.remove();
  });

  /**
   * A block already in the document with no id at all is not hypothetical: `addAttributes()`
   * defaults `id` to `null`, and both defects this extension exists to close produced exactly that
   * -- foreign HTML parsed through ProseMirror\u2019s default wrapping, and `@tiptap/core`\u2019s Enter
   * fallback inserting a block with none of this node\u2019s attribute defaults overridden
   * (`progress/enter-duplicate-ids.md`). `mapBlock` requires a string id, so such a document does
   * not save at all. The next paste anywhere in it repairs the block rather than stepping around
   * it, and does not mistake the absent id for something another block could inherit.
   */
  it('gives a real id to a block that was already in the document without one', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'FIRST LINE' },
      { element: 'action', id: secondId, text: 'SECOND LINE' },
    ]);
    const unidentified = findScreenplayBlockPosition(editor, secondId);
    if (unidentified === undefined) throw new Error('expected the seeded second block');
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(unidentified, undefined, { element: 'action', id: null }),
    );
    expect(projectDocumentScreenplay(editor.state.doc).valid).toBe(false);

    // A paste that lands nowhere near the damaged block.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));
    pasteHTML(
      editor,
      `<div data-screenplay-block data-screenplay-element="action" data-block-id="${pastedFirstId}">CUT ONE</div>`,
    );

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    const blocks = projection.screenplay.blocks.map((block) => ({
      id: block.id,
      text: 'text' in block ? block.text : '',
    }));
    expect(blocks.map((block) => block.text)).toEqual(['CUT ONEFIRST LINE', 'SECOND LINE']);
    expect(blocks[0]?.id).toBe(originalId);
    expect(blocks[1]?.id).toEqual(expect.any(String));
    expect(blocks[1]?.id).not.toBe(originalId);
    editor.destroy();
    mount.remove();
  });

  it('splits pasted multi-line plain text into separate action blocks, each with its own valid id', () => {
    const { editor, mount } = buildPasteEditor([{ element: 'action', id: originalId, text: '' }]);
    selectBeforeFirstBlock(editor);

    pasteText(editor, 'First line\nSecond line\nThird line');

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    const texts = projection.screenplay.blocks.map((block) => ('text' in block ? block.text : ''));
    // The original (empty) block survives as a fourth, trailing block -- the paste was inserted
    // before it, at the document boundary `selectBeforeFirstBlock` leaves the cursor at, not in
    // place of it.
    expect(texts).toEqual(['First line', 'Second line', 'Third line', '']);
    expect(projection.screenplay.blocks.every((block) => block.type === 'action')).toBe(true);
    const ids = projection.screenplay.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    editor.destroy();
    mount.remove();
  });

  it('leaves the document alone when the clipboard has nothing in it', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'Existing text.' },
    ]);
    selectBeforeFirstBlock(editor);

    pasteText(editor, '');

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    expect(projection.screenplay.blocks).toHaveLength(1);
    expect(projection.screenplay.blocks[0]).toMatchObject({
      id: originalId,
      text: 'Existing text.',
    });
    editor.destroy();
    mount.remove();
  });

  /**
   * A paste that lands *inside* an existing block, rather than at a block boundary, is not given
   * any special handling by `ScreenplayPasteSanitizer` -- and this test is the record of that
   * being a deliberate choice, not an oversight (see that extension's own doc comment). Pasting
   * plain inline text mid-block never produces a `screenplayBlock` node in the slice at all --
   * ProseMirror opens the slice to merge it into the surrounding block -- so there is no id to
   * regenerate and the block keeps the one it already had.
   */
  it('merges a mid-block paste into the surrounding text without creating a new block or a new id', () => {
    const { editor, mount } = buildPasteEditor([
      { element: 'action', id: originalId, text: 'INT. HOUSE - DAY' },
    ]);
    // Position 5 is inside the block's text, between "INT." and " HOUSE - DAY".
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 5)));

    pasteText(editor, 'REALLY BIG');

    const projection = projectDocumentScreenplay(editor.state.doc);
    expect(projection.valid).toBe(true);
    if (!projection.valid) return;
    expect(projection.screenplay.blocks).toHaveLength(1);
    expect(projection.screenplay.blocks[0]).toMatchObject({
      id: originalId,
      text: 'INT.REALLY BIG HOUSE - DAY',
    });
    editor.destroy();
    mount.remove();
  });
});

/**
 * `displayElement` turns a canonical element name into the label a writer reads -- in the toolbar's
 * element selector, in the element menu, and in the status bar. The canonical names are the wire
 * format (`scene_heading`) and must never change; what this function produces is presentation only,
 * which is exactly why it is worth pinning: a change here is invisible to every schema test and
 * every projection test, and would surface only as wrong words on screen.
 */
describe('displayElement', () => {
  it('turns each canonical element name into its title-cased label', () => {
    const labels = (
      [
        'scene_heading',
        'action',
        'character',
        'dialogue',
        'parenthetical',
        'transition',
        'shot',
      ] as const satisfies readonly ScreenplayElementType[]
    ).map((element) => displayElement(element));

    expect(labels).toEqual([
      'Scene Heading',
      'Action',
      'Character',
      'Dialogue',
      'Parenthetical',
      'Transition',
      'Shot',
    ]);
  });

  it('title-cases every underscore-separated word, not just the first', () => {
    // The whole reason this is not a single `[0].toUpperCase()`: `scene_heading` is the one
    // multi-word element today, and a regression that dropped the split would still produce a
    // plausible-looking "Scene_heading" rather than an obvious failure.
    expect(displayElement('scene_heading')).toBe('Scene Heading');
    expect(displayElement('scene_heading')).not.toContain('_');
  });
});

describe('no active block', () => {
  it('getActiveScreenplayBlock and convertActiveScreenplayBlock report no active block at the document boundary', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'Some action.' }]);
    selectAtDocumentBoundary(editor);

    expect(getActiveScreenplayBlock(editor)).toBeUndefined();
    expect(convertActiveScreenplayBlock(editor, 'character')).toBe(false);
    // A declined conversion must not have touched the document.
    expect(blocksOf(editor)).toEqual([{ element: 'action', text: 'Some action.' }]);

    editor.destroy();
    mount.remove();
  });

  it('Tab and Space decline to act at the document boundary, leaving the document untouched', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'Some action.' }]);
    selectAtDocumentBoundary(editor);

    expect(pressKey(editor, 'Tab')).toBe(false);
    expect(pressKey(editor, ' ')).toBe(false);
    expect(blocksOf(editor)).toEqual([{ element: 'action', text: 'Some action.' }]);

    editor.destroy();
    mount.remove();
  });

  /**
   * Enter does not join Tab and Space above in merely declining: `@tiptap/core` registers its own
   * built-in `Enter` fallback (`handleEnter` -- `createParagraphNear` / `liftEmptyBlock` /
   * `splitBlock`, bundled unconditionally with every `Editor` regardless of `extensions`), and it
   * runs whenever this extension's own `Enter` entry returns `false`. At this exact position --
   * `getActiveBlock`'s depth-walk finds no `screenplayBlock` ancestor, so `$from.parent` is the
   * `screenplayDocument` node itself -- Tiptap's `createParagraphNear` finds no inline content at
   * either edge of the selection and inserts a brand-new `screenplayBlock` via `type.createAndFill()`,
   * which fills every attribute from its schema default rather than from anything this editor
   * chose. `id`'s default is `null` (`ScreenplayBlockNode.addAttributes()`), so the inserted block
   * has no id at all: `mapBlock` requires a string id and returns `undefined` for one that has none,
   * which makes the whole canonical projection invalid and the document silently stops persisting
   * -- confirmed by reverting the `Enter` entry's document-boundary branch to `return false` and
   * watching this test fail with exactly that inserted null-id block. `progress/enter-duplicate-ids.md`
   * has the full mechanism and the fix (`ScreenplayBlockNode`'s `Enter` entry now returns `true`
   * unconditionally here, claiming the key and dispatching nothing, so Tiptap's fallback is never
   * reached).
   */
  it('claims Enter at the document boundary, leaving the document untouched rather than inserting a null-id block', () => {
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'Some action.' },
      { element: 'action', text: 'More action.' },
    ]);
    selectAtDocumentBoundary(editor);

    const handled = pressKey(editor, 'Enter');

    expect(handled).toBe(true);
    // No block inserted, no existing block touched -- same "document untouched" outcome Tab and
    // Space already have at this position.
    expect(blocksOf(editor)).toEqual([
      { element: 'action', text: 'Some action.' },
      { element: 'action', text: 'More action.' },
    ]);
    const ids = idsOf(editor);
    expect(ids).toEqual(['block-0', 'block-1']);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);

    editor.destroy();
    mount.remove();
  });
});

/**
 * The other side of `nonEmptyEditorContent` (`index.test.ts`): that helper exists precisely
 * because a genuinely empty document -- `content: []`, no blocks at all -- is a real state a
 * caller can hand this editor, and `Enter`'s own keymap entry has to cope with one directly, not
 * only through a caller that pre-seeds a block. This is the one case none of the `Enter` tests
 * above reach, since `buildEditor` always seeds at least one block.
 */
describe('Enter on a completely empty document', () => {
  it('inserts a single empty action block and places the caret inside it', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      element: mount,
      ...editorInitFor({ type: 'screenplayDocument', content: [] }),
    });
    expect(editor.state.doc.childCount).toBe(0);

    const handled = pressKey(editor, 'Enter');

    expect(handled).toBe(true);
    expect(blocksOf(editor)).toEqual([{ element: 'action', text: '' }]);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(1);

    editor.destroy();
    mount.remove();
  });
});

/**
 * `splitScreenplayBlock`'s cross-block case: a selection that starts inside one block and extends
 * into a later one used to make the function's bounds guard decline (`return false`), and driving
 * that through the real keymap (`someProp('handleKeyDown')`, as every other test in this file does)
 * did not leave the document alone the way "declining" would suggest -- this extension's own
 * `Enter` entry returned `false` too, and ProseMirror's dispatch fell through to `@tiptap/core`'s
 * own built-in `Enter` keymap (`handleEnter` -- `createParagraphNear` / `liftEmptyBlock` /
 * `splitBlock`, bundled unconditionally with every `Editor`), which deleted the selected range
 * across both blocks and then split the merged remainder with `tr.split`'s default of copying the
 * original node's full `attrs` -- `id` included -- onto both resulting halves. Two `screenplayBlock`
 * nodes would come out sharing one stable id: the exact "Stable id ... must be globally unique"
 * failure `ScreenplayPasteSanitizer` exists to prevent for paste and drop, reached here by an
 * ordinary cross-block Enter with neither -- so `ScreenplayPasteSanitizer`'s own `appendTransaction`
 * guard, gated on a `paste`/`drop` `uiEvent` meta, never saw it and never repaired it.
 * `progress/enter-duplicate-ids.md` has the full mechanism.
 *
 * `splitScreenplayBlock` now handles this shape directly instead of declining it (see its own
 * comment), so this test drives the same real keymap path and asserts the fix: every resulting
 * block has a distinct, non-null, string id, the block spanned by the selection's start keeps its
 * own id and element, and the new block created from the tail gets a freshly minted one.
 */
describe('Enter across a selection spanning two blocks', () => {
  it("splits at the selection boundary without duplicating either block's id", () => {
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'ABCDE' },
      { element: 'action', text: 'FGHIJ' },
    ]);
    const firstPosition = findScreenplayBlockPosition(editor, 'block-0');
    const secondPosition = findScreenplayBlockPosition(editor, 'block-1');
    if (firstPosition === undefined || secondPosition === undefined) {
      throw new Error('expected both seeded blocks to be present');
    }
    // From offset 2 of the first block ("AB|CDE") to offset 3 of the second ("FGH|IJ") -- the
    // caret starts inside `block-0` and the selection reaches past its end into `block-1`, the
    // exact shape `splitScreenplayBlock`'s bounds guard used to decline.
    const selection = TextSelection.create(
      editor.state.doc,
      firstPosition + 1 + 2,
      secondPosition + 1 + 3,
    );
    editor.view.dispatch(editor.state.tr.setSelection(selection));

    const handled = pressKey(editor, 'Enter');

    expect(handled).toBe(true);
    // The prefix before the selection stays with `block-0`'s own id and element; the suffix after
    // it becomes a new block. `block-1` itself -- entirely inside the replaced range -- is gone.
    expect(blocksOf(editor)).toEqual([
      { element: 'action', text: 'AB' },
      { element: 'action', text: 'IJ' },
    ]);
    const ids = idsOf(editor);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('block-0');
    expect(ids[1]).not.toBe('block-0');
    expect(ids[1]).not.toBe('block-1');

    editor.destroy();
    mount.remove();
  });
});

/**
 * The Tab keymap entry's own element-specific branches. `'parentheticals own their parentheses'`
 * above already reaches the `dialogue` -> `parenthetical` branch through this same real keymap;
 * these two cover the `action` -> `character` branch and the "nothing to convert" fallback for
 * every other element, which no test above reaches through the keymap itself (only through
 * `convertActiveScreenplayBlock` called directly).
 */
describe('Tab', () => {
  it('converts an action block to character', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'Some action.' }]);
    setSelectionInFirstBlock(editor, 0);

    const handled = pressKey(editor, 'Tab');

    expect(handled).toBe(true);
    expect(blocksOf(editor)).toEqual([{ element: 'character', text: 'Some action.' }]);
    editor.destroy();
    mount.remove();
  });

  it('does nothing for an element Tab has no conversion for', () => {
    const { editor, mount } = buildEditor([{ element: 'scene_heading', text: 'INT. ROOM - DAY' }]);
    setSelectionInFirstBlock(editor, 0);

    const handled = pressKey(editor, 'Tab');

    expect(handled).toBe(false);
    expect(blocksOf(editor)).toEqual([{ element: 'scene_heading', text: 'INT. ROOM - DAY' }]);
    editor.destroy();
    mount.remove();
  });
});

describe('projectEditorScreenplay / projectLocalScreenplay', () => {
  it('projects straight from an Editor, matching projectDocumentScreenplay(editor.state.doc, options) exactly', () => {
    const sceneHeadingId = '00000000-0000-4000-8000-000000000305';
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      element: mount,
      ...editorInitFor({
        type: 'screenplayDocument',
        content: [
          {
            type: 'screenplayBlock',
            attrs: { element: 'scene_heading', id: sceneHeadingId },
            content: [{ type: 'text', text: 'INT. STUDY - DAY' }],
          },
        ],
      }),
    });

    const viaEditor = projectEditorScreenplay(editor, { title: 'Editor Projection' });
    const viaLocalAlias = projectLocalScreenplay(editor, { title: 'Editor Projection' });
    const viaDoc = projectDocumentScreenplay(editor.state.doc, { title: 'Editor Projection' });

    // `projectLocalScreenplay` is documented as a plain alias, not a second implementation that
    // could quietly drift from the first.
    expect(projectLocalScreenplay).toBe(projectEditorScreenplay);
    expect(viaEditor).toEqual(viaDoc);
    expect(viaLocalAlias).toEqual(viaDoc);

    editor.destroy();
    mount.remove();
  });
});

/**
 * `editorContentFromScreenplay`'s own contract, one level below the full canonical<->editor
 * round-trip identity `canonicalRoundTrip.test.ts` (`apps/web`) already proves in depth: what this
 * adds is direct coverage of the function itself, in this package, rather than only through the
 * `apps/web` re-export shim every one of that file's 84 tests still imports through.
 */
describe('editorContentFromScreenplay', () => {
  function validScreenplay(overrides: Partial<Screenplay> = {}): Screenplay {
    const result = safeParseScreenplay({
      annotations: [],
      blocks: [],
      documentSettings: DEFAULT_DOCUMENT_SETTINGS,
      id: '00000000-0000-4000-8000-000000000401',
      schemaVersion: SCREENPLAY_SCHEMA_VERSION,
      title: 'A Screenplay',
      titlePages: [],
      ...overrides,
    });
    if (!result.success) {
      throw new Error(`fixture itself is invalid: ${JSON.stringify(result.error.issues)}`);
    }
    return result.data;
  }

  it('maps title page, scene number, and block text through, omitting content for an empty block', () => {
    const titlePage = { id: '00000000-0000-4000-8000-000000000402', title: 'My Screenplay' };
    const screenplay = validScreenplay({
      titlePages: [titlePage],
      blocks: [
        {
          id: '00000000-0000-4000-8000-000000000403',
          type: 'scene_heading',
          text: 'INT. HOUSE - DAY',
          sceneNumber: '12A',
        },
        { id: '00000000-0000-4000-8000-000000000404', type: 'action', text: '' },
      ],
    });

    const result = editorContentFromScreenplay(screenplay);

    // `toEqual`, not `toBe`: `safeParseScreenplay` (zod) returns a freshly parsed object graph,
    // not the literal `titlePage` passed in above, so this checks the value survived unchanged,
    // not object identity that was never promised.
    expect(result.titlePage).toEqual(titlePage);
    expect(result.body).toEqual({
      type: 'screenplayDocument',
      content: [
        {
          type: 'screenplayBlock',
          attrs: {
            element: 'scene_heading',
            id: '00000000-0000-4000-8000-000000000403',
            sceneNumber: '12A',
          },
          content: [{ type: 'text', text: 'INT. HOUSE - DAY' }],
        },
        {
          type: 'screenplayBlock',
          attrs: { element: 'action', id: '00000000-0000-4000-8000-000000000404' },
        },
      ],
    });
  });

  it('returns titlePage: undefined for a screenplay with no title page, rather than throwing', () => {
    const screenplay = validScreenplay({ titlePages: [] });
    expect(editorContentFromScreenplay(screenplay).titlePage).toBeUndefined();
  });

  it('refuses a screenplay with more than one title page', () => {
    const screenplay = validScreenplay({
      titlePages: [
        { id: '00000000-0000-4000-8000-000000000405' },
        { id: '00000000-0000-4000-8000-000000000406' },
      ],
    });
    expect(() => editorContentFromScreenplay(screenplay)).toThrow(
      /not editable in the text-block editor/i,
    );
  });

  it('refuses a screenplay with any annotations', () => {
    const screenplay = validScreenplay({
      blocks: [{ id: '00000000-0000-4000-8000-000000000407', type: 'action', text: 'Beat.' }],
      annotations: [
        {
          id: '00000000-0000-4000-8000-000000000408',
          type: 'note',
          text: 'A note.',
          anchor: {
            blockId: '00000000-0000-4000-8000-000000000407',
            startOffset: 0,
            endOffset: 1,
          },
        },
      ],
    });
    expect(() => editorContentFromScreenplay(screenplay)).toThrow(
      /not editable in the text-block editor/i,
    );
  });

  it('refuses a screenplay containing a page_break block', () => {
    const screenplay = validScreenplay({
      blocks: [{ id: '00000000-0000-4000-8000-000000000409', type: 'page_break' }],
    });
    expect(() => editorContentFromScreenplay(screenplay)).toThrow(
      /not editable in the text-block editor/i,
    );
  });

  it('refuses a screenplay containing a dual_dialogue block', () => {
    const screenplay = validScreenplay({
      blocks: [
        {
          id: '00000000-0000-4000-8000-000000000410',
          type: 'dual_dialogue',
          left: {
            id: '00000000-0000-4000-8000-000000000411',
            blocks: [
              { id: '00000000-0000-4000-8000-000000000412', type: 'character', text: 'ADA' },
              { id: '00000000-0000-4000-8000-000000000413', type: 'dialogue', text: 'Hi.' },
            ],
          },
          right: {
            id: '00000000-0000-4000-8000-000000000414',
            blocks: [
              { id: '00000000-0000-4000-8000-000000000415', type: 'character', text: 'BEN' },
              { id: '00000000-0000-4000-8000-000000000416', type: 'dialogue', text: 'Hey.' },
            ],
          },
        },
      ],
    });
    expect(() => editorContentFromScreenplay(screenplay)).toThrow(
      /not editable in the text-block editor/i,
    );
  });
});

/**
 * `projectDocumentScreenplay`'s two distinct rejection paths: an editor node this function cannot
 * even map (`'invalid screenplay block'`/`'Unsupported local editor node'`, covered by the "paste
 * sanitisation" tests above indirectly and by `canonicalRoundTrip.test.ts` directly), and --
 * separately -- a document every node of which maps cleanly but whose *assembled* screenplay
 * `safeParseScreenplay` itself still rejects. A duplicate stable id is the only way to reach the
 * second path without going through the paste pipeline: `ScreenplayPasteSanitizer` only ever runs
 * on a paste or drop transaction, so a document authored with a repeated id from the start (never
 * pasted) reaches `safeParseScreenplay` with two clean blocks and fails there instead.
 */
describe('projectDocumentScreenplay: rejection from safeParseScreenplay itself', () => {
  it('reports the schema rejection, not a mapping failure, for a document whose blocks all map but collide on id', () => {
    const duplicateId = '00000000-0000-4000-8000-000000000417';
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      element: mount,
      ...editorInitFor({
        type: 'screenplayDocument',
        content: [
          {
            type: 'screenplayBlock',
            attrs: { element: 'action', id: duplicateId },
            content: [{ type: 'text', text: 'First.' }],
          },
          {
            type: 'screenplayBlock',
            attrs: { element: 'action', id: duplicateId },
            content: [{ type: 'text', text: 'Second.' }],
          },
        ],
      }),
    });

    const projection = projectDocumentScreenplay(editor.state.doc);

    expect(projection.valid).toBe(false);
    if (projection.valid) throw new Error('expected an invalid projection');
    expect(projection.issues.some((issue) => issue.includes('must be globally unique'))).toBe(true);

    editor.destroy();
    mount.remove();
  });
});

/**
 * `findScreenplayBlockPosition` has no other direct test anywhere in the repository -- every
 * caller (`seamCaret.ts`, `elementMenu.tsx`) exercises it only as one step inside a larger caret-
 * or menu-positioning behaviour, never asserts on the position it returns in isolation.
 */
describe('findScreenplayBlockPosition', () => {
  it('returns the position of the block with the given id, and undefined for an id not in the document', () => {
    const firstId = '00000000-0000-4000-8000-000000000501';
    const secondId = '00000000-0000-4000-8000-000000000502';
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      element: mount,
      ...editorInitFor({
        type: 'screenplayDocument',
        content: [
          {
            type: 'screenplayBlock',
            attrs: { element: 'action', id: firstId },
            content: [{ type: 'text', text: 'First.' }],
          },
          {
            type: 'screenplayBlock',
            attrs: { element: 'action', id: secondId },
            content: [{ type: 'text', text: 'Second.' }],
          },
        ],
      }),
    });

    expect(findScreenplayBlockPosition(editor, firstId)).toBe(0);
    // Position of the second block: the first block's own size (its opening/closing tokens plus
    // "First." as text) further along the document.
    expect(findScreenplayBlockPosition(editor, secondId)).toBe(editor.state.doc.child(0).nodeSize);
    expect(findScreenplayBlockPosition(editor, 'not-a-real-id')).toBeUndefined();

    editor.destroy();
    mount.remove();
  });
});

/**
 * A block id belongs to the text it was issued for, and a split must not hand it to the other half.
 * The companion to `paste sanitisation`'s `reconcileBlockIds` tests above: that pass is gated on the
 * `paste`/`drop` transactions and never sees an `Enter`, so the split path needs its own proof of
 * the same rule.
 *
 * Reported from real use. A writer put the caret at the start of a line and pressed Enter to make
 * room above it, then pasted a line cut from elsewhere. The revision diff reported the line that had
 * merely been pushed down as deleted and re-added, because the empty block the Enter created kept
 * the original id and the writer's own text was reissued a fresh one. plan.md's reason for stable
 * ids -- "comments, scene navigation, revision diffs, imports/exports, and future storyboard links
 * even when content is reordered" -- is exactly what that breaks.
 */
describe('split identity follows content, not position', () => {
  function idsAndText(editor: Editor): Array<{ id: unknown; text: string }> {
    const result: Array<{ id: unknown; text: string }> = [];
    editor.state.doc.forEach((node) => result.push({ id: node.attrs.id, text: node.textContent }));
    return result;
  }

  function idOfTextIn(editor: Editor, text: string): unknown {
    return idsAndText(editor).find((block) => block.text === text)?.id;
  }

  function everyIdUnique(editor: Editor): boolean {
    const ids = idsAndText(editor).map((block) => String(block.id));
    return new Set(ids).size === ids.length;
  }

  it('leaves a line its own id when Enter at its very start pushes it down', () => {
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'TOP LINE' },
      { element: 'action', text: 'SECOND LINE' },
    ]);
    const originalId = editor.state.doc.firstChild?.attrs.id;

    pressEnterAt(editor, 0);

    // The writer's text keeps the identity; the empty line they just created is what is new.
    expect(idOfTextIn(editor, 'TOP LINE')).toBe(originalId);
    expect(idOfTextIn(editor, '')).not.toBe(originalId);
    expect(everyIdUnique(editor)).toBe(true);
    editor.destroy();
    mount.remove();
  });

  it('leaves the id on the first half when Enter splits mid-text, which is unchanged', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'TOPLINE' }]);
    const originalId = editor.state.doc.firstChild?.attrs.id;

    pressEnterAt(editor, 3);

    // Here the first half genuinely is the original line continuing, and the second half is new
    // material -- the opposite of the case above, and the reason this is a content rule rather than
    // a blanket "the later half wins".
    expect(idOfTextIn(editor, 'TOP')).toBe(originalId);
    expect(idOfTextIn(editor, 'LINE')).not.toBe(originalId);
    expect(everyIdUnique(editor)).toBe(true);
    editor.destroy();
    mount.remove();
  });

  it('leaves the id on the text when Enter at the end opens a new line below', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'TOP LINE' }]);
    const originalId = editor.state.doc.firstChild?.attrs.id;

    pressEnterAt(editor, 'TOP LINE'.length);

    expect(idOfTextIn(editor, 'TOP LINE')).toBe(originalId);
    expect(idOfTextIn(editor, '')).not.toBe(originalId);
    expect(everyIdUnique(editor)).toBe(true);
    editor.destroy();
    mount.remove();
  });

  it('never moves one block id onto another block surviving text across a two-block selection', () => {
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'FIRST' },
      { element: 'action', text: 'SECOND' },
    ]);
    const firstId = editor.state.doc.firstChild?.attrs.id;

    // From the very start of the first block through the middle of the second: the prefix is empty,
    // which is the condition the start-of-line case keys on, but the surviving suffix belongs to a
    // *different* block. Moving the first block's id onto it would be a second identity bug.
    const selection = TextSelection.create(editor.state.doc, 1, editor.state.doc.content.size - 3);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.view.someProp('handleKeyDown', (handler) =>
      handler(editor.view, new KeyboardEvent('keydown', { key: 'Enter' })),
    );

    expect(idOfTextIn(editor, 'ND')).not.toBe(firstId);
    expect(everyIdUnique(editor)).toBe(true);
    editor.destroy();
    mount.remove();
  });
});

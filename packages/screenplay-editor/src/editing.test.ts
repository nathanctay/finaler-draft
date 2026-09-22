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

  /**
   * Tab and Space only, not Enter: `@tiptap/core` registers its own built-in `Enter` fallback
   * (`handleEnter`, bundled unconditionally with every `Editor` regardless of `extensions`) that
   * runs after this extension's own `Enter` entry declines, and it does not leave the document
   * alone the way this test's name would otherwise imply -- see `nonEmptyEditorContent`'s sibling
   * note below and this file's own report for why that combination is flagged, not asserted on,
   * here.
   */
  it('Tab and Space decline to act at the document boundary, leaving the document untouched', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'Some action.' }]);
    selectAtDocumentBoundary(editor);

    expect(pressKey(editor, 'Tab')).toBe(false);
    expect(pressKey(editor, ' ')).toBe(false);
    expect(blocksOf(editor)).toEqual([{ element: 'action', text: 'Some action.' }]);

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
 * NOT COVERED, DELIBERATELY: `splitScreenplayBlock`'s own bounds guard (`if (... selection.to >
 * blockContentEnd) return false`) is reachable -- press Enter with a selection that starts inside
 * one block and extends into the next -- and declining is exactly what this guard does. But
 * driving that through the real keymap (`someProp('handleKeyDown')`, as every other test in this
 * file does) does not leave the document alone the way "declining" would suggest: this extension's
 * own `Enter` entry returns `false`, and ProseMirror's dispatch then falls through to
 * `@tiptap/core`'s own built-in `Enter` keymap (`handleEnter` -- `createParagraphNear` /
 * `liftEmptyBlock` / `splitBlock`, bundled unconditionally with every `Editor`), which *does* act:
 * it deletes the selected range across both blocks and then splits the merged remainder, and
 * ProseMirror's generic `splitBlock` copies the original node's full `attrs` -- `id` included --
 * onto both resulting halves. The result, confirmed by direct inspection while writing this test,
 * is two `screenplayBlock` nodes sharing one stable id: the exact "Stable id ... must be globally
 * unique" failure `ScreenplayPasteSanitizer` exists to prevent, produced here by an ordinary
 * cross-block Enter with no paste or drop involved at all -- so `ScreenplayPasteSanitizer`'s own
 * `appendTransaction` guard, which only runs for a transaction carrying a `paste`/`drop` `uiEvent`
 * meta, never sees it and never repairs it.
 *
 * That is a real, separate defect from anything this coverage pass was scoped to fix, and asserting
 * on its output here -- either the duplicate id as "expected," or a document-unchanged shape that
 * is not actually what happens -- would misrepresent it as correct. Reported to the owner instead
 * of worked around; see this file's accompanying report. Coverage-wise, this leaves
 * `splitScreenplayBlock`'s bounds-guard body itself uncovered (its own `if (!activeBlock)` /
 * `if (!existingNode)` guards immediately above it are separately unreachable in practice: both
 * recompute a fact the `Enter` keymap entry already established before ever calling
 * `splitScreenplayBlock`, from the same unchanged editor state).
 */

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

import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { DEFAULT_DOCUMENT_SETTINGS } from '@finaler-draft/screenplay';
import {
  projectDocumentScreenplay,
  screenplayExtensions,
  type ScreenplayElementType,
} from './screenplayEditor.js';

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
    content: {
      type: 'screenplayDocument' as const,
      content: blocks.map((block, index) => ({
        type: 'screenplayBlock' as const,
        attrs: { element: block.element, id: `block-${index}` },
        ...(block.text === '' ? {} : { content: [{ type: 'text', text: block.text }] }),
      })),
    },
    element: mount,
    extensions: screenplayExtensions,
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
});

describe('projectDocumentScreenplay', () => {
  const sceneHeadingId = '00000000-0000-4000-8000-000000000301';

  function buildDocFor(text: string) {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: {
        type: 'screenplayDocument',
        content: [
          {
            type: 'screenplayBlock',
            attrs: { element: 'scene_heading', id: sceneHeadingId },
            content: [{ type: 'text', text }],
          },
        ],
      },
      element: mount,
      extensions: screenplayExtensions,
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

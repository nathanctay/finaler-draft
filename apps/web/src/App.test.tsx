import { fireEvent, render, screen, within } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import {
  findScreenplayBlockPosition,
  getActiveScreenplayBlock,
  initialScreenplayContent,
  isScreenplayElementType,
  projectLocalScreenplay,
  screenplayExtensions,
} from './screenplayEditor.js';

const firstActionId = 'ba53c2dc-10a6-46d7-a409-9aabbff7cf5d';
const firstSceneId = '2175a1b6-8d05-4e6e-bac7-e471e8df33a1';

function getBlock(canvas: HTMLElement, id: string): HTMLElement {
  const block = canvas.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
  if (!block) {
    throw new Error(`Missing screenplay block ${id}.`);
  }
  return block;
}

describe('local semantic screenplay editor', () => {
  it('derives Navigator scenes and keeps the local draft status accurate', async () => {
    const user = userEvent.setup();
    render(<App />);

    const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    expect(screen.getByText('1. INT. APARTMENT - MORNING')).toBeVisible();
    expect(screen.getByText('2. EXT. UNION STATION - CONTINUOUS')).toBeVisible();
    expect(screen.getByText(/validated locally/i)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /2\. EXT\. UNION STATION/i }));
    expect(screen.getByLabelText('Active scene')).toHaveTextContent(
      'EXT. UNION STATION - CONTINUOUS',
    );

    await user.click(screen.getByRole('button', { name: 'Close navigator' }));
    expect(screen.queryByRole('complementary', { name: 'Navigator' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Toggle navigator' }));
    expect(screen.getByRole('complementary', { name: 'Navigator' })).toBeVisible();
    expect(canvas).toBeVisible();
  });

  it('converts the active element through the selector without changing its stable id', async () => {
    const user = userEvent.setup();
    render(<App />);

    const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );

    expect(getBlock(canvas, firstSceneId)).toHaveAttribute('data-screenplay-element', 'shot');
    expect(screen.getByText('Active element')).toHaveTextContent('Active element');
    expect(within(screen.getByLabelText('Inspector')).getByText('Shot')).toBeVisible();
    expect(screen.queryByRole('button', { name: /1\. INT\. APARTMENT/i })).not.toBeInTheDocument();
    expect(screen.getByText('1 scenes · local draft')).toBeVisible();
    expect(screen.getByText(/validated locally/i)).toBeVisible();
  });

  it('uses selector conversion with local-only undo and redo', async () => {
    const user = userEvent.setup();
    render(<App />);

    const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'character',
    );
    expect(getBlock(canvas, firstSceneId)).toHaveAttribute('data-screenplay-element', 'character');

    await user.click(screen.getByRole('button', { name: 'Undo local change' }));
    expect(getBlock(canvas, firstSceneId)).toHaveAttribute(
      'data-screenplay-element',
      'scene_heading',
    );
    await user.click(screen.getByRole('button', { name: 'Redo local change' }));
    expect(getBlock(canvas, firstSceneId)).toHaveAttribute('data-screenplay-element', 'character');
  });

  it('dispatches keyboard transitions, splits selected text, and keeps ids unique', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: initialScreenplayContent,
      element: mount,
      extensions: screenplayExtensions,
    });
    const actionPosition = findScreenplayBlockPosition(editor, firstActionId);
    if (actionPosition === undefined) {
      throw new Error('Initial action block was not found.');
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, actionPosition + 4)),
    );
    editor.view.focus();
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    const firstAction = editor.state.doc.child(1);
    const splitAction = editor.state.doc.child(2);
    expect(firstAction.textContent).toBe('Sun');
    expect(splitAction.attrs.element).toBe('action');
    expect(splitAction.textContent).toMatch(/^light settles/u);

    const splitPosition = findScreenplayBlockPosition(editor, splitAction.attrs.id as string);
    if (splitPosition === undefined) {
      throw new Error('Split action block was not found.');
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, splitPosition + 1)),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Tab' });
    expect(editor.state.doc.child(2).attrs.element).toBe('character');

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, splitPosition + 2)),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    const ids = Array.from(
      { length: editor.state.doc.childCount },
      (_, index) => editor.state.doc.child(index).attrs.id as string,
    );
    expect(editor.state.doc.child(3).attrs.element).toBe('dialogue');
    expect(new Set(ids)).toHaveLength(ids.length);
    editor.destroy();
    mount.remove();
  });

  it('removes a non-collapsed selection during Enter splitting', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: initialScreenplayContent,
      element: mount,
      extensions: screenplayExtensions,
    });
    const actionPosition = findScreenplayBlockPosition(editor, firstActionId);
    if (actionPosition === undefined) {
      throw new Error('Initial action block was not found.');
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, actionPosition + 4, actionPosition + 9),
      ),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    expect(editor.state.doc.child(1).textContent).toBe('Sun');
    expect(editor.state.doc.child(2).textContent).toMatch(/^ settles across/u);
    editor.destroy();
    mount.remove();
  });

  it('validates an empty screenplay and starts it as an action block on Enter', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: { content: [], type: 'screenplayDocument' },
      element: mount,
      extensions: screenplayExtensions,
    });

    const emptyProjection = projectLocalScreenplay(editor);
    expect(emptyProjection).toMatchObject({ valid: true });
    if (!emptyProjection.valid) {
      throw new Error('The empty local screenplay should be valid.');
    }
    expect(emptyProjection.screenplay.blocks).toEqual([]);
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).attrs.element).toBe('action');
    expect(projectLocalScreenplay(editor)).toMatchObject({ valid: true });
    editor.destroy();
    mount.remove();
  });

  it('covers empty-boundary splits and refuses an operation without an active text block', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: initialScreenplayContent,
      element: mount,
      extensions: screenplayExtensions,
    });
    const actionPosition = findScreenplayBlockPosition(editor, firstActionId);
    if (actionPosition === undefined) {
      throw new Error('Initial action block was not found.');
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, actionPosition + 1)),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    expect(editor.state.doc.child(1).textContent).toBe('');

    const fullActionPosition = findScreenplayBlockPosition(
      editor,
      editor.state.doc.child(2).attrs.id as string,
    );
    if (fullActionPosition === undefined) {
      throw new Error('Split action block was not found.');
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(
          editor.state.doc,
          fullActionPosition + editor.state.doc.child(2).nodeSize - 1,
        ),
      ),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    expect(editor.state.doc.child(3).textContent).toBe('');

    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
    expect(getActiveScreenplayBlock(editor)).toBeUndefined();
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    fireEvent.keyDown(editor.view.dom, { key: 'Tab' });
    expect(editor.state.doc.childCount).toBe(9);
    editor.destroy();
    mount.remove();
  });

  it('surfaces unsupported and schema-invalid projections without dropping their nodes', () => {
    const unsupportedEditor = {
      state: {
        doc: {
          forEach: (visitor: (node: unknown) => void) =>
            visitor({ attrs: {}, textContent: '', type: { name: 'paragraph' } }),
        },
      },
    } as unknown as Editor;
    const invalidEditor = {
      state: {
        doc: {
          forEach: (visitor: (node: unknown) => void) => {
            visitor({
              attrs: { element: 'action', id: firstActionId },
              textContent: 'Repeated identity.',
              type: { name: 'screenplayBlock' },
            });
            visitor({
              attrs: { element: 'action', id: firstActionId },
              textContent: 'Repeated identity.',
              type: { name: 'screenplayBlock' },
            });
          },
        },
      },
    } as unknown as Editor;
    const malformedEditor = {
      state: {
        doc: {
          forEach: (visitor: (node: unknown) => void) => {
            visitor({
              attrs: { element: 'action', id: firstActionId },
              textContent: 'Repeated identity.',
              type: { name: 'screenplayBlock' },
            });
            visitor({
              attrs: { element: 'bogus', id: 3 },
              textContent: '',
              type: { name: 'screenplayBlock' },
            });
          },
        },
      },
    } as unknown as Editor;

    expect(isScreenplayElementType('action')).toBe(true);
    expect(isScreenplayElementType('bogus')).toBe(false);
    expect(projectLocalScreenplay(unsupportedEditor)).toMatchObject({
      issues: ['Unsupported local editor node: paragraph.'],
      valid: false,
    });
    expect(projectLocalScreenplay(invalidEditor)).toMatchObject({
      valid: false,
    });
    expect(projectLocalScreenplay(malformedEditor)).toMatchObject({
      issues: ['Unsupported local editor node: invalid screenplay block.'],
      valid: false,
    });
  });

  it('retains the working canvas while panels, theme, and zoom change', async () => {
    const user = userEvent.setup();
    render(<App />);

    const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    await user.click(screen.getByRole('button', { name: 'Close inspector' }));
    await user.click(screen.getByRole('button', { name: 'Dark canvas' }));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));

    expect(screen.getByRole('main')).toHaveClass('dark');
    expect(screen.getByLabelText('Zoom level')).toHaveTextContent('110%');
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).not.toBeInTheDocument();
    expect(canvas).toBeVisible();
  });
});

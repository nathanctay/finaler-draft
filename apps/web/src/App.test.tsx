import { fireEvent, render, screen, within } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { App } from './App.js';
import { ApiError, api, type PersistedScreenplay } from './api.js';
import {
  findScreenplayBlockPosition,
  getActiveScreenplayBlock,
  initialScreenplayContent,
  editorContentFromScreenplay,
  isScreenplayElementType,
  projectLocalScreenplay,
  screenplayExtensions,
} from './screenplayEditor.js';

const firstActionId = 'ba53c2dc-10a6-46d7-a409-9aabbff7cf5d';
const firstSceneId = '2175a1b6-8d05-4e6e-bac7-e471e8df33a1';
const transitionId = 'd01faf47-64e7-4f7c-853a-3c6ace1464ad';

function getBlock(canvas: HTMLElement, id: string): HTMLElement {
  const block = canvas.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
  if (!block) {
    throw new Error(`Missing screenplay block ${id}.`);
  }
  return block;
}

function persistedScreenplay(id: string, title: string, text: string): PersistedScreenplay {
  return {
    id,
    projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
    screenplay: {
      annotations: [],
      blocks: [
        {
          id: `${id.slice(0, 8)}-8d05-4e6e-bac7-e471e8df33a1`,
          type: 'scene_heading',
          text,
        },
      ],
      id,
      schemaVersion: 1,
      title,
      titlePages: [],
    },
    title,
    version: 1,
  };
}

describe('local semantic screenplay editor', () => {
  it('fails closed for canonical features the text-block editor cannot preserve', () => {
    expect(() => editorContentFromScreenplay(screenplayFixture)).toThrow(/not editable/i);
  });

  it('preserves local edits and visibly locks automatic saves after a conflict', async () => {
    const save = vi.spyOn(api, 'saveScreenplay').mockRejectedValue(new ApiError(409));
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );
    expect(await screen.findByText(/Save conflict/)).toBeVisible();
    expect(save).toHaveBeenCalledOnce();
    save.mockRestore();
  });

  it('reports saving and a retryable non-conflict failure without discarding the editor', async () => {
    const save = vi
      .spyOn(api, 'saveScreenplay')
      .mockImplementationOnce(
        () => new Promise(() => undefined) as ReturnType<typeof api.saveScreenplay>,
      );
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'action',
    );
    expect(await screen.findByText('Saving…')).toBeVisible();
    save.mockRestore();
  });

  it('renders unsupported persisted snapshots as read-only', async () => {
    render(
      <App
        initial={{
          id: screenplayFixture.id,
          projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
          screenplay: screenplayFixture,
          title: screenplayFixture.title,
          version: 1,
        }}
      />,
    );
    expect(
      await screen.findByText(/contains title pages, notes, dual dialogue, or page breaks/i),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Screenplay editing canvas' })).not.toHaveAttribute(
      'contenteditable',
      'true',
    );
    expect(screen.getByText('Text editing is unavailable for this screenplay')).toBeVisible();
    expect(screen.queryByText('INT. APARTMENT - MORNING')).not.toBeInTheDocument();
  });

  it('discards the prior editor instance when a route opens a different screenplay', async () => {
    const first = persistedScreenplay(
      '7c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
      'First screenplay',
      'First route content.',
    );
    const second = persistedScreenplay(
      '8c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
      'Second screenplay',
      'Second route content.',
    );
    const save = vi.spyOn(api, 'saveScreenplay').mockResolvedValue({ version: 2 });
    const user = userEvent.setup();
    const { rerender } = render(<App initial={first} key={first.id} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    await user.click(screen.getByRole('button', { name: /1\. First route content/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'action',
    );
    rerender(<App initial={second} key={second.id} />);

    const secondCanvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    expect(secondCanvas).toHaveTextContent('Second route content.');
    expect(secondCanvas).not.toHaveTextContent('First route content.');
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  });
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

  it('creates a scene heading after a transition', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: initialScreenplayContent,
      element: mount,
      extensions: screenplayExtensions,
    });
    const transitionPosition = findScreenplayBlockPosition(editor, transitionId);
    if (transitionPosition === undefined) {
      throw new Error('Initial transition block was not found.');
    }
    const transition = editor.state.doc.nodeAt(transitionPosition);
    if (transition === null) {
      throw new Error('Initial transition node was not found.');
    }

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, transitionPosition + transition.nodeSize - 1),
      ),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    const insertedHeading = editor.state.doc.child(5);
    expect(insertedHeading.attrs.element).toBe('scene_heading');
    expect(insertedHeading.textContent).toBe('');
    expect(insertedHeading.attrs.id).not.toBe(transitionId);
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

  it('toggles the element-label overlay class without changing document state, defaulting off', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    const scriptBody = container.querySelector('.script-body');
    if (!scriptBody) {
      throw new Error('Missing .script-body container.');
    }
    expect(scriptBody).not.toHaveClass('show-element-labels');

    const labelToggle = screen.getByRole('button', { name: 'Toggle element labels' });
    expect(labelToggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(labelToggle);
    expect(scriptBody).toHaveClass('show-element-labels');
    expect(labelToggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(labelToggle);
    expect(scriptBody).not.toHaveClass('show-element-labels');
  });

  it('gives every icon-only control a title tooltip sourced from its accessible name', async () => {
    render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    for (const name of [
      'Undo local change',
      'Redo local change',
      'Toggle element labels',
      'Toggle navigator',
      'Toggle inspector',
      'Close navigator',
      'Close inspector',
      'Zoom out',
      'Zoom in',
    ]) {
      const control = screen.getByRole('button', { name });
      expect(control).toHaveAttribute('title', name);
    }
  });

  it('moves zoom into the toolbar, keeping the same range and the output element', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('100%');

    const zoomOut = within(toolbar).getByRole('button', { name: 'Zoom out' });
    for (let i = 0; i < 4; i += 1) {
      await user.click(zoomOut);
    }
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('70%');
    await user.click(zoomOut);
    // Clamped at 70, the existing floor -- a relocation must preserve the original range.
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('70%');
  });
});

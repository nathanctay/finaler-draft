import { describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  projectEditorScreenplay,
  screenplayExtensions,
  type ScreenplayElementType,
} from './screenplayEditor.js';
import { SmartTypeGhostExtension, smartTypeGhostPluginKey } from './smartTypeGhost.js';
import { SmartTypeList, SmartTypeListExtension } from './smartTypeList.js';

/**
 * Like `smartTypeGhost.test.ts`, these drive the real editor -- real schema, real keymaps, real
 * decorations -- with the real component mounted beside it, because every claim stage 3 makes is
 * about the two layers agreeing: what the listbox shows, what the ghost shows, and what `Tab`
 * inserts have to be one answer, and only running both together can show that they are.
 *
 * Two things jsdom cannot answer are asserted in a real browser instead
 * (`apps/web/e2e/page-rendering-persistence.spec.ts`): that an open list moves no line and no page
 * break, and where the panel is actually painted. jsdom reports every box as zero-sized, so it can
 * show that the placement code runs and cannot show what it computes.
 */

type Block = { element: ScreenplayElementType; text: string };

function blockId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/**
 * Four locations beginning with `A`, authored in an order that fixes the ranking `suggest`
 * returns: all four are authored once, so the tie breaks by most-recently-authored, newest first.
 * Typing `INT. A` therefore offers ATTIC, ATRIUM, ALLEY, APARTMENT in that order, and narrowing to
 * `INT. AT` leaves ATTIC and ATRIUM -- a pair, not a single candidate, which is what lets a test
 * tell "the selection was reset to the top" apart from "the selection was clamped to the end".
 */
const AUTHORED = [
  { element: 'scene_heading', text: 'INT. APARTMENT - MORNING' },
  { element: 'action', text: 'Rain against the window.' },
  { element: 'scene_heading', text: 'EXT. ALLEY - NIGHT' },
  { element: 'character', text: 'MARA' },
  { element: 'dialogue', text: 'It never stops.' },
  { element: 'scene_heading', text: 'INT. ATRIUM - DAY' },
  { element: 'scene_heading', text: 'INT. ATTIC - DAY' },
] as const satisfies readonly Block[];

/** The empty scene heading appended after `AUTHORED`, which every test types into. */
const DRAFT_INDEX = AUTHORED.length;

const RANKED_LOCATIONS = ['ATTIC', 'ATRIUM', 'ALLEY', 'APARTMENT'] as const;

function buildEditor(blocks: readonly Block[]) {
  const mount = document.createElement('div');
  document.body.append(mount);
  return new Editor({
    content: {
      type: 'screenplayDocument' as const,
      content: blocks.map((block, index) => ({
        type: 'screenplayBlock' as const,
        attrs: { element: block.element, id: blockId(index) },
        ...(block.text === '' ? {} : { content: [{ type: 'text', text: block.text }] }),
      })),
    },
    element: mount,
    extensions: [...screenplayExtensions, SmartTypeGhostExtension, SmartTypeListExtension],
  });
}

/**
 * An editor holding `AUTHORED` plus an empty scene heading, with `typed` already typed into it and
 * the component mounted. Returns after the ghost plugin's frame-coalesced vocabulary refresh has
 * run, so every test starts from the steady state a writer would actually be looking at rather
 * than from the one-frame-stale vocabulary the keystroke itself sees.
 */
/** Places the caret at the end of block `index`'s own text -- the only place a ghost is ever
 * offered, and so the only place this layer has anything to show. */
function caretAtEndOfBlock(editor: Editor, index: number): void {
  let start = 0;
  for (let child = 0; child < index; child += 1) {
    start += editor.state.doc.child(child).nodeSize;
  }
  const end = start + editor.state.doc.child(index).nodeSize - 1;
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));
}

/** Runs the ghost plugin's frame-coalesced vocabulary refresh, plus the frame it dispatches in. */
async function flushFrames(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function openDraft(typed: string) {
  const editor = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);
  render(<SmartTypeList editor={editor} />);

  await act(async () => {
    caretAtEndOfBlock(editor, DRAFT_INDEX);
    editor.view.dispatch(editor.state.tr.insertText(typed));
    await flushFrames();
  });
  return editor;
}

/** Presses `key` through the editor's real keymap stack, returning whether anything handled it. */
function press(editor: Editor, key: string): boolean {
  let handled = false;
  act(() => {
    handled =
      editor.view.someProp('handleKeyDown', (handler) =>
        handler(editor.view, new KeyboardEvent('keydown', { key })),
      ) ?? false;
  });
  return handled;
}

function type(editor: Editor, text: string): void {
  act(() => {
    editor.view.dispatch(editor.state.tr.insertText(text));
  });
}

/** The ghost text actually painted beside the caret -- what the writer sees the list agreeing with. */
function renderedGhost(editor: Editor): string | undefined {
  return editor.view.dom.querySelector('.smarttype-ghost')?.textContent ?? undefined;
}

function optionLabels(): string[] {
  return screen.queryAllByRole('option').map((option) => option.textContent ?? '');
}

function selectedOption(): string | undefined {
  return screen
    .queryAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true')?.textContent;
}

/** The canonical screenplay's text for every block -- what a save, a reload or an export sees. */
function canonicalTexts(editor: Editor): string[] {
  const projection = projectEditorScreenplay(editor);
  if (!projection.valid) {
    throw new Error(`Projection failed: ${projection.issues.join(' ')}`);
  }
  return projection.screenplay.blocks.map((block) => ('text' in block ? block.text : ''));
}

describe('opening the list', () => {
  it('is closed until ArrowDown, and then shows every ranked candidate', async () => {
    const editor = await openDraft('INT. A');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(renderedGhost(editor)).toBe('TTIC');

    expect(press(editor, 'ArrowDown')).toBe(true);

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(optionLabels()).toEqual([...RANKED_LOCATIONS]);
    expect(selectedOption()).toBe('ATTIC');
  });

  /**
   * The list is an alternative to the ghost, not a replacement for the caret. `ArrowUp` at a caret
   * with a completion on offer still moves the caret, and `ArrowDown` only claims the key when
   * there is something to open -- everywhere else in the manuscript both keys are untouched.
   */
  it('does not open on ArrowUp, and claims neither arrow where nothing is offered', async () => {
    const editor = await openDraft('INT. A');

    expect(press(editor, 'ArrowUp')).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();

    cleanup();
    const plain = buildEditor([...AUTHORED, { element: 'action', text: 'Nothing to complete' }]);
    render(<SmartTypeList editor={plain} />);
    act(() => {
      plain.view.dispatch(
        plain.state.tr.setSelection(
          TextSelection.create(plain.state.doc, plain.state.doc.content.size - 1),
        ),
      );
    });

    expect(press(plain, 'ArrowDown')).toBe(false);
    expect(press(plain, 'ArrowUp')).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('renders nothing at all without an editor', () => {
    render(<SmartTypeList editor={null} />);

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});

describe('moving the selection', () => {
  /**
   * The point of the whole layer: the ghost is whatever the list has selected. If these two could
   * disagree, `Tab` would insert something other than the text the writer is looking at.
   */
  it('moves the ghost with the selection', async () => {
    const editor = await openDraft('INT. A');
    press(editor, 'ArrowDown');

    expect(renderedGhost(editor)).toBe('TTIC');

    press(editor, 'ArrowDown');
    expect(selectedOption()).toBe('ATRIUM');
    expect(renderedGhost(editor)).toBe('TRIUM');

    press(editor, 'ArrowDown');
    expect(selectedOption()).toBe('ALLEY');
    expect(renderedGhost(editor)).toBe('LLEY');

    press(editor, 'ArrowUp');
    expect(selectedOption()).toBe('ATRIUM');
    expect(renderedGhost(editor)).toBe('TRIUM');
  });

  it('wraps at both ends', async () => {
    const editor = await openDraft('INT. A');
    press(editor, 'ArrowDown');

    press(editor, 'ArrowUp');
    expect(selectedOption()).toBe('APARTMENT');

    press(editor, 'ArrowDown');
    expect(selectedOption()).toBe('ATTIC');
  });

  /**
   * Browsing is not editing. Every candidate the writer looks at is a decoration and a plugin
   * state field; the canonical screenplay -- what a save, a reload and every export read -- is the
   * eight blocks they typed, throughout.
   */
  it('puts nothing into the document while the writer browses', async () => {
    const editor = await openDraft('INT. A');
    const before = canonicalTexts(editor);

    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');

    expect(canonicalTexts(editor)).toEqual(before);
    expect(before[DRAFT_INDEX]).toBe('INT. A');
  });
});

describe('accepting', () => {
  it('inserts the selected candidate, not the top-ranked one, and closes', async () => {
    const editor = await openDraft('INT. A');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');

    expect(press(editor, 'Tab')).toBe(true);

    expect(canonicalTexts(editor)[DRAFT_INDEX]).toBe('INT. ATRIUM');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  /**
   * Accepting closes the list, and it has to be the accept that closes it rather than the
   * completions running out -- most accepts do exhaust them, which would let a list that never
   * closed pass unnoticed. A half-typed prefix is the case that does not: accepting `INT.` leaves
   * `INT./EXT.` still matching, so a ghost is still on offer afterwards and the list has to have
   * been closed deliberately to be gone.
   */
  it('closes on accept even when a further completion is still offered', async () => {
    const editor = await openDraft('IN');
    press(editor, 'ArrowDown');
    expect(optionLabels()).toEqual(['INT.', 'INT./EXT.']);

    press(editor, 'Tab');

    expect(canonicalTexts(editor)[DRAFT_INDEX]).toBe('INT.');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(renderedGhost(editor)).toBe('/EXT.');
  });

  it('accepts a clicked option', async () => {
    const editor = await openDraft('INT. A');
    press(editor, 'ArrowDown');

    act(() => {
      screen
        .getAllByRole('option')[2]
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });

    expect(canonicalTexts(editor)[DRAFT_INDEX]).toBe('INT. ALLEY');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  /**
   * With the list closed, `Tab` is the ghost's, and behind the ghost it is still
   * `ScreenplayBlockNode`'s element conversions. This layer declines the key rather than wrapping
   * it, which is what leaves both of those exactly as stage 2 left them.
   */
  it('leaves Tab to the ghost while the list is closed', async () => {
    const editor = await openDraft('INT. A');

    expect(press(editor, 'Tab')).toBe(true);
    expect(canonicalTexts(editor)[DRAFT_INDEX]).toBe('INT. ATTIC');
  });

  /**
   * An open list is a panel on screen with a highlighted row, reached only by a deliberate
   * `ArrowDown`, and in that state `Enter` accepting the highlighted row is what every dropdown
   * does. It accepts the *selected* candidate, not the top-ranked one, and it does not also split
   * the block on the way through.
   */
  it('accepts the selected candidate on Enter while the list is open', async () => {
    const editor = await openDraft('INT. A');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');

    expect(press(editor, 'Enter')).toBe(true);

    const texts = canonicalTexts(editor);
    expect(texts[DRAFT_INDEX]).toBe('INT. ATRIUM');
    expect(texts).toHaveLength(AUTHORED.length + 1);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  /**
   * The other half of that rule, and the more important half: with the list closed, `Enter` is
   * `splitScreenplayBlock` and nothing else. A ghost showing is not enough to claim it -- a
   * completion appears on its own from typing, so an `Enter` that accepted one would split a block
   * or not for reasons the writer never chose. This is also what keeps the element menu's future
   * second-`Enter`-on-an-empty-block clear: an empty scene heading shows a ghost, so a ghost-level
   * `Enter` would have collided with it directly.
   */
  it('leaves Enter to splitScreenplayBlock while the list is closed, ghost or no ghost', async () => {
    const editor = await openDraft('INT. A');
    expect(renderedGhost(editor)).toBe('TTIC');

    expect(press(editor, 'Enter')).toBe(true);

    const texts = canonicalTexts(editor);
    expect(texts[DRAFT_INDEX]).toBe('INT. A');
    expect(texts).toHaveLength(AUTHORED.length + 2);
  });

  /**
   * And once the list has been closed again, `Enter` goes straight back to splitting -- the
   * binding is not a mode the writer can get stuck in.
   */
  it('gives Enter back to splitScreenplayBlock when the list closes', async () => {
    const editor = await openDraft('INT. A');
    press(editor, 'ArrowDown');
    press(editor, 'Escape');

    expect(press(editor, 'Enter')).toBe(true);

    const texts = canonicalTexts(editor);
    expect(texts[DRAFT_INDEX]).toBe('INT. A');
    expect(texts).toHaveLength(AUTHORED.length + 2);
  });
});

describe('closing', () => {
  /**
   * Two Escapes, two different effects, in the order a writer would expect: the thing they just
   * opened goes away first, and the completion they were offered stays until they say otherwise.
   */
  it('closes on the first Escape and dismisses the ghost on the second', async () => {
    const editor = await openDraft('INT. A');
    press(editor, 'ArrowDown');

    expect(press(editor, 'Escape')).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(renderedGhost(editor)).toBe('TTIC');

    expect(press(editor, 'Escape')).toBe(true);
    expect(renderedGhost(editor)).toBeUndefined();
    expect(smartTypeGhostPluginKey.getState(editor.state)?.ghost).toBeUndefined();
  });

  /** Closing returns the ghost to its own ranking rather than leaving the browsed candidate behind. */
  it('gives the ghost back its top-ranked candidate', async () => {
    const editor = await openDraft('INT. A');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    expect(renderedGhost(editor)).toBe('TRIUM');

    press(editor, 'Escape');

    expect(renderedGhost(editor)).toBe('TTIC');
  });

  /**
   * The caret moving away closes the list, and it has to be the move that closes it rather than
   * the completions running out -- so this lands the caret somewhere the identical completions are
   * still on offer, with the ghost still drawn, and requires the list to be gone anyway. Closing on
   * a caret move only where a completion happened to vanish would leave the list stranded open
   * whenever a writer clicked from one half-typed heading to another.
   */
  it('closes when the caret moves to another block offering the same completions', async () => {
    const editor = buildEditor([
      ...AUTHORED,
      { element: 'scene_heading', text: 'INT. A' },
      { element: 'scene_heading', text: 'INT. A' },
    ]);
    render(<SmartTypeList editor={editor} />);
    await act(async () => {
      caretAtEndOfBlock(editor, DRAFT_INDEX);
      await flushFrames();
    });

    press(editor, 'ArrowDown');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    act(() => {
      caretAtEndOfBlock(editor, DRAFT_INDEX + 1);
    });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(renderedGhost(editor)).toBe('TTIC');
  });

  it('closes when the candidates run out', async () => {
    const editor = await openDraft('INT. A');
    press(editor, 'ArrowDown');

    type(editor, 'ZZ');

    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('typing while the list is open', () => {
  /**
   * A combobox narrows rather than closing. The selection goes back to the top of the new ranking
   * -- not clamped to the end of it -- and the ghost follows, because the same document change
   * clears the ghost's override.
   */
  it('refilters and returns the selection to the top', async () => {
    const editor = await openDraft('INT. A');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowDown');
    expect(selectedOption()).toBe('ALLEY');

    type(editor, 'T');

    expect(optionLabels()).toEqual(['ATTIC', 'ATRIUM']);
    expect(selectedOption()).toBe('ATTIC');
    expect(renderedGhost(editor)).toBe('TIC');
  });
});

describe('what a screen reader is told', () => {
  /**
   * The ghost is `aria-hidden`, so without this a completion is offered to nobody who cannot see
   * it. The closed message names only the count, so narrowing four candidates to two announces
   * once rather than on every keystroke.
   */
  it('announces the count while closed and the selection while open', async () => {
    const editor = await openDraft('INT. A');

    expect(screen.getByRole('status')).toHaveTextContent(
      '4 completions available. Press Down Arrow to review.',
    );

    press(editor, 'ArrowDown');
    expect(screen.getByRole('status')).toHaveTextContent('ATTIC, 1 of 4.');

    press(editor, 'ArrowDown');
    expect(screen.getByRole('status')).toHaveTextContent('ATRIUM, 2 of 4.');
  });

  it('says nothing when nothing is offered', () => {
    const editor = buildEditor([{ element: 'action', text: 'Nothing to complete' }]);
    render(<SmartTypeList editor={editor} />);

    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  /**
   * The manuscript stays a `textbox` -- ARIA's `combobox` role does not support `aria-multiline`,
   * and the canvas is multi-line for every second the list is not open. It gains the pairing
   * attributes only while the popup exists, and gives them back when it goes.
   */
  it('pairs the canvas with the popup only while the popup exists', async () => {
    const editor = await openDraft('INT. A');
    const canvas = editor.view.dom;

    expect(canvas.hasAttribute('aria-expanded')).toBe(false);

    press(editor, 'ArrowDown');
    expect(canvas.getAttribute('aria-expanded')).toBe('true');
    expect(canvas.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    expect(canvas.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]?.id);

    press(editor, 'ArrowDown');
    expect(canvas.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]?.id);

    press(editor, 'Escape');
    expect(canvas.hasAttribute('aria-expanded')).toBe(false);
    expect(canvas.hasAttribute('aria-activedescendant')).toBe(false);
    expect(canvas.hasAttribute('aria-controls')).toBe(false);
    expect(canvas.hasAttribute('aria-autocomplete')).toBe(false);
  });
});

describe('character cues', () => {
  it('completes them too, from the same ranking the ghost uses', async () => {
    const editor = buildEditor([...AUTHORED, { element: 'character', text: '' }]);
    render(<SmartTypeList editor={editor} />);
    await act(async () => {
      caretAtEndOfBlock(editor, DRAFT_INDEX);
      editor.view.dispatch(editor.state.tr.insertText('MA'));
      await flushFrames();
    });

    press(editor, 'ArrowDown');

    expect(optionLabels()).toEqual(['MARA']);
    press(editor, 'Tab');
    expect(canonicalTexts(editor)[DRAFT_INDEX]).toBe('MARA');
  });
});

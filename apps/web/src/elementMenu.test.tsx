import { describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  projectEditorScreenplay,
  screenplayExtensions,
  type ScreenplayElementType,
} from './screenplayEditor.js';
import { SmartTypeGhostExtension } from './smartTypeGhost.js';
import { SmartTypeList, SmartTypeListExtension } from './smartTypeList.js';
import { ElementMenu, ElementMenuExtension } from './elementMenu.js';

/**
 * These drive the real editor with the real extension stack -- SmartType's ghost and list mounted
 * alongside the menu, in the order and at the priorities `App.tsx` mounts them -- because the
 * claims that matter most here are about which of three layers gets `Enter`. A menu tested against
 * a bare editor would prove nothing about the only collision it can have.
 *
 * Two things jsdom cannot answer are asserted in a real browser instead
 * (`apps/web/e2e/page-rendering-persistence.spec.ts`): that an open menu moves no line and no page
 * break, and where the panel is actually painted. jsdom reports every box as zero-sized, so it can
 * show that the placement code runs and cannot show what it computes.
 */

type Block = { element: ScreenplayElementType; text: string };

function blockId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** Enough authored body to give SmartType a real vocabulary: `INT. APARTMENT` is what an empty
 * scene heading's ghost completes towards, which is the state the ghost-suppression and
 * Enter-arbitration tests need. */
const AUTHORED = [
  { element: 'scene_heading', text: 'INT. APARTMENT - MORNING' },
  { element: 'action', text: 'Rain against the window.' },
  { element: 'character', text: 'MARA' },
  { element: 'dialogue', text: 'It never stops.' },
] as const satisfies readonly Block[];

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
    extensions: [
      ...screenplayExtensions,
      SmartTypeGhostExtension,
      SmartTypeListExtension,
      ElementMenuExtension,
    ],
  });
}

/** Places the caret at the end of block `index`'s own text. */
function caretAtEndOfBlock(editor: Editor, index: number): void {
  let start = 0;
  for (let child = 0; child < index; child += 1) {
    start += editor.state.doc.child(child).nodeSize;
  }
  const end = start + editor.state.doc.child(index).nodeSize - 1;
  act(() => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));
  });
}

/** Runs the ghost plugin's frame-coalesced vocabulary refresh, plus the frame it dispatches in. */
async function flushFrames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

/**
 * The document every test starts from: the authored body plus one trailing block of `element`,
 * empty, with the caret in it -- exactly what the first `Enter` at the end of the body leaves
 * behind. Both panels are mounted, because several of these tests are about the two of them not
 * being on screen together.
 */
async function openEmptyBlock(element: ScreenplayElementType) {
  const editor = buildEditor([...AUTHORED, { element, text: '' }]);
  render(
    <>
      <SmartTypeList editor={editor} />
      <ElementMenu editor={editor} />
    </>,
  );
  caretAtEndOfBlock(editor, AUTHORED.length);
  await flushFrames();
  return editor;
}

/** Presses `key` through the editor's real keymap stack, returning whether anything handled it. */
function press(editor: Editor, key: string, shiftKey = false): boolean {
  let handled = false;
  act(() => {
    handled =
      editor.view.someProp('handleKeyDown', (handler) =>
        handler(editor.view, new KeyboardEvent('keydown', { key, shiftKey })),
      ) ?? false;
  });
  return handled;
}

function type(editor: Editor, text: string): void {
  act(() => {
    editor.view.dispatch(editor.state.tr.insertText(text));
  });
}

function optionLabels(): string[] {
  return screen.queryAllByRole('option').map((option) => option.textContent ?? '');
}

function selectedOption(): string | undefined {
  return screen
    .queryAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true')?.textContent;
}

/** Every live region on screen. Both panels mount one and both are always present, so an
 * announcement is asserted by membership rather than by picking one of them out by position. */
function announcements(): string[] {
  return screen.getAllByRole('status').map((region) => region.textContent ?? '');
}

function menu(): HTMLElement | null {
  return screen.queryByRole('listbox', { name: 'Element types' });
}

function renderedGhost(editor: Editor): string | undefined {
  return editor.view.dom.querySelector('.smarttype-ghost')?.textContent ?? undefined;
}

/** Every block's element and text, read through the canonical projection -- what a save, a reload
 * and every export actually see. */
function canonicalBlocks(editor: Editor): Array<{ text: string; type: string }> {
  const projection = projectEditorScreenplay(editor);
  if (!projection.valid) {
    throw new Error(`Projection failed: ${projection.issues.join(' ')}`);
  }
  return projection.screenplay.blocks.map((block) => ({
    text: 'text' in block ? block.text : '',
    type: block.type,
  }));
}

/** Counts transactions that actually changed the document, which is also what `App.tsx` saves
 * on. Used to prove that opening, moving and closing the menu write nothing. */
function countDocChanges(editor: Editor): () => number {
  let changes = 0;
  editor.on('transaction', ({ transaction }) => {
    if (transaction.docChanged) {
      changes += 1;
    }
  });
  return () => changes;
}

describe('opening the menu', () => {
  it('opens on Enter at an empty block instead of stacking a second one', async () => {
    const editor = await openEmptyBlock('action');
    const blocksBefore = editor.state.doc.childCount;

    expect(menu()).toBeNull();
    expect(press(editor, 'Enter')).toBe(true);

    expect(menu()).toBeInTheDocument();
    expect(editor.state.doc.childCount).toBe(blocksBefore);
    expect(optionLabels()).toEqual([
      'Scene HeadingS',
      'ActionA',
      'CharacterC',
      'DialogueD',
      'ParentheticalP',
      'TransitionT',
      'ShotH',
    ]);
  });

  it('highlights the element the block already has, so the menu says what this blank line is', async () => {
    const editor = await openEmptyBlock('dialogue');

    press(editor, 'Enter');

    expect(selectedOption()).toBe('DialogueD');
    expect(announcements()).toContain('Dialogue, shortcut D, 4 of 7.');
  });

  it('leaves Enter to splitScreenplayBlock wherever the block has text', async () => {
    const editor = await openEmptyBlock('action');
    caretAtEndOfBlock(editor, 1);

    expect(press(editor, 'Enter')).toBe(true);

    expect(menu()).toBeNull();
    expect(editor.state.doc.childCount).toBe(AUTHORED.length + 2);
    expect(editor.state.doc.child(2).textContent).toBe('');
  });

  /**
   * `ScreenplayBlockNode`'s own Enter creates the very first block of an empty document. That is
   * the one place an Enter with no block under it must still do something, and this menu has to
   * decline rather than swallow it.
   */
  it('declines Enter in a document with no blocks at all', () => {
    const editor = buildEditor([]);
    render(<ElementMenu editor={editor} />);

    expect(press(editor, 'Enter')).toBe(true);

    expect(menu()).toBeNull();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).attrs.element).toBe('action');
  });

  it('renders nothing at all without an editor', () => {
    render(<ElementMenu editor={null} />);

    expect(menu()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});

describe('choosing a type', () => {
  it('changes the element on its shortcut letter, in either case, and closes', async () => {
    const editor = await openEmptyBlock('action');

    press(editor, 'Enter');
    expect(press(editor, 'c')).toBe(true);

    expect(menu()).toBeNull();
    expect(editor.state.doc.child(AUTHORED.length).attrs.element).toBe('character');

    press(editor, 'Enter');
    expect(press(editor, 'T', true)).toBe(true);
    expect(editor.state.doc.child(AUTHORED.length).attrs.element).toBe('transition');
  });

  it('reaches every element type from its own key', async () => {
    const expected: ReadonlyArray<readonly [string, ScreenplayElementType]> = [
      ['s', 'scene_heading'],
      ['a', 'action'],
      ['c', 'character'],
      ['d', 'dialogue'],
      ['t', 'transition'],
      ['h', 'shot'],
    ];
    for (const [key, element] of expected) {
      const editor = await openEmptyBlock('action');
      press(editor, 'Enter');
      expect(press(editor, key)).toBe(true);
      expect(editor.state.doc.child(AUTHORED.length).attrs.element).toBe(element);
      editor.destroy();
      cleanup();
    }
  });

  /**
   * `P` goes through `convertActiveScreenplayBlock` like every other choice, so it inherits
   * behaviour 1: a new parenthetical is given its own `()` with the caret between them. That is
   * the type change for a parenthetical, not an exception to "nothing enters the document except
   * the type change" -- and it leaves the block non-empty, so the next Enter splits rather than
   * reopening the menu.
   */
  it('gives a new parenthetical its parentheses, which ends the empty-block rule for it', async () => {
    const editor = await openEmptyBlock('dialogue');

    press(editor, 'Enter');
    press(editor, 'p');

    expect(editor.state.doc.child(AUTHORED.length).attrs.element).toBe('parenthetical');
    expect(editor.state.doc.child(AUTHORED.length).textContent).toBe('()');

    expect(press(editor, 'Enter')).toBe(true);
    expect(menu()).toBeNull();
    expect(editor.state.doc.childCount).toBe(AUTHORED.length + 2);
  });

  it('writes nothing to the document when the choice is the element the block already has', async () => {
    const editor = await openEmptyBlock('action');
    const docChanges = countDocChanges(editor);

    press(editor, 'Enter');
    press(editor, 'a');

    expect(menu()).toBeNull();
    expect(editor.state.doc.child(AUTHORED.length).attrs.element).toBe('action');
    expect(docChanges()).toBe(0);
  });

  it('writes nothing while merely opening, moving and closing', async () => {
    const editor = await openEmptyBlock('action');
    const before = canonicalBlocks(editor);
    const docChanges = countDocChanges(editor);

    press(editor, 'Enter');
    press(editor, 'ArrowDown');
    press(editor, 'ArrowUp');
    press(editor, 'Escape');

    expect(docChanges()).toBe(0);
    expect(canonicalBlocks(editor)).toEqual(before);
  });

  /**
   * Deliberately from a `transition` block to `shot`, not from `action` to `character`: `Tab` in
   * `ScreenplayBlockNode`'s own keymap already turns action into character and dialogue into
   * parenthetical, so a test starting from either of those passes whether this menu handles `Tab`
   * or merely declines it -- confirmed by mutation, which is how this test came to look like this.
   * `Tab` at a transition is a key nothing else in the editor claims.
   */
  it('accepts the highlighted row on Tab', async () => {
    const editor = await openEmptyBlock('transition');

    press(editor, 'Enter');
    press(editor, 'ArrowDown');
    expect(selectedOption()).toBe('ShotH');
    expect(press(editor, 'Tab')).toBe(true);

    expect(menu()).toBeNull();
    expect(editor.state.doc.child(AUTHORED.length).attrs.element).toBe('shot');
  });

  it('accepts a row clicked with the mouse, without letting the click take the caret', async () => {
    const editor = await openEmptyBlock('action');
    press(editor, 'Enter');

    // By accessible name, which is the label and the shortcut letter read together -- the
    // separator the DOM's two spans do not have.
    const shot = screen.getByRole('option', { name: 'Shot H' });
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      shot.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(editor.state.doc.child(AUTHORED.length).attrs.element).toBe('shot');
  });

  /** plan.md's behaviour 4, and the reason the rule is "the block is empty" rather than "the last
   * keystroke was Enter": choosing a type leaves the block empty, so Enter offers the types again
   * instead of creating a further empty block. */
  it('reopens on the next Enter, because the block chosen for is still empty', async () => {
    const editor = await openEmptyBlock('action');

    press(editor, 'Enter');
    press(editor, 'c');
    expect(editor.state.doc.childCount).toBe(AUTHORED.length + 1);

    expect(press(editor, 'Enter')).toBe(true);

    expect(menu()).toBeInTheDocument();
    expect(selectedOption()).toBe('CharacterC');
    expect(editor.state.doc.childCount).toBe(AUTHORED.length + 1);
  });
});

describe('dismissing the menu', () => {
  it('closes on a second Enter and leaves the empty block with the type it had', async () => {
    const editor = await openEmptyBlock('dialogue');

    press(editor, 'Enter');
    expect(press(editor, 'Enter')).toBe(true);

    expect(menu()).toBeNull();
    expect(editor.state.doc.childCount).toBe(AUTHORED.length + 1);
    expect(editor.state.doc.child(AUTHORED.length).attrs.element).toBe('dialogue');
    expect(editor.state.doc.child(AUTHORED.length).textContent).toBe('');
  });

  it('closes on Escape, and leaves Escape alone when it is not open', async () => {
    const editor = await openEmptyBlock('action');

    expect(press(editor, 'Escape')).toBe(false);

    press(editor, 'Enter');
    expect(press(editor, 'Escape')).toBe(true);
    expect(menu()).toBeNull();
    expect(editor.state.doc.childCount).toBe(AUTHORED.length + 1);
  });

  it('closes when the writer simply types, and the letter typed is ordinary text again', async () => {
    const editor = await openEmptyBlock('action');

    press(editor, 'Enter');
    expect(menu()).toBeInTheDocument();
    type(editor, 'x');

    expect(menu()).toBeNull();
    expect(editor.state.doc.child(AUTHORED.length).textContent).toBe('x');
    expect(press(editor, 's')).toBe(false);
    expect(editor.state.doc.child(AUTHORED.length).attrs.element).toBe('action');
  });

  /**
   * Both of these reach the plugin's own close rule rather than the derived gate above it, and
   * they were written because a mutation proved the two tests around them could not tell the
   * difference: typing or clicking into a block with text in it hides the menu either way, since
   * `readElementMenu` shows nothing where there is no empty block at the caret. Only a caret that
   * lands on *another* empty block, or a block that becomes empty again, can distinguish "the menu
   * closed" from "the menu is merely not being drawn" -- and in both of those the stored state
   * would otherwise put the panel back on screen with no Enter behind it.
   */
  it('does not follow the caret onto a different empty block', async () => {
    const editor = buildEditor([
      ...AUTHORED,
      { element: 'action', text: '' },
      { element: 'character', text: '' },
    ]);
    render(<ElementMenu editor={editor} />);
    caretAtEndOfBlock(editor, AUTHORED.length);
    await flushFrames();

    press(editor, 'Enter');
    expect(menu()).toBeInTheDocument();

    caretAtEndOfBlock(editor, AUTHORED.length + 1);

    expect(menu()).toBeNull();
  });

  it('does not come back when the writer empties the block again', async () => {
    const editor = await openEmptyBlock('action');

    press(editor, 'Enter');
    type(editor, 'x');
    expect(menu()).toBeNull();

    const { from } = editor.state.selection;
    act(() => {
      editor.view.dispatch(editor.state.tr.delete(from - 1, from));
    });

    expect(editor.state.doc.child(AUTHORED.length).textContent).toBe('');
    expect(menu()).toBeNull();
  });

  it('closes when the caret leaves the block it was opened for', async () => {
    const editor = await openEmptyBlock('action');

    press(editor, 'Enter');
    caretAtEndOfBlock(editor, 1);

    expect(menu()).toBeNull();
  });
});

describe('arbitrating Enter with SmartType', () => {
  /**
   * The collision this feature was most likely to cause. An empty scene heading ghosts `INT.`
   * deliberately -- Enter must still open the menu there, which is the decision `smartTypeGhost.ts`
   * records in its own `Tab`-only keymap.
   */
  it('opens over a ghost rather than accepting it', async () => {
    const editor = await openEmptyBlock('scene_heading');
    expect(renderedGhost(editor)).toBe('INT.');

    expect(press(editor, 'Enter')).toBe(true);

    expect(menu()).toBeInTheDocument();
    expect(editor.state.doc.child(AUTHORED.length).textContent).toBe('');
  });

  /** Two affordances for one keystroke is the defect. Opening the menu dismisses the ghost, so a
   * greyed `INT.` is never sitting behind a panel offering element types. */
  it('suppresses the ghost while it is open', async () => {
    const editor = await openEmptyBlock('scene_heading');

    press(editor, 'Enter');
    expect(renderedGhost(editor)).toBeUndefined();

    press(editor, 'Escape');
    expect(renderedGhost(editor)).toBeUndefined();
  });

  /** The dismissal lasts until the writer types, which is also what brings the ghost back for the
   * type they chose: a conversion is a document change. */
  it('gives the ghost back for the element that was chosen', async () => {
    const editor = await openEmptyBlock('action');

    press(editor, 'Enter');
    press(editor, 's');
    await flushFrames();

    expect(editor.state.doc.child(AUTHORED.length).attrs.element).toBe('scene_heading');
    expect(renderedGhost(editor)).toBe('INT.');
  });

  /**
   * The ordering that priority buys, asserted as behaviour rather than by reading the number. With
   * SmartType's list open over the same empty scene heading, Enter must accept the highlighted
   * candidate and the menu must not appear -- which is what `SmartTypeListExtension`'s priority of
   * 150, against this extension's 120, is for.
   */
  it('leaves Enter to an open SmartType candidate list', async () => {
    const editor = await openEmptyBlock('scene_heading');

    expect(press(editor, 'ArrowDown')).toBe(true);
    expect(screen.getByRole('listbox', { name: 'SmartType completions' })).toBeInTheDocument();

    expect(press(editor, 'Enter')).toBe(true);

    expect(menu()).toBeNull();
    expect(editor.state.doc.child(AUTHORED.length).textContent).toBe('INT.');
  });

  /** The second, independent guarantee that the two panels never coexist: the list is gated on a
   * ghost being on offer, and the menu dismissed it. */
  it('leaves no candidate list to open while it is showing', async () => {
    const editor = await openEmptyBlock('scene_heading');

    press(editor, 'Enter');
    expect(press(editor, 'ArrowDown')).toBe(true);

    expect(screen.queryByRole('listbox', { name: 'SmartType completions' })).toBeNull();
    expect(menu()).toBeInTheDocument();
  });
});

describe('what a screen reader is told', () => {
  it('pairs the manuscript with the popup for exactly as long as it is open', async () => {
    const editor = await openEmptyBlock('action');
    const canvas = editor.view.dom;

    expect(canvas.getAttribute('aria-expanded')).toBeNull();

    press(editor, 'Enter');
    expect(canvas.getAttribute('aria-expanded')).toBe('true');
    expect(canvas.getAttribute('aria-controls')).toBe('element-menu');
    expect(canvas.getAttribute('aria-activedescendant')).toBe('element-menu-option-1');
    // The manuscript keeps its own role: `combobox` has no `aria-multiline`, and the caret must
    // stay in the block the menu is about.
    expect(document.activeElement).not.toBe(menu());

    press(editor, 'Escape');
    expect(canvas.getAttribute('aria-expanded')).toBeNull();
    expect(canvas.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('wraps the highlight at both ends and announces each row with its shortcut', async () => {
    const editor = await openEmptyBlock('scene_heading');

    press(editor, 'Enter');
    expect(selectedOption()).toBe('Scene HeadingS');

    press(editor, 'ArrowUp');
    expect(selectedOption()).toBe('ShotH');
    expect(announcements()).toContain('Shot, shortcut H, 7 of 7.');

    press(editor, 'ArrowDown');
    expect(selectedOption()).toBe('Scene HeadingS');
    expect(announcements()).toContain('Scene Heading, shortcut S, 1 of 7.');
  });

  it('says nothing at all while it is closed', async () => {
    const editor = await openEmptyBlock('action');

    expect(announcements()).toEqual(['', '']);

    press(editor, 'Enter');
    press(editor, 'Escape');
    expect(announcements()).toEqual(['', '']);
  });

  it('claims neither arrow while it is closed', async () => {
    const editor = await openEmptyBlock('action');

    expect(press(editor, 'ArrowDown')).toBe(false);
    expect(press(editor, 'ArrowUp')).toBe(false);
    expect(menu()).toBeNull();
  });
});

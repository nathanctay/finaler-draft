import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  projectEditorScreenplay,
  screenplayExtensions,
  type ScreenplayElementType,
} from './screenplayEditor.js';
import {
  SmartTypeGhostExtension,
  overrideSmartTypeGhost,
  smartTypeGhostPluginKey,
} from './smartTypeGhost.js';

/**
 * These tests drive the real editor -- real schema, real keymap, real decorations rendered into a
 * real (jsdom) DOM -- rather than calling the ghost's helpers directly, because every claim this
 * feature makes is about a caret in a document: what is drawn beside it, what `Tab` does to it,
 * and what the canonical screenplay says while the ghost is on screen. A helper called with a
 * hand-made argument could satisfy all of them and still ghost nothing in the editor.
 *
 * The one thing jsdom cannot answer is whether the ghost moves a line on the page. That is
 * measured in a real browser, against real Courier Prime, in
 * `apps/web/e2e/page-rendering-persistence.spec.ts` ("an inline ghost completion changes no page
 * geometry and no line position").
 */

type Block = { element: ScreenplayElementType; text: string };

/**
 * A real stable id per block. Not cosmetic: `projectDocumentScreenplay` validates against the
 * canonical schema, whose `stableIdSchema` is `z.string().uuid()`, and the ghost derives its
 * vocabulary from that projection -- a fixture with `block-0`-style ids projects as invalid, so
 * every suggestion would silently fall back to the seeded prefixes and times and no test here
 * could tell a working derivation from a broken one.
 */
function blockId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function buildEditor(blocks: readonly Block[]) {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({
    content: {
      type: 'screenplayDocument' as const,
      content: blocks.map((block, index) => ({
        type: 'screenplayBlock' as const,
        attrs: { element: block.element, id: blockId(index) },
        ...(block.text === '' ? {} : { content: [{ type: 'text', text: block.text }] }),
      })),
    },
    element: mount,
    extensions: [...screenplayExtensions, SmartTypeGhostExtension],
  });
  return { editor, mount };
}

/** The document position of the first character of block `index`. */
function blockContentStart(editor: Editor, index: number): number {
  let position = 0;
  for (let child = 0; child < index; child += 1) {
    position += editor.state.doc.child(child).nodeSize;
  }
  return position + 1;
}

/** Places a caret (or, with `to`, a range) `from` characters into block `index`'s own text. */
function setSelection(editor: Editor, index: number, from: number, to: number = from): void {
  const start = blockContentStart(editor, index);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start + from, start + to)),
  );
}

/** Types `text` at the current caret, one transaction, the way `insertText` models a keystroke. */
function type(editor: Editor, text: string): void {
  editor.view.dispatch(editor.state.tr.insertText(text));
}

function pressKey(editor: Editor, key: string): boolean {
  return (
    editor.view.someProp('handleKeyDown', (handler) =>
      handler(editor.view, new KeyboardEvent('keydown', { key })),
    ) ?? false
  );
}

/** The ghost the plugin currently offers, as the plugin itself sees it. */
function ghostOf(editor: Editor) {
  return smartTypeGhostPluginKey.getState(editor.state)?.ghost;
}

/** The ghost text actually painted into the DOM, which is the thing the writer sees. */
function renderedGhost(mount: HTMLElement): string | undefined {
  return mount.querySelector('.smarttype-ghost')?.textContent ?? undefined;
}

function blockTexts(editor: Editor): string[] {
  const texts: string[] = [];
  editor.state.doc.forEach((node) => texts.push(node.textContent));
  return texts;
}

/** The canonical screenplay's own text for every block -- what a save, a reload, or an export sees. */
function canonicalTexts(editor: Editor): string[] {
  const projection = projectEditorScreenplay(editor);
  if (!projection.valid) {
    throw new Error(`Projection failed: ${projection.issues.join(' ')}`);
  }
  return projection.screenplay.blocks.map((block) => ('text' in block ? block.text : ''));
}

/** Runs whatever the plugin scheduled for the next animation frame, plus the frame it dispatches in. */
async function flushFrames(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

const AUTHORED = [
  { element: 'scene_heading', text: 'INT. APARTMENT - MORNING' },
  { element: 'action', text: 'Rain against the window.' },
  { element: 'character', text: 'MARA' },
  { element: 'dialogue', text: 'It never stops.' },
] as const satisfies readonly Block[];

describe('the ghost', () => {
  it('draws the best candidate’s remainder after the caret in a scene heading', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');

    expect(ghostOf(editor)).toMatchObject({
      insertText: 'APARTMENT',
      matchedLength: 2,
      text: 'ARTMENT',
    });
    expect(renderedGhost(mount)).toBe('ARTMENT');

    editor.destroy();
    mount.remove();
  });

  it('completes a character cue from the characters already authored', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'character', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'MA');

    expect(ghostOf(editor)).toMatchObject({ insertText: 'MARA', matchedLength: 2, text: 'RA' });
    expect(renderedGhost(mount)).toBe('RA');

    editor.destroy();
    mount.remove();
  });

  /*
   * The asymmetry is deliberate and is about what a suggestion is worth, not about the mechanism.
   * A scene heading has four candidates in fixed conventional order with `INT.` leading, so a ghost
   * on an empty one is a near-certain guess the writer takes with a single `Tab`. A character cue
   * has as many candidates as the screenplay has characters and no evidence yet to choose between
   * them -- ranking picks whoever spoke most, which is a coin flip against whoever this speech
   * actually belongs to -- so every new cue would open with a name to visually reject.
   *
   * The test above passes either way, because it types `MA` before asserting. Nothing covered the
   * empty cue, which is why suppressing it broke no test.
   */
  it('ghosts nothing on an empty character cue, while an empty scene heading still offers its prefix', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'character', text: '' }]);

    setSelection(editor, 4, 0);

    expect(ghostOf(editor)).toBeUndefined();
    expect(renderedGhost(mount)).toBeUndefined();

    editor.destroy();
    mount.remove();
  });

  it('still ghosts a prefix on an empty scene heading, where the guess is worth making', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);

    expect(ghostOf(editor)).toMatchObject({ insertText: 'INT.', matchedLength: 0, text: 'INT.' });
    expect(renderedGhost(mount)).toBe('INT.');

    editor.destroy();
    mount.remove();
  });

  it('offers the conventional prefixes the moment a scene heading is created empty', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);

    expect(renderedGhost(mount)).toBe('INT.');

    editor.destroy();
    mount.remove();
  });

  it('never ghosts in an element SmartType does not complete', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'action', text: 'INT. AP' }]);

    setSelection(editor, 4, 'INT. AP'.length);

    expect(ghostOf(editor)).toBeUndefined();
    expect(renderedGhost(mount)).toBeUndefined();

    editor.destroy();
    mount.remove();
  });

  /**
   * The caret-at-the-end rule. A ghost drawn mid-text would paint over characters the writer has
   * already written, and accepting it would rewrite text they had finished -- so the completion
   * is offered only where it can be appended.
   */
  it('never ghosts when the caret sits mid-text', () => {
    const { editor, mount } = buildEditor([
      ...AUTHORED,
      { element: 'scene_heading', text: 'INT. AP' },
    ]);

    setSelection(editor, 4, 'INT. A'.length);

    expect(ghostOf(editor)).toBeUndefined();
    expect(renderedGhost(mount)).toBeUndefined();

    editor.destroy();
    mount.remove();
  });

  it('never ghosts while text is selected', () => {
    const { editor, mount } = buildEditor([
      ...AUTHORED,
      { element: 'scene_heading', text: 'INT. AP' },
    ]);

    setSelection(editor, 4, 0, 'INT. AP'.length);

    expect(ghostOf(editor)).toBeUndefined();

    editor.destroy();
    mount.remove();
  });

  /**
   * Stage 1 still returns a candidate whose typed text matches it apart from case, because
   * accepting one corrects that case. There is no remainder to draw, though, so it is skipped --
   * and here nothing else in the vocabulary extends `MARA`, so there is no ghost at all and `Tab`
   * stays inert. Case correction needs an affordance of its own, which invisible ghost text is not.
   */
  it('does not ghost a candidate with nothing left to add', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'character', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'mara');

    expect(ghostOf(editor)).toBeUndefined();
    expect(pressKey(editor, 'Tab')).toBe(false);
    expect(blockTexts(editor)[4]).toBe('mara');

    editor.destroy();
    mount.remove();
  });
});

describe('the ghost and the canonical screenplay', () => {
  /**
   * The constraint the whole feature is built around: the ghost is a decoration, so it exists in
   * the DOM and nowhere else. This asserts both halves at once -- the writer can see the
   * completion, and the canonical screenplay (the value that is saved, reloaded, and exported)
   * does not contain a character of it.
   */
  it('is visible in the DOM and absent from the canonical screenplay', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');

    expect(renderedGhost(mount)).toBe('ARTMENT');
    expect(mount.textContent).toContain('INT. APARTMENT');

    expect(canonicalTexts(editor)).toEqual([
      'INT. APARTMENT - MORNING',
      'Rain against the window.',
      'MARA',
      'It never stops.',
      'INT. AP',
    ]);
    // The document ends exactly where the writer's own typing ended: the seven characters they
    // typed, and not one character of the completion drawn after them.
    expect(editor.state.doc.textContent.endsWith('INT. AP')).toBe(true);
    expect(blockTexts(editor)[4]).toBe('INT. AP');

    editor.destroy();
    mount.remove();
  });
});

describe('Tab', () => {
  it('accepts the ghost, replacing only the partial word and leaving the caret after it', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');

    expect(pressKey(editor, 'Tab')).toBe(true);

    expect(blockTexts(editor)[4]).toBe('INT. APARTMENT');
    expect(canonicalTexts(editor)[4]).toBe('INT. APARTMENT');
    expect(editor.state.selection.from).toBe(
      blockContentStart(editor, 4) + 'INT. APARTMENT'.length,
    );
    expect(editor.state.selection.empty).toBe(true);

    editor.destroy();
    mount.remove();
  });

  it('corrects the case of what the writer typed rather than appending to it', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'character', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'ma');

    expect(pressKey(editor, 'Tab')).toBe(true);
    expect(blockTexts(editor)[4]).toBe('MARA');

    editor.destroy();
    mount.remove();
  });

  /**
   * One undo takes back the completion and nothing else. Without `closeHistory`, the insertion
   * would join the history event the writer's own typing had just opened, and a single Ctrl+Z
   * would delete both -- leaving them with an empty block instead of the two characters they had
   * typed before asking for help.
   */
  it('is a single undoable act that leaves the typed text standing', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');
    pressKey(editor, 'Tab');
    expect(blockTexts(editor)[4]).toBe('INT. APARTMENT');

    editor.commands.undo();

    expect(blockTexts(editor)[4]).toBe('INT. AP');

    editor.commands.redo();
    expect(blockTexts(editor)[4]).toBe('INT. APARTMENT');

    editor.destroy();
    mount.remove();
  });

  /**
   * No ghost, no interception: `Tab`'s existing meaning is `ScreenplayBlockNode`'s element
   * conversion, and the two never overlap (a ghost only exists in a scene heading or a character
   * cue, where that keymap already declines). This is the regression that would tell us the ghost
   * had started swallowing the key.
   */
  it('still converts an action block to a character cue', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'Rain.' }]);

    setSelection(editor, 0, 'Rain.'.length);

    expect(pressKey(editor, 'Tab')).toBe(true);
    expect(editor.state.doc.child(0).attrs.element).toBe('character');

    editor.destroy();
    mount.remove();
  });

  it('does nothing at all when no ghost is showing', () => {
    const { editor, mount } = buildEditor([
      ...AUTHORED,
      { element: 'scene_heading', text: 'INT. AP' },
    ]);

    setSelection(editor, 4, 'INT. A'.length);

    expect(pressKey(editor, 'Tab')).toBe(false);
    expect(blockTexts(editor)[4]).toBe('INT. AP');

    editor.destroy();
    mount.remove();
  });
});

describe('Escape', () => {
  it('dismisses the ghost without touching the document, until the writer types again', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');
    expect(renderedGhost(mount)).toBe('ARTMENT');

    expect(pressKey(editor, 'Escape')).toBe(true);
    expect(ghostOf(editor)).toBeUndefined();
    expect(renderedGhost(mount)).toBeUndefined();
    expect(blockTexts(editor)[4]).toBe('INT. AP');

    // Still dismissed while the caret merely moves.
    setSelection(editor, 4, 0);
    setSelection(editor, 4, 'INT. AP'.length);
    expect(ghostOf(editor)).toBeUndefined();

    type(editor, 'A');
    expect(ghostOf(editor)).toMatchObject({ text: 'RTMENT' });
    expect(renderedGhost(mount)).toBe('RTMENT');

    editor.destroy();
    mount.remove();
  });

  it('leaves Escape alone when there is no ghost to dismiss', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'Rain.' }]);

    setSelection(editor, 0, 'Rain.'.length);

    expect(pressKey(editor, 'Escape')).toBe(false);

    editor.destroy();
    mount.remove();
  });
});

describe('the widget decoration', () => {
  /**
   * `prosemirror-view` compares keyed widgets by key alone (`WidgetType.eq`) and reuses the DOM
   * of any widget whose key matches. A key that did not encode the ghost text would therefore
   * leave the first suggestion painted on screen while the writer kept typing -- the codebase has
   * been bitten by exactly this before (see `pagination.ts`'s page-break widget key).
   */
  it('keys the widget by everything it draws, so the ghost text is redrawn as it changes', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. A');
    const firstKey = smartTypeGhostPluginKey.getState(editor.state)?.decorations.find()[0]
      ?.spec.key;
    expect(firstKey).toContain('ARTMENT');
    expect(renderedGhost(mount)).toBe('PARTMENT');

    type(editor, 'P');
    const secondKey = smartTypeGhostPluginKey.getState(editor.state)?.decorations.find()[0]
      ?.spec.key;
    expect(secondKey).not.toBe(firstKey);
    expect(renderedGhost(mount)).toBe('ARTMENT');

    editor.destroy();
    mount.remove();
  });

  it('is inert: not editable, not selectable by the caret, and hidden from assistive technology', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');

    const widget = mount.querySelector('.smarttype-ghost');
    expect(widget?.getAttribute('contenteditable')).toBe('false');
    expect(widget?.getAttribute('aria-hidden')).toBe('true');

    editor.destroy();
    mount.remove();
  });
});

describe('the vocabulary', () => {
  /**
   * The vocabulary is a whole-document scan, so it is refreshed on an animation frame rather than
   * inside the keystroke that changed the document (see the plugin's `view()` and
   * `paginationExtension.ts` for the same technique). A location authored in one scene heading is
   * therefore offered in the next one -- a frame later, not a keystroke later.
   */
  it('picks up newly authored terms once the frame that derives them has run', async () => {
    const { editor, mount } = buildEditor([
      ...AUTHORED,
      { element: 'scene_heading', text: '' },
      { element: 'scene_heading', text: '' },
    ]);

    setSelection(editor, 4, 0);
    type(editor, 'EXT. HARBOUR ROAD - NIGHT');
    await flushFrames();

    setSelection(editor, 5, 0);
    type(editor, 'EXT. HAR');

    expect(ghostOf(editor)).toMatchObject({ insertText: 'HARBOUR ROAD', text: 'BOUR ROAD' });

    editor.destroy();
    mount.remove();
  });

  /**
   * The regression that a browser found and no amount of reasoning had: the block being typed is
   * part of the document the vocabulary is derived from, so one frame after each keystroke the
   * writer's own half-word (`AP`) is in the vocabulary, matches their typing exactly, and outranks
   * the `APARTMENT` they are reaching for. Taking the top candidate unconditionally therefore made
   * the ghost cancel itself out a frame after every keystroke. Flushing the frame here is what
   * makes this test able to see that at all -- without it, the vocabulary is still the pre-keystroke
   * one and the bug is invisible.
   */
  it('keeps offering the completion once the writer’s own half-word is in the vocabulary', async () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');
    await flushFrames();

    expect(
      smartTypeGhostPluginKey
        .getState(editor.state)
        ?.vocabulary.locations.map((term) => term.value),
    ).toEqual(['AP', 'APARTMENT']);
    expect(ghostOf(editor)).toMatchObject({ insertText: 'APARTMENT', text: 'ARTMENT' });
    expect(renderedGhost(mount)).toBe('ARTMENT');

    editor.destroy();
    mount.remove();
  });

  /**
   * A document that cannot currently be projected (here, a block whose stable id was never set --
   * exactly what `mapBlock` refuses) keeps the vocabulary it already had rather than throwing or
   * blanking the ghost. The seeds are what a document with nothing authored starts with, so the
   * prefixes are still on offer.
   */
  it('falls back to what it already had when the document cannot be projected', async () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: {
        type: 'screenplayDocument' as const,
        content: [
          { type: 'screenplayBlock' as const, attrs: { element: 'action' } },
          { type: 'screenplayBlock' as const, attrs: { element: 'scene_heading' } },
        ],
      },
      element: mount,
      extensions: [...screenplayExtensions, SmartTypeGhostExtension],
    });

    expect(projectEditorScreenplay(editor).valid).toBe(false);

    setSelection(editor, 1, 0);
    type(editor, 'EX');
    await flushFrames();

    expect(ghostOf(editor)).toMatchObject({ insertText: 'EXT.', text: 'T.' });

    editor.destroy();
    mount.remove();
  });

  it('cancels a pending refresh when the editor is destroyed mid-frame', async () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');
    editor.destroy();
    await flushFrames();

    expect(mount.querySelector('.smarttype-ghost')).toBeNull();

    mount.remove();
  });
});

/**
 * The one seam this module offers anything built on top of it. Everything below is the ghost's own
 * behaviour under an override, tested here rather than in `smartTypeList.test.tsx` because it is
 * this module's contract: a caller may say which completion is on offer, and this module decides
 * for how long that stays true.
 */
describe('an overridden ghost', () => {
  it('draws what it was given, and inserts it on Tab', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');
    expect(renderedGhost(mount)).toBe('ARTMENT');

    overrideSmartTypeGhost(editor.view, {
      insertText: 'APOTHECARY',
      matchedLength: 2,
      pos: editor.state.selection.from,
      text: 'OTHECARY',
    });

    expect(renderedGhost(mount)).toBe('OTHECARY');
    expect(pressKey(editor, 'Tab')).toBe(true);
    expect(canonicalTexts(editor)[4]).toBe('INT. APOTHECARY');

    editor.destroy();
    mount.remove();
  });

  /**
   * An override describes one completion at one position. Both of the ways that position can stop
   * being current -- the writer types, the writer moves the caret -- drop it, so a caller that
   * stops re-asserting it leaves nothing stale behind for `Tab` to insert.
   */
  it('lasts only until the document or the caret moves', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');
    const override = {
      insertText: 'APOTHECARY',
      matchedLength: 2,
      pos: editor.state.selection.from,
      text: 'OTHECARY',
    };

    overrideSmartTypeGhost(editor.view, override);
    type(editor, 'A');
    expect(renderedGhost(mount)).toBe('RTMENT');

    overrideSmartTypeGhost(editor.view, { ...override, pos: editor.state.selection.from });
    setSelection(editor, 4, 0);
    setSelection(editor, 4, 'INT. APA'.length);
    expect(renderedGhost(mount)).toBe('RTMENT');

    editor.destroy();
    mount.remove();
  });

  it('is given back on request, leaving this module resolving its own again', () => {
    const { editor, mount } = buildEditor([...AUTHORED, { element: 'scene_heading', text: '' }]);

    setSelection(editor, 4, 0);
    type(editor, 'INT. AP');
    overrideSmartTypeGhost(editor.view, {
      insertText: 'APOTHECARY',
      matchedLength: 2,
      pos: editor.state.selection.from,
      text: 'OTHECARY',
    });
    expect(renderedGhost(mount)).toBe('OTHECARY');

    overrideSmartTypeGhost(editor.view, undefined);

    expect(renderedGhost(mount)).toBe('ARTMENT');

    editor.destroy();
    mount.remove();
  });
});

import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import {
  createLocalScreenplayEditorInit,
  type EditorContent,
  type ScreenplayElementType,
} from './screenplayEditor.js';
import {
  FindReplaceExtension,
  clearFindReplace,
  findMatches,
  findReplaceNext,
  findReplacePluginKey,
  findReplacePrevious,
  findReplaceQuerySeed,
  replaceAllMatches,
  replaceCurrentMatch,
  setFindReplaceQuery,
} from './findReplace.js';

/**
 * Drives a real editor -- real schema, real `screenplayBlock` ids, a real local `Y.Doc` and the
 * real `yUndoPlugin` `createLocalScreenplayEditorInit` wires in (confirmed directly:
 * `packages/screenplay-editor/src/index.test.ts`'s own "undo/redo (ScreenplayYjsExtension...)"
 * describe block proves `editor.can().undo()`/`.commands.undo()` work against exactly this kind of
 * editor, with no network provider involved) -- rather than calling this module's own functions
 * with hand-made arguments. Every claim this feature makes is about a document: what highlights,
 * what a replace actually writes, whether a block keeps its id, and whether one Undo reverses one
 * replace or forty. A helper fed synthetic positions could satisfy all of that and still be wrong
 * about where a real `screenplayBlock`'s content actually starts.
 *
 * What jsdom cannot answer -- highlight *position*, scroll-into-view, and anything colour-dependent
 * -- is covered in a real browser instead: `apps/web/e2e/find-replace-persistence.spec.ts` and the
 * new cases in `apps/web/e2e/text-contrast.spec.ts`.
 */

type Block = { element: ScreenplayElementType; text: string };

/** A real, schema-valid stable id per block -- see `smartTypeGhost.test.ts`'s identical helper for
 * why a `block-0`-style id is not good enough here either: `projectDocumentScreenplay`'s
 * `stableIdSchema` is `z.string().uuid()`, and the block-id-stability tests below need the real
 * projection to accept the document in order to read ids back out of it meaningfully. */
function blockId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function editorInitFor(content: EditorContent) {
  const seeded = createLocalScreenplayEditorInit(content);
  return { content: seeded.content, extensions: [...seeded.extensions, FindReplaceExtension] };
}

function buildEditor(blocks: readonly Block[]) {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({
    element: mount,
    ...editorInitFor({
      type: 'screenplayDocument' as const,
      content: blocks.map((block, index) => ({
        type: 'screenplayBlock' as const,
        attrs: { element: block.element, id: blockId(index) },
        ...(block.text === '' ? {} : { content: [{ type: 'text', text: block.text }] }),
      })),
    }),
  });
  return { editor, mount };
}

function blockIds(editor: Editor): readonly string[] {
  const ids: string[] = [];
  editor.state.doc.forEach((node) => ids.push(node.attrs.id as string));
  return ids;
}

function blockTexts(editor: Editor): readonly string[] {
  const texts: string[] = [];
  editor.state.doc.forEach((node) => texts.push(node.textContent));
  return texts;
}

function state(editor: Editor) {
  const found = findReplacePluginKey.getState(editor.state);
  if (!found) throw new Error('findReplace plugin is not installed on this editor.');
  return found;
}

describe('findMatches', () => {
  it('finds every non-overlapping occurrence within one block, case-insensitively by default', () => {
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'The cat sat. The CAT ran. catalog is not cat, but contains it.' },
    ]);
    const matches = findMatches(editor.state.doc, 'cat', false);
    // "cat" / "CAT" / the "cat" inside "catalog" / the standalone "cat" -- four, including the one
    // inside a longer word, which is correct for a plain substring search with no whole-word option
    // (the brief's own scope: "no regex, no whole-word").
    expect(matches).toHaveLength(4);
    editor.destroy();
    mount.remove();
  });

  it('is case-sensitive when asked', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'Cat cat CAT cat' }]);
    // "Cat cat CAT cat": only the two lowercase "cat"s match case-sensitively.
    expect(findMatches(editor.state.doc, 'cat', true)).toHaveLength(2);
    expect(findMatches(editor.state.doc, 'Cat', true)).toHaveLength(1);
    editor.destroy();
    mount.remove();
  });

  it('never matches across a block boundary, even when the two blocks read as one word split in half', () => {
    // Block 0 ends in "CU", block 1 starts with "T TO:" -- "CUT TO:" would match if blocks were
    // joined by anything other than a boundary this function refuses to cross.
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'Ends in CU' },
      { element: 'transition', text: 'T TO:' },
    ]);
    expect(findMatches(editor.state.doc, 'CUT TO:', false)).toHaveLength(0);
    editor.destroy();
    mount.remove();
  });

  it('answers [] for an empty query without walking the document', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'anything at all' }]);
    expect(findMatches(editor.state.doc, '', false)).toEqual([]);
    editor.destroy();
    mount.remove();
  });
});

describe('the plugin: search, count, and the current match', () => {
  it('highlights every match and distinguishes the current one, in the real rendered DOM', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'cat sat on the cat mat' }]);
    setFindReplaceQuery(editor.view, 'cat', false);

    expect(state(editor).matches).toHaveLength(2);
    expect(state(editor).currentIndex).toBe(0);
    // Read back through the real rendered DOM, not the decoration's own internal shape: this is
    // what the writer actually sees, and what `findReplaceBar.tsx`'s own scroll-into-view queries
    // (`.find-match-current`) depend on existing.
    const all = mount.querySelectorAll('.find-match');
    const current = mount.querySelectorAll('.find-match-current');
    expect(all).toHaveLength(2);
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe('cat');
    expect(all[0]).toBe(current[0]); // the first match is the current one
    editor.destroy();
    mount.remove();
  });

  it('lands on the match nearest the caret, not always the first', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'cat sat on the cat mat' }]);
    // Doc position 10 lands inside "on", strictly after the first "cat" (ends at doc position 4)
    // and strictly before the second (starts at doc position 16) -- the nearest-forward match
    // from there is the second one.
    editor.commands.setTextSelection(10);
    setFindReplaceQuery(editor.view, 'cat', false);
    expect(state(editor).currentIndex).toBe(1);
    editor.destroy();
    mount.remove();
  });

  it('cycles next/previous with wraparound', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'one two one two one' }]);
    setFindReplaceQuery(editor.view, 'one', false);
    expect(state(editor).currentIndex).toBe(0);

    findReplaceNext(editor.view);
    expect(state(editor).currentIndex).toBe(1);
    findReplaceNext(editor.view);
    expect(state(editor).currentIndex).toBe(2);
    findReplaceNext(editor.view);
    expect(state(editor).currentIndex).toBe(0); // wraps forward

    findReplacePrevious(editor.view);
    expect(state(editor).currentIndex).toBe(2); // wraps backward
    editor.destroy();
    mount.remove();
  });

  it('findReplacePrevious (and findReplaceNext) are no-ops with no matches', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'nothing to find here' }]);
    setFindReplaceQuery(editor.view, 'xyz', false);
    expect(state(editor).matches).toHaveLength(0);

    findReplacePrevious(editor.view);
    expect(state(editor).currentIndex).toBe(-1);
    findReplaceNext(editor.view);
    expect(state(editor).currentIndex).toBe(-1);
    editor.destroy();
    mount.remove();
  });

  it('clears the query, the matches and every highlight on close', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'cat cat cat' }]);
    setFindReplaceQuery(editor.view, 'cat', false);
    expect(state(editor).matches).toHaveLength(3);

    clearFindReplace(editor.view);
    const cleared = state(editor);
    expect(cleared.matches).toEqual([]);
    expect(cleared.currentIndex).toBe(-1);
    expect(cleared.decorations.find()).toEqual([]);
    editor.destroy();
    mount.remove();
  });

  it('follows the current match across an unrelated edit elsewhere in the document', () => {
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'padding' },
      { element: 'action', text: 'findme' },
    ]);
    setFindReplaceQuery(editor.view, 'findme', false);
    expect(state(editor).matches).toHaveLength(1);
    const before = state(editor).matches[0]!;

    // Lengthen block 0, which is entirely before the match -- an ordinary edit this module did
    // not perform itself, carrying no findReplace meta at all.
    editor.view.dispatch(editor.state.tr.insertText('XXXXX', 1, 1));

    const after = state(editor);
    expect(after.matches).toHaveLength(1);
    expect(after.currentIndex).toBe(0);
    expect(after.matches[0]!.from).toBe(before.from + 5);
    editor.destroy();
    mount.remove();
  });
});

describe('replaceCurrentMatch', () => {
  it('is a no-op, returning false, with no current match', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'no cats here' }]);
    setFindReplaceQuery(editor.view, 'dog', false);
    expect(replaceCurrentMatch(editor, 'cat')).toBe(false);
    expect(blockTexts(editor)).toEqual(['no cats here']);
    editor.destroy();
    mount.remove();
  });

  it('replaces only the matched text, leaving the surrounding text exactly as it was', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'A cat sat on the mat.' }]);
    setFindReplaceQuery(editor.view, 'cat', false);
    expect(replaceCurrentMatch(editor, 'dog')).toBe(true);
    expect(blockTexts(editor)).toEqual(['A dog sat on the mat.']);
    editor.destroy();
    mount.remove();
  });

  it('does not reissue the block id -- a replace is not a paste', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'A cat sat.' }]);
    const before = blockIds(editor);
    setFindReplaceQuery(editor.view, 'cat', false);
    replaceCurrentMatch(editor, 'dog');
    expect(blockIds(editor)).toEqual(before);
    editor.destroy();
    mount.remove();
  });

  it('advances the current match to the next one after replacing, wrapping at the end', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'cat cat cat' }]);
    setFindReplaceQuery(editor.view, 'cat', false);
    expect(state(editor).currentIndex).toBe(0);

    replaceCurrentMatch(editor, 'dog');
    // One "cat" became "dog"; two "cat"s remain, and the current match is now the first of those
    // two (what used to be the second "cat").
    expect(state(editor).matches).toHaveLength(2);
    expect(state(editor).currentIndex).toBe(0);
    expect(blockTexts(editor)).toEqual(['dog cat cat']);

    replaceCurrentMatch(editor, 'dog');
    expect(state(editor).matches).toHaveLength(1);
    expect(state(editor).currentIndex).toBe(0);

    // Replacing the very last remaining match leaves nothing to advance to.
    replaceCurrentMatch(editor, 'dog');
    expect(state(editor).matches).toHaveLength(0);
    expect(state(editor).currentIndex).toBe(-1);
    expect(blockTexts(editor)).toEqual(['dog dog dog']);
    editor.destroy();
    mount.remove();
  });

  it("is a single undo step, and a second replace is a separate one -- the owner's explicit instruction, not coalesced", () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'cat cat' }]);
    setFindReplaceQuery(editor.view, 'cat', false);

    replaceCurrentMatch(editor, 'dog');
    expect(blockTexts(editor)).toEqual(['dog cat']);
    replaceCurrentMatch(editor, 'dog');
    expect(blockTexts(editor)).toEqual(['dog dog']);

    expect(editor.commands.undo()).toBe(true);
    expect(blockTexts(editor)).toEqual(['dog cat']); // only the second replace was undone
    expect(editor.commands.undo()).toBe(true);
    expect(blockTexts(editor)).toEqual(['cat cat']); // now the first is undone too
    editor.destroy();
    mount.remove();
  });
});

/**
 * The owner's own addendum, verified as one sequence rather than four isolated operations -- a
 * per-operation test would not catch an advance-and-count bug, which only shows up across a
 * sequence (the addendum's own words).
 */
describe('a replace/skip sequence walks forward exactly as a writer would expect', () => {
  it('replaces the 1st and 2nd, skips the 3rd via Find next, then replaces the 4th', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'foo foo foo foo' }]);
    setFindReplaceQuery(editor.view, 'foo', false);
    expect(state(editor).matches).toHaveLength(4);
    expect(state(editor).currentIndex).toBe(0);

    replaceCurrentMatch(editor, 'bar'); // 1st -> bar
    expect(blockTexts(editor)).toEqual(['bar foo foo foo']);
    expect(state(editor).currentIndex).toBe(0); // now sitting on the (former 2nd) first remaining match

    replaceCurrentMatch(editor, 'bar'); // 2nd -> bar
    expect(blockTexts(editor)).toEqual(['bar bar foo foo']);
    expect(state(editor).currentIndex).toBe(0);

    findReplaceNext(editor.view); // skip the 3rd
    expect(state(editor).matches).toHaveLength(2);
    expect(state(editor).currentIndex).toBe(1); // now sitting on the 4th (last) remaining match

    replaceCurrentMatch(editor, 'bar'); // 4th -> bar
    expect(blockTexts(editor)).toEqual(['bar bar foo bar']);
    // Only the 3rd "foo" (deliberately skipped) survives.
    expect(state(editor).matches).toHaveLength(1);
    editor.destroy();
    mount.remove();
  });

  /*
   * Replacing a match in the *middle* of the document, which is the only case that distinguishes
   * "advance to the next match" from "settle on the first remaining one".
   *
   * Every other sequence test here replaces from the start, where the match after the one just
   * replaced *is* the first remaining match -- so they pass whether the implementation resumes from
   * its own insertion point or just restarts at position 0. Confirmed by mutation: replacing the
   * resume anchor with a constant `0` left all 25 tests green. This test is what makes the anchor
   * load-bearing, and it fails under that mutation.
   */
  it('advances to the match after the one just replaced, not back to the first remaining match', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'foo foo foo foo' }]);
    setFindReplaceQuery(editor.view, 'foo', false);

    // Walk forward to the 3rd match without replacing anything.
    findReplaceNext(editor.view);
    findReplaceNext(editor.view);
    expect(state(editor).currentIndex).toBe(2);

    replaceCurrentMatch(editor, 'bar');
    expect(blockTexts(editor)).toEqual(['foo foo bar foo']);

    // Three matches remain (1st, 2nd, 4th). The current one must be the 4th -- index 2 -- because
    // that is what follows the replacement. Index 0 would mean the implementation restarted from
    // the top and silently undid the writer's own position in the document.
    expect(state(editor).matches).toHaveLength(3);
    expect(state(editor).currentIndex).toBe(2);

    // ...and continuing from there wraps to the 1st, rather than jumping somewhere arbitrary.
    findReplaceNext(editor.view);
    expect(state(editor).currentIndex).toBe(0);
    editor.destroy();
    mount.remove();
  });
});

describe('a replacement containing the search term is not immediately re-matched', () => {
  it('replacing "foo" with "foobar" does not grow the match count, but a later unrelated "foo" is still found and still replaceable', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'foo and foo again' }]);
    setFindReplaceQuery(editor.view, 'foo', false);
    expect(state(editor).matches).toHaveLength(2);

    replaceCurrentMatch(editor, 'foobar');
    // Not 2 (the self-match inside "foobar" counted as new) and not an infinite loop reachable at
    // all from this call -- exactly the one remaining, genuinely different occurrence.
    expect(state(editor).matches).toHaveLength(1);
    expect(blockTexts(editor)).toEqual(['foobar and foo again']);

    // The surviving match is a real, independent occurrence and is itself still replaceable.
    expect(replaceCurrentMatch(editor, 'baz')).toBe(true);
    expect(blockTexts(editor)).toEqual(['foobar and baz again']);
    expect(state(editor).matches).toHaveLength(0);
    editor.destroy();
    mount.remove();
  });

  it('a fresh search (closing and reopening Find) sees the self-matching text plainly, with no memory of the earlier replace', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'foo and foo again' }]);
    setFindReplaceQuery(editor.view, 'foo', false);
    replaceCurrentMatch(editor, 'foobar');
    clearFindReplace(editor.view);

    setFindReplaceQuery(editor.view, 'foo', false);
    // Both the "foo" inside "foobar" and the untouched "foo again" are ordinary matches now --
    // the exclusion is scoped to the search session that produced it, not a permanent mark.
    expect(state(editor).matches).toHaveLength(2);
    editor.destroy();
    mount.remove();
  });

  it('replace all does not loop or report leftover matches when the replacement re-introduces the search term', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'foo foo foo' }]);
    setFindReplaceQuery(editor.view, 'foo', false);
    const replaced = replaceAllMatches(editor, 'foobar');
    expect(replaced).toBe(3);
    expect(blockTexts(editor)).toEqual(['foobar foobar foobar']);
    expect(state(editor).matches).toHaveLength(0);
    editor.destroy();
    mount.remove();
  });
});

describe('replaceAllMatches', () => {
  it('replaces every match in document order, correctly, with a replacement LONGER than the query', () => {
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'a cat and a cat and a cat' },
    ]);
    setFindReplaceQuery(editor.view, 'cat', false);
    expect(replaceAllMatches(editor, 'kangaroo')).toBe(3);
    expect(blockTexts(editor)).toEqual(['a kangaroo and a kangaroo and a kangaroo']);
    editor.destroy();
    mount.remove();
  });

  it('replaces every match correctly with a replacement SHORTER than the query -- the case where a naive left-to-right apply would shift later matches', () => {
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'elephant and elephant and elephant' },
    ]);
    setFindReplaceQuery(editor.view, 'elephant', false);
    expect(replaceAllMatches(editor, 'cat')).toBe(3);
    expect(blockTexts(editor)).toEqual(['cat and cat and cat']);
    editor.destroy();
    mount.remove();
  });

  it('is isolated from an immediately preceding, unrelated edit -- undoing it does not also undo that edit', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'cat cat cat' }]);
    setFindReplaceQuery(editor.view, 'cat', false);
    editor.commands.focus('end');
    editor.commands.insertContent('Z');
    expect(blockTexts(editor)).toEqual(['cat cat catZ']);

    expect(replaceAllMatches(editor, 'dog')).toBe(3);
    expect(blockTexts(editor)).toEqual(['dog dog dogZ']);

    expect(editor.commands.undo()).toBe(true);
    // Only the replace-all batch is reversed -- the "Z" typed immediately before it, with no
    // real time elapsed between the two dispatches, must not be swallowed into the same undo
    // step `yUndoPlugin`'s own time-based grouping would otherwise produce.
    expect(blockTexts(editor)).toEqual(['cat cat catZ']);
    expect(editor.commands.undo()).toBe(true);
    expect(blockTexts(editor)).toEqual(['cat cat cat']);
    editor.destroy();
    mount.remove();
  });

  it('is exactly one undo step regardless of how many matches it replaced', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'cat cat cat cat cat' }]);
    setFindReplaceQuery(editor.view, 'cat', false);
    expect(replaceAllMatches(editor, 'dog')).toBe(5);
    expect(blockTexts(editor)).toEqual(['dog dog dog dog dog']);

    expect(editor.commands.undo()).toBe(true);
    expect(blockTexts(editor)).toEqual(['cat cat cat cat cat']);
    editor.destroy();
    mount.remove();
  });

  it('does not reissue any block id', () => {
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'cat one' },
      { element: 'action', text: 'cat two' },
    ]);
    const before = blockIds(editor);
    setFindReplaceQuery(editor.view, 'cat', false);
    replaceAllMatches(editor, 'dog');
    expect(blockIds(editor)).toEqual(before);
    editor.destroy();
    mount.remove();
  });

  it('is a no-op, dispatching nothing, with no active matches', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'no cats here' }]);
    setFindReplaceQuery(editor.view, 'dog', false);
    expect(replaceAllMatches(editor, 'cat')).toBe(0);
    expect(blockTexts(editor)).toEqual(['no cats here']);
    editor.destroy();
    mount.remove();
  });
});

describe('findReplaceQuerySeed: Mod-f seeds the query from the selection', () => {
  /*
   * The owner's own request: "when a user has something highlighted and hits command + f, it should
   * auto populate the find with the portion that was highlighted." These tests pin which selections
   * seed and which deliberately do not.
   */
  it('seeds the highlighted text when the selection is inside one block', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'MARA crosses the room.' }]);
    // "MARA" -- doc position 1 is the start of the first block's text.
    editor.commands.setTextSelection({ from: 1, to: 5 });
    expect(findReplaceQuerySeed(editor.state)).toBe('MARA');
    editor.destroy();
    mount.remove();
  });

  it('seeds nothing for a collapsed selection, leaving any existing query alone', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'MARA crosses the room.' }]);
    editor.commands.setTextSelection(3);
    expect(findReplaceQuerySeed(editor.state)).toBeUndefined();
    editor.destroy();
    mount.remove();
  });

  /*
   * The case that matters most, and the reason this is not simply `textBetween(from, to, '')`: a
   * match in this module never spans blocks, so seeding a cross-block selection would open the bar
   * with a query that cannot match by construction -- reporting "no results" for text the writer
   * can see is right there. Seeding nothing is the honest answer.
   */
  it('seeds nothing when the selection spans two blocks, which could never match anyway', () => {
    const { editor, mount } = buildEditor([
      { element: 'action', text: 'First line.' },
      { element: 'action', text: 'Second line.' },
    ]);
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    const seed = findReplaceQuerySeed(editor.state);
    // Guard against this passing for the wrong reason: the selection must really span both blocks.
    expect(editor.state.doc.textBetween(1, editor.state.doc.content.size - 1, '\n')).toContain(
      '\n',
    );
    expect(seed).toBeUndefined();
    editor.destroy();
    mount.remove();
  });

  it('does not trim the selection, because searching for whitespace is a legitimate thing to want', () => {
    const { editor, mount } = buildEditor([{ element: 'action', text: 'a  b' }]);
    editor.commands.setTextSelection({ from: 2, to: 4 });
    expect(findReplaceQuerySeed(editor.state)).toBe('  ');
    editor.destroy();
    mount.remove();
  });
});

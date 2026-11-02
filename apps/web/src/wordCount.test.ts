import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_SETTINGS, type Screenplay } from '@finaler-draft/screenplay';
import {
  editorContentFromScreenplay,
  getScreenplayEditorSchema,
  type LocalScreenplayProjection,
} from './screenplayEditor.js';
import {
  charactersInProjection,
  countWords,
  countWordsAndCharactersInRange,
  wordsInProjection,
} from './wordCount.js';

// A plain text-block screenplay -- no title page, no annotations, no dual dialogue or page
// breaks -- so `editorContentFromScreenplay` accepts it and this fixture can drive both the
// projection-based counters (which take a `Screenplay` directly) and the ProseMirror-doc-based
// range counter (which needs a real editor document built from the identical blocks). That
// shared starting point is what lets the whole-document invariant test below mean anything: if
// the two counters were fed two different screenplays, agreeing would prove nothing.
const multiBlockScreenplay: Screenplay = {
  schemaVersion: 1,
  id: '11112222-0000-4000-8000-000000000001',
  title: 'Word Count Fixture',
  documentSettings: DEFAULT_DOCUMENT_SETTINGS,
  titlePages: [],
  annotations: [],
  blocks: [
    {
      id: '11112222-0000-4000-8000-000000000002',
      type: 'scene_heading',
      text: 'INT. APARTMENT - MORNING',
    },
    {
      id: '11112222-0000-4000-8000-000000000003',
      type: 'action',
      text: '  Sunlight settles across a drafting table.  ',
    },
    {
      id: '11112222-0000-4000-8000-000000000004',
      type: 'character',
      text: 'MARA',
    },
    {
      id: '11112222-0000-4000-8000-000000000005',
      type: 'dialogue',
      text: 'If the ending is true, it has to earn its way there.',
    },
    // An empty block contributes no words and no characters in either counter -- proven
    // explicitly rather than left to accident, since it is the one block shape with no text
    // node in the ProseMirror doc at all (`editorContentFromScreenplay`'s own `{}`-for-empty
    // convention, `packages/screenplay-editor`'s `index.ts`).
    {
      id: '11112222-0000-4000-8000-000000000006',
      type: 'action',
      text: '',
    },
  ],
};

function projectionOf(screenplay: Screenplay): LocalScreenplayProjection {
  return { screenplay, valid: true };
}

describe('countWords', () => {
  it('counts zero words for an empty or whitespace-only string', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t  ')).toBe(0);
  });

  it('counts a single word with no surrounding whitespace', () => {
    expect(countWords('Hello')).toBe(1);
  });

  it('splits on runs of whitespace, including newlines and tabs, collapsing consecutive runs', () => {
    expect(countWords('Hello world')).toBe(2);
    expect(countWords('Hello   world')).toBe(2);
    expect(countWords('Hello\nworld')).toBe(2);
    expect(countWords('Hello\n\n\tworld')).toBe(2);
  });

  /*
   * The owner's word count read 2781 against Word's 2790 on the same text. Three of that gap were
   * standalone hyphens counted here as words; the rest were URL and `.env` strings this tokenizer
   * keeps whole and Word splits on `/` and `:` -- an artifact of that particular test document, and
   * deliberately not chased. These cases pin the part that was a real defect.
   */
  it('does not count a standalone dash as a word, in any of its forms', () => {
    expect(countWords('He turned - she was gone.')).toBe(5);
    expect(countWords('He turned -- she was gone.')).toBe(5);
    expect(countWords('He turned \u2014 she was gone.')).toBe(5);
    expect(countWords('-')).toBe(0);
    expect(countWords('--- \u2014 \u2013')).toBe(0);
  });

  it('treats an em dash, en dash or double hyphen as separating two words even when unspaced', () => {
    expect(countWords('He turned\u2014she was gone.')).toBe(5);
    expect(countWords('He turned\u2013she was gone.')).toBe(5);
    expect(countWords('He turned--she was gone.')).toBe(5);
    // The interruption at the end of a line: the trailing run separates nothing and adds no word.
    expect(countWords('I was going to say--')).toBe(5);
  });

  it('keeps a single hyphen between word characters as one joined word', () => {
    expect(countWords('Spider-Man')).toBe(1);
    expect(countWords('A mother-in-law problem.')).toBe(3);
    expect(countWords('The same-origin policy.')).toBe(3);
  });

  /*
   * The boundary of the rule above, pinned deliberately: only *dash* tokens are excluded. A broader
   * "no letter or digit" filter was built first and measured 19 further removals on the owner's own
   * test screenplay -- `#` markers and divider lines from pasted configuration -- which moved the
   * total away from Word rather than toward it, on content no screenplay contains. Whether a lone
   * `...` standing as a beat of dialogue is a word is a separate question about prose, and is not
   * being decided here.
   */
  it('still counts a non-dash punctuation token, keeping the exclusion narrow', () => {
    expect(countWords('Well ... maybe not.')).toBe(4);
    expect(countWords('...')).toBe(1);
    // Punctuation attached to a real word never cost that word its place either way.
    expect(countWords('Well... maybe not.')).toBe(3);
  });

  it('ignores leading and trailing whitespace', () => {
    expect(countWords('  Hello world  ')).toBe(2);
  });
});

describe('wordsInProjection', () => {
  it('reports zero for an invalid projection', () => {
    expect(wordsInProjection({ issues: ['broken'], valid: false })).toBe(0);
  });

  it('sums every text block, skipping empty ones, matching countWords block by block', () => {
    /*
     * 3 ("INT. APARTMENT - MORNING") + 6 ("Sunlight settles across a drafting table.") +
     * 1 ("MARA") + 12 ("If the ending is true, it has to earn its way there.") + 0 (empty) = 22
     *
     * The scene heading contributes 3, not 4: its " - " is the standard `INT. PLACE - TIME`
     * separator, and a standalone dash is not a word (`countWords`). This is worth stating because
     * it is not a one-off -- essentially every scene heading in every screenplay carries that
     * separator, so this rule lowers a real script's count by one per heading, which is exactly
     * where 3 of the 9 words the owner measured against Word came from.
     */
    expect(wordsInProjection(projectionOf(multiBlockScreenplay))).toBe(22);
  });

  it('skips page_break and dual_dialogue blocks, which carry no text field at all', () => {
    const withUncountableBlocks: Screenplay = {
      ...multiBlockScreenplay,
      blocks: [
        ...multiBlockScreenplay.blocks,
        { id: '11112222-0000-4000-8000-000000000007', type: 'page_break' },
        {
          id: '11112222-0000-4000-8000-000000000008',
          type: 'dual_dialogue',
          left: {
            id: '11112222-0000-4000-8000-000000000009',
            blocks: [
              { id: '11112222-0000-4000-8000-00000000000a', type: 'character', text: 'ADA' },
              {
                id: '11112222-0000-4000-8000-00000000000b',
                type: 'dialogue',
                text: 'This would add four more words if counted.',
              },
            ],
          },
          right: {
            id: '11112222-0000-4000-8000-00000000000c',
            blocks: [
              { id: '11112222-0000-4000-8000-00000000000d', type: 'character', text: 'MILES' },
              {
                id: '11112222-0000-4000-8000-00000000000e',
                type: 'dialogue',
                text: 'So would this.',
              },
            ],
          },
        },
      ],
    };

    expect(wordsInProjection(projectionOf(withUncountableBlocks))).toBe(22);
  });
});

describe('charactersInProjection', () => {
  it('reports zero for an invalid projection', () => {
    expect(charactersInProjection({ issues: ['broken'], valid: false })).toBe(0);
  });

  it('sums each block’s raw text length, not trimmed, matching the literal content', () => {
    const total = multiBlockScreenplay.blocks.reduce((sum, block) => {
      return block.type === 'page_break' || block.type === 'dual_dialogue'
        ? sum
        : sum + block.text.length;
    }, 0);
    expect(charactersInProjection(projectionOf(multiBlockScreenplay))).toBe(total);
  });
});

describe('countWordsAndCharactersInRange', () => {
  const schema = getScreenplayEditorSchema();
  const { body } = editorContentFromScreenplay(multiBlockScreenplay);
  const doc = schema.nodeFromJSON(body);

  it('counts a range within a single block', () => {
    // The dialogue block's text starts partway through the document; rather than hand-computing
    // its position, resolve it the same way the rest of this app would -- by finding the block
    // and reading its content range directly off the doc.
    const dialogueBlock = doc.content.content.find(
      (node) => node.textContent === 'If the ending is true, it has to earn its way there.',
    );
    expect(dialogueBlock).toBeDefined();
    // `from`: the sum of every preceding top-level node's own size, plus one to step inside the
    // dialogue block itself (past its own opening token).
    let position = 0;
    for (const node of doc.content.content) {
      if (node === dialogueBlock) break;
      position += node.nodeSize;
    }
    const rangeFrom = position + 1;
    const rangeTo = rangeFrom + 'If the ending is true,'.length;

    const result = countWordsAndCharactersInRange(doc, rangeFrom, rangeTo);
    expect(result).toEqual({ characters: 'If the ending is true,'.length, words: 5 });
  });

  /**
   * The invariant this whole module exists to pin: a selection spanning the entire document must
   * count exactly as many words, and exactly as many characters, as the document-total counters
   * above report for that same screenplay. If `countWordsAndCharactersInRange` and
   * `wordsInProjection`/`charactersInProjection` ever used two different splitting rules, this
   * is the test that would catch it -- the status bar's word count and the Word count dialog's
   * document total both trace back to `wordsInProjection`, and the dialog's selection count
   * traces back to `countWordsAndCharactersInRange`; this is the proof those two paths cannot
   * silently disagree.
   */
  it('counting the whole document equals the document totals wordsInProjection/charactersInProjection report', () => {
    const whole = countWordsAndCharactersInRange(doc, 0, doc.content.size);
    expect(whole.words).toBe(wordsInProjection(projectionOf(multiBlockScreenplay)));
    expect(whole.characters).toBe(charactersInProjection(projectionOf(multiBlockScreenplay)));
  });
});

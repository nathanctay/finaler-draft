import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  SCREENPLAY_SCHEMA_VERSION,
  createDefaultTitlePage,
  parseScreenplay,
  type DocumentSettings,
  type Screenplay,
  type ScreenplayBlock,
  type TitlePage,
} from '@finaler-draft/screenplay';
import {
  convertActiveScreenplayBlock,
  editorContentFromScreenplay,
  projectDocumentScreenplay,
  screenplayElementTypes,
  screenplayExtensions,
  type EditorContent,
  type ScreenplayElementType,
} from './screenplayEditor.js';

/**
 * plan.md ("Phase 1 -- Canonical screenplay authoring" and the "Immediate next action" section):
 * "A canonical round-trip test asserting that screenplay to editor projection and back is the
 * identity function. This becomes load-bearing once FDX import exists." Today every screenplay in
 * the system was authored in this editor, so anything the editor cannot represent simply never
 * exists; FDX import will produce canonical screenplays this editor has never had to handle, and
 * the first edit after an import would silently discard whatever the projection drops. This file
 * is the only thing standing between that future import feature and quiet data loss.
 *
 * The two functions under test, `editorContentFromScreenplay` (canonical -> editor) and
 * `projectDocumentScreenplay` (editor -> canonical), are exercised through a *real* Tiptap
 * `Editor` instance rather than by calling either half in isolation: the editor document is what
 * actually carries a screenplay between the two functions in the running app (see `App.tsx`'s
 * `editorContentFromScreenplay(initial.screenplay)` / `projectLocalScreenplay(editor, ...)` call
 * sites), and a real ProseMirror document is the only thing that can prove attributes genuinely
 * survive `Node.fromJSON` and a doc walk rather than merely surviving a plain-object round trip.
 *
 * Every identity assertion below compares the *whole* projected `Screenplay` against the whole
 * input with `toEqual` -- never a subset of fields -- because comparing selected fields is exactly
 * how a dropped, unlisted field would pass silently and make the test worthless.
 */

/**
 * Deterministic, monotonically increasing stable ids, formatted as valid (v4-shaped) UUIDs so
 * `stableIdSchema` (`z.string().uuid()`) accepts them. A single counter shared across the whole
 * file guarantees every id used within any one generated screenplay is unique, which
 * `screenplaySchema`'s own uniqueness check requires -- no coordination between test cases needed
 * beyond calling this function once per id.
 */
let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, '0')}`;
}

/** Mounts a real Tiptap editor on a detached DOM node, matching the pattern `screenplayEditor.test.ts` uses. */
function buildEditorFromContent(content: EditorContent): { editor: Editor; mount: HTMLElement } {
  const mount = document.createElement('div');
  document.body.append(mount);
  const editor = new Editor({ content, element: mount, extensions: screenplayExtensions });
  return { editor, mount };
}

/**
 * Projects `screenplay` into the editor and back, then asserts the result equals the input
 * exactly -- the identity property this whole file exists to prove. `titlePages` and
 * `documentSettings` never pass through the ProseMirror document at all: both live outside it (see
 * `screenplayEditor.ts`'s `projectDocumentScreenplay` comment), and this helper re-supplies them
 * from `screenplay` on the way back, matching how `App.tsx`'s call sites do it. So the
 * `documentSettings`/`titlePages` cases below do not prove the *editor* preserves either one --
 * neither the editor document nor `screenplayExtensions` ever holds them -- they prove
 * `editorContentFromScreenplay` passes a title page through intact, and `projectDocumentScreenplay`
 * honours whatever `documentSettings` it is handed rather than silently substituting the schema
 * default, which is the real, previously-broken behaviour increment 4 fixed (same function,
 * `progress/title-page-and-document-settings.md`). What genuinely round-trips *through the
 * document* is `blocks`, including the `sceneNumber` case below.
 */
function expectRoundTripsIdentically(screenplay: Screenplay): void {
  const projected = editorContentFromScreenplay(screenplay);
  const { editor, mount } = buildEditorFromContent(projected.body);
  try {
    const result = projectDocumentScreenplay(editor.state.doc, {
      id: screenplay.id,
      title: screenplay.title,
      titlePages: projected.titlePage ? [projected.titlePage] : [],
      documentSettings: screenplay.documentSettings,
    });
    if (!result.valid) {
      throw new Error(`Projection back to canonical form failed: ${result.issues.join('; ')}`);
    }
    expect(result.screenplay).toEqual(screenplay);
  } finally {
    editor.destroy();
    mount.remove();
  }
}

function screenplayWithBlocks(
  blocks: readonly ScreenplayBlock[],
  overrides: Partial<Pick<Screenplay, 'documentSettings' | 'title' | 'titlePages'>> = {},
): Screenplay {
  return parseScreenplay({
    schemaVersion: SCREENPLAY_SCHEMA_VERSION,
    id: nextId(),
    title: overrides.title ?? 'Round Trip Fixture',
    documentSettings: overrides.documentSettings ?? DEFAULT_DOCUMENT_SETTINGS,
    titlePages: overrides.titlePages ?? [],
    blocks,
    annotations: [],
  }) as Screenplay;
}

/**
 * Text samples the generator crosses against every block type. Covers, per this scope's
 * requirements: empty text, plain non-empty text, leading/trailing/interior whitespace that must
 * survive byte-for-byte (plan.md: authored text is never normalised), a combining sequence, a
 * surrogate-pair emoji, and a multi-code-point ZWJ emoji sequence -- non-ASCII, multi-code-unit
 * text of the kind `packages/layout`'s ASCII fast path assumes will not appear, even though layout
 * itself is out of this scope.
 */
const TEXT_SAMPLES: readonly { name: string; text: string }[] = [
  { name: 'empty', text: '' },
  { name: 'simple', text: 'Simple text.' },
  { name: 'leading whitespace', text: '   Leads with three spaces.' },
  { name: 'trailing whitespace', text: 'Trails with three spaces.   ' },
  { name: 'interior whitespace', text: 'Has   extra   interior   spaces.' },
  { name: 'combining sequence', text: 'Café, spelled with a combining acute accent.' },
  {
    name: 'surrogate-pair emoji',
    text: 'The director calls action \u{1F3AC} and the take begins.',
  },
  {
    name: 'ZWJ emoji sequence',
    text: 'A family \u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466} arrives at the door.',
  },
];

const SCENE_NUMBER_SAMPLES: readonly (string | undefined)[] = [undefined, '1', '25A'];

const NON_SCENE_HEADING_TYPES = screenplayElementTypes.filter(
  (type): type is Exclude<ScreenplayElementType, 'scene_heading'> => type !== 'scene_heading',
);

describe('canonical round trip: identity over every supported block type and text shape', () => {
  for (const elementType of NON_SCENE_HEADING_TYPES) {
    for (const sample of TEXT_SAMPLES) {
      it(`round-trips ${elementType} with ${sample.name} text`, () => {
        const block = { id: nextId(), type: elementType, text: sample.text } as ScreenplayBlock;
        expectRoundTripsIdentically(screenplayWithBlocks([block]));
      });
    }
  }

  /**
   * `scene_heading` is crossed against both text shape and `sceneNumber` presence/absence -- the
   * exact "block type x empty/non-empty x optional field present/absent" cell this scope's Point 4
   * calls out, and the one carrying the defect the lead already located: `sceneNumber` has nowhere
   * to live in `ScreenplayBlockNode`'s attributes and is dropped on the way back out.
   */
  for (const sample of TEXT_SAMPLES) {
    for (const sceneNumber of SCENE_NUMBER_SAMPLES) {
      it(`round-trips scene_heading with ${sample.name} text and sceneNumber ${
        sceneNumber ?? '(absent)'
      }`, () => {
        const block: ScreenplayBlock =
          sceneNumber === undefined
            ? { id: nextId(), type: 'scene_heading', text: sample.text }
            : { id: nextId(), type: 'scene_heading', text: sample.text, sceneNumber };
        expectRoundTripsIdentically(screenplayWithBlocks([block]));
      });
    }
  }
});

/** Places the caret inside the document's first (and, in these tests, only) block. */
function placeSelectionInFirstBlock(editor: Editor): void {
  const transaction = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1));
  editor.view.dispatch(transaction);
}

/**
 * The hazard the lead flagged when reviewing the `sceneNumber` fix above: `sceneNumber` is a
 * ProseMirror attribute of every `screenplayBlock` node, not only scene headings, because
 * attributes are declared per node *type* and there is one node type here. `convertActiveScreenplayBlock`
 * -- what the toolbar element selector and the Tab keyboard shortcut both call -- changes a block's
 * `element` via `setNodeMarkup` with an attrs object that only ever supplies `{ element, id }`.
 * Without `mapBlock`'s scene_heading-only gate (see that function's own comment), converting a
 * numbered scene heading to another element would carry `sceneNumber` onto a block type whose
 * canonical schema is `.strict()` with no such field, and `projectDocumentScreenplay` would fail
 * validation on every subsequent save -- a routine element change breaking the document. These
 * tests exercise the real keymap entry point (`convertActiveScreenplayBlock`), not `mapBlock` in
 * isolation, so they prove the whole path, not just the gate.
 */
describe('canonical round trip: sceneNumber and element conversion', () => {
  it('a numbered scene heading converted to another element type still projects validly, with no sceneNumber on the new block', () => {
    const screenplay = screenplayWithBlocks([
      { id: nextId(), type: 'scene_heading', text: 'INT. WORKSHOP - NIGHT', sceneNumber: '25A' },
    ]);
    const projected = editorContentFromScreenplay(screenplay);
    const { editor, mount } = buildEditorFromContent(projected.body);
    try {
      placeSelectionInFirstBlock(editor);
      expect(convertActiveScreenplayBlock(editor, 'action')).toBe(true);

      const result = projectDocumentScreenplay(editor.state.doc, {
        id: screenplay.id,
        title: screenplay.title,
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.screenplay.blocks).toEqual([
          { id: screenplay.blocks[0]?.id, type: 'action', text: 'INT. WORKSHOP - NIGHT' },
        ]);
      }
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  it('converting a numbered scene heading away and back does not resurrect the number', () => {
    const screenplay = screenplayWithBlocks([
      { id: nextId(), type: 'scene_heading', text: 'INT. WORKSHOP - NIGHT', sceneNumber: '25A' },
    ]);
    const projected = editorContentFromScreenplay(screenplay);
    const { editor, mount } = buildEditorFromContent(projected.body);
    try {
      placeSelectionInFirstBlock(editor);
      expect(convertActiveScreenplayBlock(editor, 'action')).toBe(true);
      placeSelectionInFirstBlock(editor);
      expect(convertActiveScreenplayBlock(editor, 'scene_heading')).toBe(true);

      const result = projectDocumentScreenplay(editor.state.doc, {
        id: screenplay.id,
        title: screenplay.title,
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        // No `sceneNumber` key: losing it on conversion is correct (the writer changed what the
        // block *is*), and silently restoring a stale production number would be worse than
        // dropping it -- see `ScreenplayBlockNode.addAttributes()`'s comment on `sceneNumber`.
        expect(result.screenplay.blocks).toEqual([
          { id: screenplay.blocks[0]?.id, type: 'scene_heading', text: 'INT. WORKSHOP - NIGHT' },
        ]);
      }
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  /**
   * The two tests above go through the real `convertActiveScreenplayBlock`, whose own
   * `setNodeMarkup({ element, id })` call already resets `sceneNumber` to its schema default on
   * conversion -- ProseMirror's attribute computation fills any attribute missing from a supplied
   * attrs object from the schema default, it does not merge with the node's previous attrs (see
   * `ScreenplayBlockNode.addAttributes()`'s comment). So neither of those tests ever actually
   * presents `mapBlock` with a non-scene_heading node whose `sceneNumber` attribute is truthy --
   * they cannot exercise `mapBlock`'s own scene_heading-only gate. This test constructs that state
   * directly, bypassing both `editorContentFromScreenplay` and `convertActiveScreenplayBlock`, so
   * the gate itself has a test that can actually fail if it is removed.
   */
  it("mapBlock never emits sceneNumber for a non-scene_heading block, even if the node's attrs carry one directly", () => {
    const { editor, mount } = buildEditorFromContent({
      type: 'screenplayDocument',
      content: [
        {
          type: 'screenplayBlock',
          attrs: { element: 'action', id: nextId(), sceneNumber: '7' },
          content: [{ type: 'text', text: 'A cluttered desk.' }],
        },
      ],
    });
    try {
      const blockId = editor.state.doc.firstChild?.attrs.id as string;
      const result = projectDocumentScreenplay(editor.state.doc);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.screenplay.blocks).toEqual([
          { id: blockId, type: 'action', text: 'A cluttered desk.' },
        ]);
      }
    } finally {
      editor.destroy();
      mount.remove();
    }
  });
});

const FULLY_POPULATED_TITLE_PAGE: TitlePage = {
  id: nextId(),
  title: 'THE LONG WAY HOME',
  authors: ['Morgan Vale', 'J. R. Ostrander'],
  credit: 'written by',
  source: 'based on a true story',
  draftDate: 'August 2026, third draft',
  contact: ['Morgan Vale', '555 Fictional Ave.', 'Burbank, CA 91506', 'morgan@example.test'],
};

/**
 * `titlePages` never enters the ProseMirror document (see `expectRoundTripsIdentically`'s own
 * comment), so what these three cases prove is narrower than "the editor preserves a title page":
 * `editorContentFromScreenplay` returns `screenplay.titlePages[0]` unchanged, and
 * `projectDocumentScreenplay` re-validates and re-emits whatever `TitlePage` it is handed without
 * dropping or rewriting a field -- true regardless of which fields are present, which is why an
 * empty title page, a defaults-only one, and a fully populated one are all exercised here rather
 * than just one representative shape.
 */
describe('canonical round trip: title pages', () => {
  it('round-trips a screenplay with no title page', () => {
    expectRoundTripsIdentically(
      screenplayWithBlocks([{ id: nextId(), type: 'action', text: 'An empty stage.' }], {
        titlePages: [],
      }),
    );
  });

  it('round-trips a screenplay whose title page has only the created-by-default fields', () => {
    const titlePage = createDefaultTitlePage(nextId(), 'The Long Way Home');
    expectRoundTripsIdentically(
      screenplayWithBlocks([{ id: nextId(), type: 'action', text: 'An empty stage.' }], {
        titlePages: [titlePage],
      }),
    );
  });

  it('round-trips a screenplay whose title page has every field populated', () => {
    expectRoundTripsIdentically(
      screenplayWithBlocks([{ id: nextId(), type: 'action', text: 'An empty stage.' }], {
        titlePages: [{ ...FULLY_POPULATED_TITLE_PAGE, id: nextId() }],
      }),
    );
  });
});

/**
 * Every field this schema allows to move away from its default, moved -- `documentSettingsSchema`
 * is `.strict()` with no optional fields, so a screenplay with real, non-default settings is the
 * only way to prove this. Like `titlePages`, `documentSettings` never passes through the
 * ProseMirror document (see `expectRoundTripsIdentically`'s comment), so this does not prove the
 * *editor* preserves it -- it proves `projectDocumentScreenplay` honours the `documentSettings` it
 * is handed rather than silently substituting the schema default, which is exactly the defect
 * increment 4 found and fixed in this same function (`progress/title-page-and-document-settings.md`);
 * a settings value that happened to equal the default would not have caught that regression. Bounds
 * taken from `documentSettingsSchema` itself (`packages/screenplay/src/index.ts`):
 * `characterIndentIn` and `parentheticalIndentIn` must stay within `[MARGIN_LEFT_IN,
 * MAX_ADJUSTABLE_INDENT_IN - room]`, and `parentheticalIndentIn + parentheticalWidthIn` must not
 * cross `MAX_ADJUSTABLE_INDENT_IN` (7.5 in).
 */
const NON_DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  characterIndentIn: 4.0,
  parentheticalIndentIn: 3.4,
  parentheticalWidthIn: 2.5,
  pageNumberStyle: 'roman',
  sceneNumbersEnabled: true,
  autoMoreContinued: false,
};

describe('canonical round trip: document settings', () => {
  it('round-trips a screenplay with non-default document settings', () => {
    expectRoundTripsIdentically(
      screenplayWithBlocks([{ id: nextId(), type: 'action', text: 'An empty stage.' }], {
        documentSettings: NON_DEFAULT_DOCUMENT_SETTINGS,
      }),
    );
  });
});

describe('canonical round trip: a full composite document', () => {
  it('round-trips every block type, a fully populated title page, and non-default document settings together', () => {
    const screenplay = screenplayWithBlocks(
      [
        { id: nextId(), type: 'scene_heading', text: 'INT. WORKSHOP - NIGHT', sceneNumber: '1' },
        { id: nextId(), type: 'action', text: '   A cluttered desk, papers everywhere.   ' },
        { id: nextId(), type: 'character', text: 'MARA' },
        { id: nextId(), type: 'parenthetical', text: '(to herself)' },
        {
          id: nextId(),
          type: 'dialogue',
          text: 'One more page and it earns its ending. ☕ \u{1F3AC}',
        },
        { id: nextId(), type: 'transition', text: 'CUT TO:' },
        { id: nextId(), type: 'scene_heading', text: 'EXT. UNION STATION - CONTINUOUS' },
        { id: nextId(), type: 'shot', text: 'CLOSE ON the clock, hands frozen at noon.' },
        { id: nextId(), type: 'action', text: '' },
      ],
      {
        titlePages: [{ ...FULLY_POPULATED_TITLE_PAGE, id: nextId() }],
        documentSettings: NON_DEFAULT_DOCUMENT_SETTINGS,
        title: 'The Long Way Home',
      },
    );
    expectRoundTripsIdentically(screenplay);
  });
});

/**
 * `editorContentFromScreenplay`'s companion guarantee to the identity property above: for a
 * canonical feature this text-block editor genuinely cannot represent, it must throw rather than
 * silently drop the feature and project a truncated document. Point 2 of this scope requires this
 * be proven, not assumed -- a future change that turned one of these refusals into silent
 * truncation would be exactly the failure mode a round-trip test exists to prevent, and nothing
 * above would catch it, since none of those cases reach `editorContentFromScreenplay` at all.
 */
describe('canonical round trip: fail-closed on unrepresentable features', () => {
  const REFUSAL_MESSAGE =
    'This screenplay contains features that are not editable in the text-block editor.';

  it('refuses a screenplay with more than one title page', () => {
    const screenplay = screenplayWithBlocks(
      [{ id: nextId(), type: 'action', text: 'An empty stage.' }],
      {
        titlePages: [
          { id: nextId(), title: 'Draft One' },
          { id: nextId(), title: 'Draft Two' },
        ],
      },
    );
    expect(() => editorContentFromScreenplay(screenplay)).toThrow(REFUSAL_MESSAGE);
  });

  it('refuses a screenplay containing an annotation', () => {
    const blockId = nextId();
    const screenplay = parseScreenplay({
      schemaVersion: SCREENPLAY_SCHEMA_VERSION,
      id: nextId(),
      title: 'Fail Closed - Annotation',
      documentSettings: DEFAULT_DOCUMENT_SETTINGS,
      titlePages: [],
      blocks: [{ id: blockId, type: 'action', text: 'Some text to anchor a note to.' }],
      annotations: [
        {
          id: nextId(),
          type: 'note',
          text: 'Confirm this detail.',
          anchor: { blockId, startOffset: 0, endOffset: 4 },
        },
      ],
    }) as Screenplay;
    expect(() => editorContentFromScreenplay(screenplay)).toThrow(REFUSAL_MESSAGE);
  });

  it('refuses a screenplay containing a dual_dialogue block', () => {
    const screenplay = screenplayWithBlocks([
      {
        id: nextId(),
        type: 'dual_dialogue',
        left: {
          id: nextId(),
          blocks: [
            { id: nextId(), type: 'character', text: 'ADA' },
            { id: nextId(), type: 'dialogue', text: 'You made it.' },
          ],
        },
        right: {
          id: nextId(),
          blocks: [
            { id: nextId(), type: 'character', text: 'MILES' },
            { id: nextId(), type: 'dialogue', text: 'The train was late.' },
          ],
        },
      },
    ]);
    expect(() => editorContentFromScreenplay(screenplay)).toThrow(REFUSAL_MESSAGE);
  });

  it('refuses a screenplay containing a page_break block', () => {
    const screenplay = screenplayWithBlocks([{ id: nextId(), type: 'page_break' }]);
    expect(() => editorContentFromScreenplay(screenplay)).toThrow(REFUSAL_MESSAGE);
  });
});

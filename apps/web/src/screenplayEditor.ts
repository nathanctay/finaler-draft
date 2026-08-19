import { Node, type Editor } from '@tiptap/core';
import { History } from '@tiptap/extension-history';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  SCREENPLAY_SCHEMA_VERSION,
  safeParseScreenplay,
  type Screenplay,
  type ScreenplayBlock,
  type TitlePage,
} from '@finaler-draft/screenplay';

export const screenplayElementTypes = [
  'scene_heading',
  'action',
  'character',
  'dialogue',
  'parenthetical',
  'transition',
  'shot',
] as const;

export type ScreenplayElementType = (typeof screenplayElementTypes)[number];

export type ActiveScreenplayBlock = {
  element: ScreenplayElementType;
  id: string;
  nodeSize: number;
  position: number;
  text: string;
};

export type LocalScreenplayProjection =
  | { screenplay: Screenplay; valid: true }
  | { issues: readonly string[]; valid: false };

export type EditorContent = {
  content: Array<{
    attrs: { element: ScreenplayElementType; id: string };
    content?: Array<{ text: string; type: 'text' }>;
    type: 'screenplayBlock';
  }>;
  type: 'screenplayDocument';
};

const nextElementOnEnter: Record<ScreenplayElementType, ScreenplayElementType> = {
  scene_heading: 'action',
  action: 'action',
  character: 'dialogue',
  dialogue: 'action',
  parenthetical: 'dialogue',
  transition: 'scene_heading',
  shot: 'action',
};

export function isScreenplayElementType(value: unknown): value is ScreenplayElementType {
  return screenplayElementTypes.includes(value as ScreenplayElementType);
}

function createStableId(): string {
  return crypto.randomUUID();
}

function getActiveBlock(editor: Editor): ActiveScreenplayBlock | undefined {
  const { $from } = editor.state.selection;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'screenplayBlock' && isScreenplayElementType(node.attrs.element)) {
      return {
        element: node.attrs.element,
        id: node.attrs.id,
        nodeSize: node.nodeSize,
        position: $from.before(depth),
        text: node.textContent,
      };
    }
  }

  return undefined;
}

export function getActiveScreenplayBlock(editor: Editor): ActiveScreenplayBlock | undefined {
  return getActiveBlock(editor);
}

export function convertActiveScreenplayBlock(
  editor: Editor,
  element: ScreenplayElementType,
): boolean {
  const activeBlock = getActiveBlock(editor);
  if (!activeBlock) {
    return false;
  }

  const transaction = editor.state.tr.setNodeMarkup(activeBlock.position, undefined, {
    element,
    id: activeBlock.id,
  });
  editor.view.dispatch(transaction);
  return true;
}

/**
 * Splits the active block at the selection. The half before the split always keeps its own element;
 * what the half after it becomes depends on where the caret was.
 *
 * Enter at the **end** of a block is the writer starting the next element, so the new block takes
 * `elementWhenSplittingAtEnd` -- the screenplay convention that a character cue is followed by
 * dialogue, a transition by a scene heading, and so on. An empty block counts as being at its end,
 * so Enter on a blank line still advances.
 *
 * Enter **anywhere else** is the writer breaking one element in two, not starting a different one,
 * so both halves keep the original element. Previously the new half was always given the next
 * element in the convention, which meant splitting a paragraph of action mid-sentence silently
 * retyped the remainder as something else. Offset 0 counts as "anywhere else": it splits an empty
 * block off above and leaves the text where it was, and that text is still the element it was.
 */
function splitScreenplayBlock(
  editor: Editor,
  elementWhenSplittingAtEnd: ScreenplayElementType,
): boolean {
  const activeBlock = getActiveBlock(editor);
  if (!activeBlock) {
    return false;
  }

  const existingNode = editor.state.doc.nodeAt(activeBlock.position);
  if (!existingNode) {
    return false;
  }

  const blockContentStart = activeBlock.position + 1;
  const blockContentEnd = activeBlock.position + activeBlock.nodeSize - 1;
  if (
    editor.state.selection.from < blockContentStart ||
    editor.state.selection.to > blockContentEnd
  ) {
    return false;
  }

  const selectionStartOffset = Math.min(
    Math.max(editor.state.selection.from - blockContentStart, 0),
    activeBlock.text.length,
  );
  const selectionEndOffset = Math.min(
    Math.max(editor.state.selection.to - blockContentStart, selectionStartOffset),
    activeBlock.text.length,
  );
  const prefix = activeBlock.text.slice(0, selectionStartOffset);
  const suffix = activeBlock.text.slice(selectionEndOffset);
  const element =
    selectionEndOffset === activeBlock.text.length
      ? elementWhenSplittingAtEnd
      : activeBlock.element;
  const preservedBlock = existingNode.type.create(
    { element: activeBlock.element, id: activeBlock.id },
    prefix === '' ? undefined : editor.schema.text(prefix),
  );
  const newBlock = editor.schema.nodes.screenplayBlock?.create(
    {
      element,
      id: createStableId(),
    },
    suffix === '' ? undefined : editor.schema.text(suffix),
  );

  if (!newBlock) {
    return false;
  }

  const transaction = editor.state.tr.replaceWith(
    activeBlock.position,
    activeBlock.position + activeBlock.nodeSize,
    preservedBlock,
  );
  const insertionPosition = activeBlock.position + preservedBlock.nodeSize;
  transaction.insert(insertionPosition, newBlock);
  transaction.setSelection(TextSelection.create(transaction.doc, insertionPosition + 1));
  editor.view.dispatch(transaction);
  return true;
}

function mapBlock(node: {
  attrs: Record<string, unknown>;
  textContent: string;
}): ScreenplayBlock | undefined {
  const { element, id } = node.attrs;
  if (typeof id !== 'string' || !isScreenplayElementType(element)) {
    return undefined;
  }

  if (element === 'scene_heading') {
    return { id, type: element, text: node.textContent };
  }

  return { id, type: element, text: node.textContent };
}

/**
 * Projects a raw ProseMirror document into a canonical screenplay. Takes the document node
 * directly (not an `Editor`) so the pagination plugin (`paginationExtension.ts`) can call it from
 * inside a ProseMirror `Plugin`, which only ever has a `state`/`doc`, never an `Editor` instance.
 * `projectEditorScreenplay` below is a thin convenience wrapper over this for call sites that do
 * have an `Editor` on hand.
 *
 * `titlePages` defaults to `[]`, not because a title page is unsupported (it is now editable --
 * see `editorContentFromScreenplay` below), but because the title page lives in separate React
 * state, not in this ProseMirror document (see `titlePageEditor.tsx`'s own comment for why: it
 * never paginates and must stay structurally unable to). `paginationExtension.ts`'s call site
 * never passes a title page for exactly that reason -- pagination only ever needs `blocks`, and
 * passing `[]` there is not a loss, it is the correct input. `App.tsx`'s call site, which builds
 * the screenplay that actually gets saved, passes the real value from its own title-page state.
 */
export function projectDocumentScreenplay(
  doc: ProseMirrorNode,
  id = '7c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
  title = 'The Long Way Home',
  titlePages: TitlePage[] = [],
): LocalScreenplayProjection {
  const blocks: ScreenplayBlock[] = [];
  let unsupportedNode: string | undefined;

  doc.forEach((node) => {
    if (node.type.name !== 'screenplayBlock') {
      unsupportedNode ??= node.type.name;
      return;
    }

    const block = mapBlock(node);
    if (block) {
      blocks.push(block);
    } else {
      unsupportedNode ??= 'invalid screenplay block';
    }
  });

  if (unsupportedNode) {
    return { valid: false, issues: [`Unsupported local editor node: ${unsupportedNode}.`] };
  }

  const result = safeParseScreenplay({
    annotations: [],
    blocks,
    id,
    schemaVersion: SCREENPLAY_SCHEMA_VERSION,
    title,
    titlePages,
  });

  if (result.success) {
    return { screenplay: result.data, valid: true };
  }

  return {
    valid: false,
    issues: result.error.issues.map((issue: { message: string }) => issue.message),
  };
}

export function projectEditorScreenplay(
  editor: Editor,
  id = '7c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
  title = 'The Long Way Home',
  titlePages: TitlePage[] = [],
): LocalScreenplayProjection {
  return projectDocumentScreenplay(editor.state.doc, id, title, titlePages);
}

export const projectLocalScreenplay = projectEditorScreenplay;

export type ScreenplayEditorContent = {
  /** The single title page this screenplay has, if any -- see `editorContentFromScreenplay`. */
  titlePage: TitlePage | undefined;
  body: EditorContent;
};

/**
 * The text-block editor deliberately rejects canonical features it cannot faithfully preserve.
 * A single title page is no longer one of them: it round-trips through separate React state (see
 * `titlePageEditor.tsx`) rather than through this ProseMirror document, so it is returned
 * alongside the body content rather than folded into it. More than one title page still fails
 * closed -- this editor has no UI for a second one, and silently dropping it on save would not be
 * a faithful round trip.
 */
export function editorContentFromScreenplay(screenplay: Screenplay): ScreenplayEditorContent {
  if (
    screenplay.titlePages.length > 1 ||
    screenplay.annotations.length > 0 ||
    screenplay.blocks.some(
      (block: ScreenplayBlock) => block.type === 'dual_dialogue' || block.type === 'page_break',
    )
  ) {
    throw new Error(
      'This screenplay contains features that are not editable in the text-block editor.',
    );
  }
  return {
    titlePage: screenplay.titlePages[0],
    body: {
      type: 'screenplayDocument',
      content: screenplay.blocks.map((block: ScreenplayBlock) => {
        if (!isScreenplayElementType(block.type) || !('text' in block)) {
          throw new Error(`Unsupported screenplay block: ${block.type}.`);
        }
        return {
          type: 'screenplayBlock',
          attrs: { element: block.type, id: block.id },
          ...(block.text === '' ? {} : { content: [{ type: 'text' as const, text: block.text }] }),
        };
      }),
    },
  };
}

export function findScreenplayBlockPosition(editor: Editor, id: string): number | undefined {
  let position: number | undefined;
  editor.state.doc.descendants((node, currentPosition) => {
    if (node.type.name === 'screenplayBlock' && node.attrs.id === id) {
      position = currentPosition;
      return false;
    }
    return true;
  });
  return position;
}

export const ScreenplayDocument = Node.create({
  content: 'screenplayBlock*',
  name: 'screenplayDocument',
  topNode: true,
});

const ScreenplayText = Node.create({
  group: 'inline',
  name: 'text',
});

export const ScreenplayBlockNode = Node.create({
  addAttributes() {
    return {
      element: {
        default: 'action',
        parseHTML: (element) => element.getAttribute('data-screenplay-element'),
        renderHTML: (attributes) => ({ 'data-screenplay-element': attributes.element }),
      },
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-block-id'),
        renderHTML: (attributes) => ({ 'data-block-id': attributes.id }),
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const activeBlock = getActiveBlock(this.editor);
        if (activeBlock) {
          return splitScreenplayBlock(this.editor, nextElementOnEnter[activeBlock.element]);
        }

        if (this.editor.state.doc.childCount === 0) {
          const newBlock = this.editor.schema.nodes.screenplayBlock?.create({
            element: 'action',
            id: createStableId(),
          });
          if (!newBlock) {
            return false;
          }
          const transaction = this.editor.state.tr.insert(0, newBlock);
          transaction.setSelection(TextSelection.create(transaction.doc, 1));
          this.editor.view.dispatch(transaction);
          return true;
        }

        return false;
      },
      Tab: () => {
        const activeBlock = getActiveBlock(this.editor);
        if (!activeBlock) {
          return false;
        }

        if (activeBlock.element === 'action') {
          return convertActiveScreenplayBlock(this.editor, 'character');
        }
        if (activeBlock.element === 'dialogue') {
          return convertActiveScreenplayBlock(this.editor, 'parenthetical');
        }
        return false;
      },
    };
  },
  content: 'text*',
  defining: true,
  group: 'block',
  name: 'screenplayBlock',
  parseHTML() {
    return [{ tag: 'div[data-screenplay-block]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, 'data-screenplay-block': '' }, 0];
  },
});

export const screenplayExtensions = [
  ScreenplayDocument,
  ScreenplayBlockNode,
  ScreenplayText,
  History,
];

export const initialScreenplayContent = {
  content: [
    {
      attrs: { element: 'scene_heading', id: '2175a1b6-8d05-4e6e-bac7-e471e8df33a1' },
      content: [{ text: 'INT. APARTMENT - MORNING', type: 'text' }],
      type: 'screenplayBlock',
    },
    {
      attrs: { element: 'action', id: 'ba53c2dc-10a6-46d7-a409-9aabbff7cf5d' },
      content: [
        {
          text: 'Sunlight settles across a drafting table. MARA studies the last page of a script.',
          type: 'text',
        },
      ],
      type: 'screenplayBlock',
    },
    {
      attrs: { element: 'character', id: '5e4c810d-75d9-4b2e-a1a2-0f7cb30fd77b' },
      content: [{ text: 'MARA', type: 'text' }],
      type: 'screenplayBlock',
    },
    {
      attrs: { element: 'dialogue', id: '0f2b5f3c-6d17-4f18-8d95-90b06e93e13a' },
      content: [{ text: 'If the ending is true, it has to earn its way there.', type: 'text' }],
      type: 'screenplayBlock',
    },
    {
      attrs: { element: 'transition', id: 'd01faf47-64e7-4f7c-853a-3c6ace1464ad' },
      content: [{ text: 'CUT TO:', type: 'text' }],
      type: 'screenplayBlock',
    },
    {
      attrs: { element: 'scene_heading', id: '7e00a5b4-e629-42ea-98e7-705ff5ce46b1' },
      content: [{ text: 'EXT. UNION STATION - CONTINUOUS', type: 'text' }],
      type: 'screenplayBlock',
    },
    {
      attrs: { element: 'shot', id: 'b4f2a758-8f86-465e-9a9e-485612244317' },
      content: [{ text: 'CLOSE ON the arrival clock as it changes to noon.', type: 'text' }],
      type: 'screenplayBlock',
    },
  ],
  type: 'screenplayDocument',
};

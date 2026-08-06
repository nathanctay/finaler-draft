import { Node, type Editor } from '@tiptap/core';
import { History } from '@tiptap/extension-history';
import { TextSelection } from '@tiptap/pm/state';
import {
  SCREENPLAY_SCHEMA_VERSION,
  safeParseScreenplay,
  type Screenplay,
  type ScreenplayBlock,
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

const nextElementOnEnter: Record<ScreenplayElementType, ScreenplayElementType> = {
  scene_heading: 'action',
  action: 'action',
  character: 'dialogue',
  dialogue: 'action',
  parenthetical: 'dialogue',
  transition: 'action',
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

function splitScreenplayBlock(editor: Editor, element: ScreenplayElementType): boolean {
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

export function projectLocalScreenplay(editor: Editor): LocalScreenplayProjection {
  const blocks: ScreenplayBlock[] = [];
  let unsupportedNode: string | undefined;

  editor.state.doc.forEach((node) => {
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
    id: '7c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
    schemaVersion: SCREENPLAY_SCHEMA_VERSION,
    title: 'The Long Way Home',
    titlePages: [],
  });

  if (result.success) {
    return { screenplay: result.data, valid: true };
  }

  return { valid: false, issues: result.error.issues.map((issue) => issue.message) };
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

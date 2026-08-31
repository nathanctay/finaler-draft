import { Extension, Node, type Editor } from '@tiptap/core';
import { History } from '@tiptap/extension-history';
import { Plugin, TextSelection, type Transaction } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  SCREENPLAY_SCHEMA_VERSION,
  safeParseScreenplay,
  type DocumentSettings,
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
    // `sceneNumber` is optional and present only on a `scene_heading` block that has one -- see
    // `ScreenplayBlockNode.addAttributes()`'s comment for why it is carried unrendered rather than
    // surfaced as a control.
    attrs: { element: ScreenplayElementType; id: string; sceneNumber?: string };
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

/**
 * An element's name as a writer reads it: `scene_heading` becomes `Scene Heading`. Derived from
 * the canonical identifier rather than kept as a second table beside `screenplayElementTypes`, so
 * a new element type cannot arrive with no label or with one that disagrees with its identifier.
 *
 * It lives here, beside the vocabulary it names, because more than one surface shows it: the
 * toolbar's element `<select>` and the Inspector (`App.tsx`) and the element menu
 * (`elementMenu.tsx`).
 */
export function displayElement(element: ScreenplayElementType): string {
  return element
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');
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

/**
 * True when `text` already begins and ends with a matching pair of parentheses. Serves both
 * directions of `convertActiveScreenplayBlock` below: the double-wrap guard on conversion *to*
 * parenthetical (an FDX-imported parenthetical already carries its own `(` and `)` as authored
 * text; wrapping it again would produce `((like this))`), and, on conversion *away*, the
 * requirement that both parentheses be present before either is stripped -- a writer can delete
 * just one after creation, leaving `(beat` or `beat)`, and that remainder is the writer's text,
 * not punctuation to keep tidying (plan.md, "Writing-flow behaviours borrowed from Final Draft").
 * `text.length >= 2` keeps a single stray `"("` or `")"` from matching both ends of itself.
 */
function isParenWrapped(text: string): boolean {
  return text.length >= 2 && text.startsWith('(') && text.endsWith(')');
}

/**
 * Converts the active block to `element`, additionally wrapping or unwrapping its text in `()`
 * when the conversion crosses the parenthetical boundary in either direction (plan.md,
 * "Writing-flow behaviours borrowed from Final Draft"). Once written, the parentheses are
 * ordinary authored text like any other character in the block -- selectable, deletable,
 * exportable -- not a structure this function polices afterward; `isParenWrapped` above is
 * consulted only at the moment of conversion, never again.
 */
export function convertActiveScreenplayBlock(
  editor: Editor,
  element: ScreenplayElementType,
): boolean {
  const activeBlock = getActiveBlock(editor);
  if (!activeBlock) {
    return false;
  }

  const transaction = editor.state.tr;
  const blockContentStart = activeBlock.position + 1;
  const caretOffset = Math.min(
    Math.max(editor.state.selection.from - blockContentStart, 0),
    activeBlock.text.length,
  );
  let caretOffsetAfterEdit = caretOffset;
  let contentEdited = false;

  if (
    element === 'parenthetical' &&
    activeBlock.element !== 'parenthetical' &&
    !isParenWrapped(activeBlock.text)
  ) {
    transaction.insertText('(', blockContentStart);
    transaction.insertText(')', blockContentStart + 1 + activeBlock.text.length);
    caretOffsetAfterEdit = caretOffset + 1;
    contentEdited = true;
  } else if (
    activeBlock.element === 'parenthetical' &&
    element !== 'parenthetical' &&
    isParenWrapped(activeBlock.text)
  ) {
    // Deleting the trailing character first keeps the leading character's position
    // (`blockContentStart`, used by both deletes) stable regardless of order.
    transaction.delete(
      blockContentStart + activeBlock.text.length - 1,
      blockContentStart + activeBlock.text.length,
    );
    transaction.delete(blockContentStart, blockContentStart + 1);
    caretOffsetAfterEdit = Math.min(Math.max(caretOffset - 1, 0), activeBlock.text.length - 2);
    contentEdited = true;
  }

  transaction.setNodeMarkup(activeBlock.position, undefined, { element, id: activeBlock.id });
  if (contentEdited) {
    transaction.setSelection(
      TextSelection.create(transaction.doc, blockContentStart + caretOffsetAfterEdit),
    );
  }
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
  // Every command in `prosemirror-commands` (`splitBlock` included) marks its own transaction with
  // `.scrollIntoView()`; this hand-rolled split never did. ProseMirror only scrolls a transaction
  // that asks for it (`EditorView.updateStateInner` reads `state.scrollToSelection`, incremented
  // only by this call) -- so at the bottom of the document, Enter moved the selection into a block
  // that had just been created below the fold and left the view exactly where it was. The very
  // next keystroke scrolled correctly only because ordinary typed-text input goes through
  // ProseMirror's own `readDOMChange`, which always calls `tr.scrollIntoView()` on its own
  // transaction -- a different code path this command never shared.
  transaction.scrollIntoView();
  editor.view.dispatch(transaction);
  return true;
}

/**
 * `sceneNumber` (see `ScreenplayBlockNode.addAttributes()` below for the full rationale) is a
 * ProseMirror attribute of every `screenplayBlock` node, not only scene headings -- attributes
 * are declared per node *type*, and there is one node type here. Reading it back out only for
 * `element === 'scene_heading'` is load-bearing, not defensive style: every other block type's
 * canonical schema (`packages/screenplay`'s `textBlockSchemas`) is `.strict()` and has no
 * `sceneNumber` field, so emitting it on, say, an `action` block would make
 * `projectDocumentScreenplay` fail validation the moment a writer changed a numbered scene
 * heading's element -- turning a routine element change into a broken save.
 */
function mapBlock(node: {
  attrs: Record<string, unknown>;
  textContent: string;
}): ScreenplayBlock | undefined {
  const { element, id } = node.attrs;
  if (typeof id !== 'string' || !isScreenplayElementType(element)) {
    return undefined;
  }

  if (element === 'scene_heading') {
    const { sceneNumber } = node.attrs;
    return {
      id,
      type: element,
      text: node.textContent,
      // Not also excluding an empty `sceneNumber` string here: nothing in this file ever sets
      // one (`renderHTML` below only ever writes `data-scene-number` when the attribute is
      // truthy, and `editorContentFromScreenplay` only ever supplies a defined `sceneNumber`),
      // and `sceneHeadingSchema`'s own `sceneNumber: z.string().min(1)...` already rejects an
      // empty one loudly via a normal validation issue if some other path ever produced it --
      // silently coercing it to "absent" here would hide that instead of surfacing it. This
      // `min(1)` is on `sceneNumber` specifically, not on this block's `text` above -- a reader
      // moving quickly (this scope's own implementation agent, on first read) can otherwise walk
      // away thinking an empty scene heading is itself rejected somewhere, which it is not:
      // `screenplayTextSchema` (packages/screenplay's `text` field for every block type,
      // including this one) has no minimum length at all.
      ...(typeof sceneNumber === 'string' ? { sceneNumber } : {}),
    };
  }

  return { id, type: element, text: node.textContent };
}

/**
 * Options for `projectDocumentScreenplay`/`projectEditorScreenplay`, gathered into one object
 * rather than four positional parameters. Four positional arguments -- two of them (`titlePages`,
 * `documentSettings`) structured values with no natural ordering relative to each other -- is a
 * call-site hazard: a caller that transposes a pair still typechecks, since nothing about the
 * call shape catches it. Every field is optional and defaults exactly as the old positional
 * parameters did, so an existing call site that only ever passed `(editor)` needs no change.
 */
export type ProjectScreenplayOptions = {
  documentSettings?: DocumentSettings;
  id?: string;
  title?: string;
  titlePages?: TitlePage[];
};

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
 *
 * `documentSettings` is left `undefined` when the caller doesn't supply one, rather than defaulted
 * to `DEFAULT_DOCUMENT_SETTINGS` here: `safeParseScreenplay`'s own schema already defaults an
 * absent `documentSettings` (see `packages/screenplay`'s `screenplaySchema`), so leaving it out of
 * this object when the caller has none to give preserves that behavior for call sites that
 * genuinely don't have a real value yet (`paginationExtension.ts`'s pagination-only projection,
 * most test fixtures). Previously this parameter did not exist at all, so nothing was ever passed
 * through to `safeParseScreenplay` -- meaning a real, writer-set `documentSettings` was silently
 * discarded and replaced by the schema default on every save. `App.tsx`'s call sites now pass the
 * loaded screenplay's real value explicitly, which is the fix.
 */
export function projectDocumentScreenplay(
  doc: ProseMirrorNode,
  options: ProjectScreenplayOptions = {},
): LocalScreenplayProjection {
  const {
    id = '7c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
    title = 'The Long Way Home',
    titlePages = [],
    documentSettings,
  } = options;
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
    documentSettings,
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
  options: ProjectScreenplayOptions = {},
): LocalScreenplayProjection {
  return projectDocumentScreenplay(editor.state.doc, options);
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
          attrs: {
            element: block.type,
            id: block.id,
            // Carries a locked production number (`sceneHeadingSchema`'s `sceneNumber`) into the
            // editor document as an unrendered attribute so it survives the round trip -- see
            // `ScreenplayBlockNode.addAttributes()`'s comment. Only `scene_heading` ever has this
            // field; every other block type's `block.sceneNumber` access below is unreachable
            // (TypeScript already narrows `block` by `block.type` here).
            ...(block.type === 'scene_heading' && block.sceneNumber !== undefined
              ? { sceneNumber: block.sceneNumber }
              : {}),
          },
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
      /**
       * A locked-production scene number (`packages/screenplay`'s `sceneHeadingSchema.sceneNumber`)
       * -- entirely distinct from the Phase 1 scene-number *display* setting (`pagination.ts`'s
       * `computeSceneNumberDecorations`, recomputed from document order on every render and never
       * written here; see plan.md's "Scene numbers"). This editor has no control for authoring or
       * editing `sceneNumber`, the same situation `titlePages` was in before increment 3 -- so it
       * is carried as an unrendered attribute purely so a locked production script survives being
       * opened and re-saved rather than silently losing its numbers
       * (progress/canonical-round-trip.md). Do not add UI for it; that is explicitly out of this
       * scope.
       *
       * This attribute exists on every `screenplayBlock` node, not only scene headings --
       * ProseMirror attributes are declared per node *type*, and there is one node type here.
       * `mapBlock` above only reads it back out for `element === 'scene_heading'`, since every
       * other block type's canonical schema is `.strict()` with no such field. Changing a numbered
       * scene heading's element (the toolbar and Tab both call `convertActiveScreenplayBlock`,
       * which calls `setNodeMarkup` with an attrs object that omits `sceneNumber`) resets this
       * attribute to `default` rather than carrying the old value onto the new element --
       * ProseMirror's `NodeType.create` fills any attribute missing from a supplied attrs object
       * from its schema default, it does not merge with the node's previous attrs. That is
       * correct, not a bug: the writer changed what the block *is*, and silently resurrecting a
       * stale production number on whatever it becomes next would be worse than losing it.
       */
      sceneNumber: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-scene-number'),
        renderHTML: (attributes) =>
          attributes.sceneNumber ? { 'data-scene-number': attributes.sceneNumber } : {},
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
      /**
       * plan.md, "A line cannot begin with a space": indentation belongs to the element and the
       * character grid positions it, so a space typed as the very first character of a block's
       * text is rejected outright rather than accepted and left for the writer to notice later.
       * Only the *typed* keystroke is guarded, at the exact position that would make it the first
       * character -- a screenplay loaded with existing leading whitespace
       * (`canonicalRoundTrip.test.ts`'s "leading whitespace" samples) is untouched, since nothing
       * here runs outside this keymap entry.
       */
      Space: () => {
        const activeBlock = getActiveBlock(this.editor);
        if (!activeBlock) {
          return false;
        }
        const blockContentStart = activeBlock.position + 1;
        return this.editor.state.selection.from - blockContentStart === 0;
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

/**
 * Regenerates every `screenplayBlock`'s stable id inside a pasted `Slice`, recursively, and
 * leaves everything else -- element, sceneNumber, text, and any bare inline `text` nodes that
 * are not wrapped in a `screenplayBlock` at all -- untouched. This is `progress/paste-sanitization.md`'s
 * fix for the reported "Stable id ... must be globally unique" save failure: a pasted block is a
 * new block, and that must hold even when the paste came from this same editor into this same
 * document, which is the common case (copying a line and pasting it again below), not an edge
 * case carved out for foreign content.
 *
 * Recursing into `node.content` rather than only inspecting top-level fragment children matters
 * for a paste that lands *inside* an existing block: `ScreenplayBlockNode.parseHTML()`'s own
 * comment and this module's `addAttributes()` establish that a `screenplayBlock` only ever
 * contains `text*`, never another `screenplayBlock` -- so recursion here can only ever redescend
 * into a leaf `text` node, which has no `id` to regenerate and is returned unchanged. What that
 * case actually produces: `parseFromClipboard` (`prosemirror-view`'s `serializeForClipboard`)
 * strips symmetric open wrapper levels off a slice copied from the interior of a single block,
 * so a mid-block copy/paste round-trips as bare inline `text` with no `screenplayBlock` wrapper
 * at all -- it merges into the surrounding block's own identity, which is already correct and
 * needs no id regeneration. A paste that instead *replaces a multi-block selection* carries one
 * or more full or partially-open `screenplayBlock` nodes in the slice, every one of which is
 * walked here; an open (partial) one that ProseMirror's replace step goes on to merge into an
 * existing block loses this synthetic id along with the rest of its wrapper attrs on merge (the
 * surviving block keeps whichever side's identity ProseMirror's own join logic picks), and a
 * fully-closed one is inserted as a genuine new block, for which a fresh id is exactly right.
 */
function regeneratePastedIds(fragment: Fragment): Fragment {
  const regenerated: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    const content = node.content.size > 0 ? regeneratePastedIds(node.content) : node.content;
    if (node.type.name === 'screenplayBlock') {
      regenerated.push(
        node.type.create({ ...node.attrs, id: createStableId() }, content, node.marks),
      );
      return;
    }
    regenerated.push(content === node.content ? node : node.copy(content));
  });
  return Fragment.fromArray(regenerated);
}

/**
 * The paste side of `progress/paste-sanitization.md`. There is otherwise no paste handling in
 * this editor at all -- no `transformPasted`, no `handlePaste` -- so ProseMirror's default
 * clipboard parsing runs unmodified: it parses whatever HTML (or, absent HTML, line-split plain
 * text -- see `prosemirror-view`'s `parseFromClipboard`) the clipboard carries against this
 * schema, using each node type's own `parseHTML` rule, exactly the way typing and every other
 * edit already does. This extension does not change what gets parsed or how; it only runs once
 * more, after parsing, over the resulting `Slice`, which is `transformPasted`'s entire contract
 * (`prosemirror-view`'s `EditorProps`) -- a hook that fires for every paste regardless of source,
 * including drag-and-drop content and the plain-text fallback path.
 *
 * `ScreenplayBlockNode.parseHTML()` only matches `div[data-screenplay-block]`, so content this
 * schema has no rule for does not get rejected -- ProseMirror's own default DOM-parsing fallback
 * (used by every schema without an explicit generic "paragraph" node) wraps orphaned inline
 * content in whatever schema node is block-level and text-only, which `screenplayBlock` is,
 * defaulting its `element` to `'action'` and its `id` to `null` per `addAttributes()` above. That
 * default `id` is exactly what made `projectDocumentScreenplay` report "invalid screenplay
 * block" for foreign HTML before this fix: `mapBlock` requires a string id. Regenerating ids here
 * fixes both failure modes with one pass -- a foreign paragraph gets a real id instead of `null`,
 * and content copied from this editor gets a new id instead of the one it was copied from -- and
 * this extension has no schema of its own reason to prefer one wrapping over another, so it also
 * never touches `element`: a `div[data-screenplay-block]` pasted from this editor keeps whatever
 * element `parseHTML` read off its `data-screenplay-element` attribute (scene headings stay scene
 * headings), and content this schema had to fall back to its default wrapping for keeps that
 * default (`'action'`), which is the same "reduce anything unrecognised to its text" outcome
 * marks and other inline formatting already get: this schema defines no marks at all, so
 * `DOMParser.fromSchema` has no rule to match `<strong>`, `<a>`, `<h1>`, and the rest against, and
 * silently drops the wrapping tag while keeping its text -- exactly the "strip formatting, keep
 * the words" behaviour the paste-sanitisation requirement calls for, with no code needed here to
 * produce it.
 *
 * Whitespace-only and empty paste need no special case either: `parseFromClipboard` returns
 * `null` -- skipping `transformPasted` entirely -- when the clipboard carries neither text nor
 * HTML, and a clipboard that carries only blank lines still produces well-formed (if empty)
 * `screenplayBlock` nodes here, which is exactly what an empty block already is everywhere else
 * in this editor (a freshly split block, `Enter` on an empty document): not malformed, just
 * empty.
 */
/**
 * The second half of the same guarantee, and it cannot be done in `transformPasted`.
 *
 * `regeneratePastedIds` above makes every id *arriving in the slice* new. That is not the only way
 * a paste can produce two blocks with one id: dropping a block-shaped slice at a position *inside*
 * an existing block splits it, and ProseMirror's `replace` gives both halves that block's attrs --
 * including its `id`. Neither half came from the clipboard, so nothing in the slice could have been
 * rewritten to prevent it. The result is the exact failure `progress/paste-sanitization.md` exists
 * to close: `screenplayIdSchema`'s uniqueness rule rejects the document, the status bar reads
 * "Not saving · Stable id ... must be globally unique within a screenplay", and the writer's edits
 * stop reaching the server.
 *
 * Reachable by an ordinary action -- put the caret at the start of a line and paste two or more
 * lines copied from the manuscript -- and unrelated to what is on the clipboard, so it survived
 * both the slice-level fix and its tests, which all paste at a block boundary (`position` 0) where
 * no split happens. It surfaced when the element menu stopped `Enter` from leaving a stray empty
 * block at the top of a new screenplay, which is what had been absorbing the paste in the one test
 * that came near it.
 *
 * The scan is a whole-document pass, so it is gated on the transaction that can actually cause the
 * problem rather than run on every keystroke -- the same discipline `paginationExtension.ts` and
 * `smartTypeGhost.ts` apply to their own document-wide passes. `prosemirror-view` marks both the
 * paste and drop paths with a `uiEvent` meta, and no other edit in this editor copies a block's
 * attrs onto a second node: `splitScreenplayBlock` mints a fresh id for the half it creates, and
 * `convertActiveScreenplayBlock` changes one node in place.
 *
 * The first block carrying a given id keeps it and every later one is reissued, which is document
 * order and nothing more -- there is no sense in which one half of a split is more the original
 * block than the other, and inventing a rule (prefer the half with text, prefer the longer one)
 * would be a preference dressed up as a principle.
 */
function regenerateDuplicateBlockIds(doc: ProseMirrorNode, transaction: Transaction): boolean {
  const seen = new Set<string>();
  let changed = false;
  doc.forEach((node, offset) => {
    if (node.type.name !== 'screenplayBlock') {
      return;
    }
    const { id } = node.attrs;
    if (typeof id === 'string' && !seen.has(id)) {
      seen.add(id);
      return;
    }
    // `setNodeMarkup` never changes a node's size, so every offset this loop still has to visit
    // stays valid as it goes.
    transaction.setNodeMarkup(offset, undefined, { ...node.attrs, id: createStableId() });
    changed = true;
  });
  return changed;
}

const ScreenplayPasteSanitizer = Extension.create({
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          const pasted = transactions.some((transaction) => {
            const uiEvent = transaction.getMeta('uiEvent');
            return transaction.docChanged && (uiEvent === 'paste' || uiEvent === 'drop');
          });
          if (!pasted) {
            return null;
          }
          const transaction = newState.tr;
          return regenerateDuplicateBlockIds(newState.doc, transaction) ? transaction : null;
        },
        props: {
          transformPasted: (slice) =>
            new Slice(regeneratePastedIds(slice.content), slice.openStart, slice.openEnd),
        },
      }),
    ];
  },
  name: 'screenplayPasteSanitizer',
});

export const screenplayExtensions = [
  ScreenplayDocument,
  ScreenplayBlockNode,
  ScreenplayText,
  History,
  ScreenplayPasteSanitizer,
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

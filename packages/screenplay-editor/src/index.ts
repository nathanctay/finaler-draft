import {
  Extension,
  Node,
  getSchema,
  type AnyExtension,
  type CommandProps,
  type Editor,
} from '@tiptap/core';
import { Plugin, TextSelection, type Transaction } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos } from '@tiptap/pm/model';
import type * as Y from 'yjs';
import {
  redoCommand,
  undoCommand,
  ySyncPlugin,
  yUndoPlugin,
  prosemirrorJSONToYDoc,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  SCREENPLAY_SCHEMA_VERSION,
  safeParseScreenplay,
  type DocumentSettings,
  type Screenplay,
  type ScreenplayBlock,
  type TitlePage,
} from '@finaler-draft/screenplay';

/**
 * The single Y.XmlFragment name every collaborative screenplay document uses, on both the client
 * (`createScreenplayExtensions` below, bound into the editor via `ySyncPlugin`) and the server
 * (`apps/collab`, which reads the identical fragment when it projects the canonical screenplay --
 * see `projectYDocScreenplay` below). A fixed, shared constant rather than each side choosing its
 * own default: `y-prosemirror`'s helpers all accept a fragment name and default to `'default'`,
 * but leaving that implicit would make "the client and the server agree on which fragment holds
 * the document" a coincidence of two independent defaults staying in sync, not something either
 * side actually asserts.
 */
export const SCREENPLAY_YJS_FRAGMENT = 'default';

/**
 * The two `Y.Map` types that hold everything a screenplay carries outside the ProseMirror body --
 * added in this slice, which moves the title page and document settings out of local React state
 * (`apps/web`'s `titlePageState`/`documentSettings`) and into the collaborative document itself,
 * closing a real data-loss defect: neither had any save path at all once slice 1 deleted the
 * whole-document `PUT` (`progress/collaboration-title-page.md`).
 *
 * Two separate top-level maps, not one combined "metadata" map -- the owner's own approved shape
 * lists them as siblings of the body fragment, and keeping them separate means a reader (or a
 * future increment) touching one can never accidentally clobber the other's keys, the same reason
 * `SCREENPLAY_YJS_FRAGMENT` is its own named type rather than nested inside something else.
 *
 * Every field in both maps is a **plain, last-write-wins value**, not a `Y.Text`/`Y.Array` nested
 * shared type -- deliberately, not by default. A title page has a handful of short fields (title,
 * credit, source, draft date, a handful of author/contact lines) that two collaborators
 * overwhelmingly do not edit character-by-character at the same instant the way they do the
 * manuscript body; `documentSettings`' six fields are settings, not prose, and there is no
 * sensible reading of "merge two people's concurrent character-indent edits character by
 * character." `Y.Text` would buy fine-grained concurrent-merge semantics at real cost: the title
 * page's fields are plain `contentEditable` divs synced by plain string assignment
 * (`titlePageEditor.tsx`'s own "uncontrolled-but-synced" comment), not bound through
 * `y-prosemirror` the way the body is, so getting `Y.Text` co-editing right would mean building a
 * second, parallel rich-text binding for six short fields nobody meaningfully co-edits. Plain
 * last-write-wins values are the honest choice for content this size and this rarely contested;
 * the cost -- a genuinely simultaneous edit to the same field by two writers drops one writer's
 * keystroke -- is the same cost every other settings-shaped value in this codebase already
 * accepts, and is far cheaper than the alternative's complexity.
 *
 * See `titlePageFromYMap`/`writeTitlePageToYMap` and `documentSettingsFromYMap`/
 * `writeDocumentSettingsToYMap` below for the read/write contract each map keeps, and
 * `seedScreenplayYDoc` for how a screenplay that predates this slice gets its existing canonical
 * title page and document settings carried into these maps the first time it is opened
 * collaboratively.
 */
export const TITLE_PAGE_YJS_MAP = 'titlePage';
export const DOCUMENT_SETTINGS_YJS_MAP = 'documentSettings';

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

/**
 * The `screenplayBlock` ancestor of `pos`, if any -- shared by `getActiveBlock` (below, which
 * always asks about the selection's `$from`) and `splitScreenplayBlock`'s cross-block case (which
 * separately needs the block containing `$to`, the far edge of a selection that spans more than
 * one block).
 */
function blockAt(pos: ResolvedPos): ActiveScreenplayBlock | undefined {
  for (let depth = pos.depth; depth > 0; depth -= 1) {
    const node = pos.node(depth);
    if (node.type.name === 'screenplayBlock' && isScreenplayElementType(node.attrs.element)) {
      return {
        element: node.attrs.element,
        id: node.attrs.id,
        nodeSize: node.nodeSize,
        position: pos.before(depth),
        text: node.textContent,
      };
    }
  }

  return undefined;
}

function getActiveBlock(editor: Editor): ActiveScreenplayBlock | undefined {
  return blockAt(editor.state.selection.$from);
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
 *
 * **A selection that reaches past `activeBlock`'s own end** -- the caret started in one block and
 * the selection extends into a later one, or swallows one or more whole blocks in between -- is
 * handled here rather than declined. It used to decline (`return false`), which sent Enter to
 * `@tiptap/core`'s own built-in fallback (`createParagraphNear` / `liftEmptyBlock` / `splitBlock`,
 * bundled unconditionally with every `Editor`): that fallback deletes the selected range, which
 * ProseMirror's own join logic merges into a single node, and then calls `tr.split` on it with no
 * explicit node types -- `tr.split`'s documented default when none are given is to copy the split
 * node's own type and attrs onto *both* resulting halves, `id` included. Two `screenplayBlock`
 * nodes would come out sharing one stable id: `screenplayIdSchema`'s uniqueness rule then rejects
 * the document and saving stops (see `progress/enter-duplicate-ids.md`). Handling it here instead
 * costs little: it is the same prefix/suffix split as the single-block case, just with the suffix
 * read from `endBlock`'s text instead of `activeBlock`'s, and `endBlock`'s own element preserved
 * (or replaced by `elementWhenSplittingAtEnd`, by the same "at its end" rule) rather than copied
 * from `activeBlock`. `preservedBlock` always keeps `activeBlock`'s own id; `newBlock` always mints
 * a fresh one with `createStableId()`, so there is no path through this function that can produce
 * a duplicate. Any block strictly between `activeBlock` and `endBlock` is inside the replaced
 * range and so is removed entirely, along with its id -- exactly what "the writer selected across
 * several elements and pressed Enter" means.
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

  const { selection } = editor.state;
  const blockContentStart = activeBlock.position + 1;
  if (selection.from < blockContentStart) {
    return false;
  }

  const activeBlockContentEnd = activeBlock.position + activeBlock.nodeSize - 1;
  const endBlock = selection.to <= activeBlockContentEnd ? activeBlock : blockAt(selection.$to);
  if (!endBlock) {
    return false;
  }

  const endBlockContentStart = endBlock.position + 1;
  const selectionStartOffset = Math.min(
    Math.max(selection.from - blockContentStart, 0),
    activeBlock.text.length,
  );
  const selectionEndOffset = Math.min(
    Math.max(selection.to - endBlockContentStart, 0),
    endBlock.text.length,
  );
  const prefix = activeBlock.text.slice(0, selectionStartOffset);
  const suffix = endBlock.text.slice(selectionEndOffset);
  const element =
    selectionEndOffset === endBlock.text.length ? elementWhenSplittingAtEnd : endBlock.element;
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
    endBlock.position + endBlock.nodeSize,
    Fragment.from([preservedBlock, newBlock]),
  );
  const insertionPosition = activeBlock.position + preservedBlock.nodeSize;
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

/**
 * `content`, or -- if it has no blocks at all -- a document seeded with exactly one empty
 * `action` block, so there is always somewhere to place the caret.
 *
 * A brand-new screenplay's canonical content is genuinely `blocks: []`
 * (`routes/projects/$projectId/index.tsx`'s own `create` mutation, `apps/web`), and
 * `editorContentFromScreenplay` above is a faithful projection -- it must not silently invent
 * content that was not there, or a round trip through it and back (`projectDocumentScreenplay`)
 * would no longer be the identity `canonicalRoundTrip.test.ts` requires. This is therefore a
 * separate, explicit step callers take only when they actually need an editable document to have
 * somewhere for a cursor to go, not folded into the projection itself.
 *
 * Both places that build an editable document from a (possibly empty) projection need this and
 * must agree: `apps/web/src/App.tsx`'s `editorContent`, for a screenplay opened without
 * collaboration, and `apps/collab/src/database.ts`'s `createFetch`, seeding a brand-new
 * collaborative Yjs document from `canonical_screenplay` the first time a screenplay is opened
 * collaboratively. Before this was extracted here, only the first of those applied the rule --
 * `apps/collab`'s server-side seed did not, so a fresh screenplay opened through a real
 * `HocuspocusProvider` loaded a genuinely empty document with no block to type into at all
 * (caught by wiring a real `apps/collab` into the persistence end-to-end harness, not by any unit
 * test, since every existing unit test seeds its `Y.Doc` from non-empty content).
 */
export function nonEmptyEditorContent(content: EditorContent): EditorContent {
  if (content.content.length > 0) return content;
  return {
    content: [{ attrs: { element: 'action', id: crypto.randomUUID() }, type: 'screenplayBlock' }],
    type: 'screenplayDocument',
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
          // Deliberately `true` regardless of what `splitScreenplayBlock` reports, not a passed-
          // through `return`. Once the caret is inside a real `screenplayBlock`, Enter must never
          // fall through to `@tiptap/core`'s own built-in Enter fallback (`createParagraphNear` /
          // `liftEmptyBlock` / `splitBlock`, bundled unconditionally with every `Editor`) -- see
          // `splitScreenplayBlock`'s own comment for the duplicate-id failure that fallback
          // produces on an ordinary cross-block selection. `splitScreenplayBlock` now handles every
          // selection shape reachable from here; its remaining `return false`s guard conditions
          // that cannot actually occur given an `activeBlock` found via this same selection, and
          // swallowing the keystroke on one of them (an inert Enter) is a far safer failure mode
          // than handing it to a fallback that can corrupt the document.
          splitScreenplayBlock(this.editor, nextElementOnEnter[activeBlock.element]);
          return true;
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

        // The caret is at the document's own top level -- before the first block's content, not
        // inside any block (`getActiveBlock`'s depth-walk finds nothing; see its own comment and
        // `editing.test.ts`'s `selectAtDocumentBoundary`/`selectBeforeFirstBlock`, both real,
        // reachable positions, not test artifice). Tab and Space already decline here and leave
        // the document untouched. Enter cannot merely decline the same way: returning `false` used
        // to fall through to the same `@tiptap/core` fallback named above, which -- finding no
        // textblock at this position either -- called `createParagraphNear`, inserting a brand-new
        // `screenplayBlock` with none of this node's attribute defaults overridden, so its `id`
        // defaulted to `null`. `mapBlock` requires a string id, so a `null` one makes the whole
        // canonical projection invalid and the document silently stops persisting -- the exact
        // failure this fix exists to close (`progress/enter-duplicate-ids.md`). Claiming the key
        // here and dispatching nothing keeps the same "document untouched" outcome Tab and Space
        // already have at this position, just without leaving the fallback able to act instead.
        return true;
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
 * That "no other edit" claim used to have a hole: `@tiptap/core`'s own built-in Enter fallback
 * (bundled unconditionally with every `Editor`) is not code in this file, but it ran *as* an edit
 * in this editor whenever `ScreenplayBlockNode`'s own `Enter` entry declined -- which it did for a
 * selection spanning two blocks -- and it copied attrs the same way a mid-block paste split used
 * to. `splitScreenplayBlock`'s own comment has the mechanism and the fix: that entry now claims
 * every selection shape reachable from an active block, so this gate never needs widening for
 * Enter specifically (see `progress/enter-duplicate-ids.md`).
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

/**
 * Replaces `@tiptap/extension-history` (removed by this slice -- see progress/collaboration-plan.md
 * "Slice 1 -- the vertical chain"). Standard ProseMirror history operates on the shared document
 * transaction stream, so one writer's Ctrl+Z would undo a collaborator's edit rather than only
 * their own -- exactly what plan.md's collaboration model forbids. `y-prosemirror`'s `yUndoPlugin`
 * scopes undo/redo to the Yjs transaction origins this client itself produced (tracked via the
 * bound `Y.UndoManager`), so "undo" only ever reverts this browser's own edits, local or not yet
 * flushed to the server, and never a remote collaborator's.
 *
 * `yUndoPlugin` depends on `ySyncPlugin` already being registered in the same `EditorState` --
 * it resolves the Y type to scope its `Y.UndoManager` to via `ySyncPluginKey.getState(state)` --
 * so the two are registered together here, not independently. This is also why
 * `createScreenplayEditorInit` (below) builds the extensions and the starting document together
 * rather than the extensions being a static array the way they were before this slice: every
 * editor this function builds is Yjs-backed now, including the ones every existing unit test
 * builds (a local, unconnected `Y.Doc` is enough -- `ySyncPlugin` needs no network provider, only
 * a fragment belonging to a `Y.Doc`).
 *
 * `addCommands` re-registers `undo`/`redo` under the exact command names
 * `@tiptap/extension-history` used, so every existing call site (`editor.commands.undo()`,
 * `editor.can().undo()`, the toolbar's undo/redo buttons) keeps working unchanged -- only what
 * backs those commands changed.
 *
 * `undoCommand`/`redoCommand` are typed as ordinary ProseMirror `(state, dispatch?) => boolean`
 * commands, but they are not well-behaved ones: reading the installed `y-prosemirror` source
 * (`undo-plugin.js`), a non-null `dispatch` makes them call `Y.UndoManager#undo()`/`#redo()`
 * directly, which mutates the bound Y type and -- synchronously, via the Yjs observer
 * `ySyncPlugin`'s binding already registered against the *real* `EditorView` -- dispatches the
 * resulting transaction into that view themselves. They never call the `dispatch` function they
 * were given; its only role is the `dispatch == null` check that distinguishes a real call from a
 * `can()` dry run. Tiptap's own `CommandManager`, unaware of this, still performs its usual
 * trailing `view.dispatch(tr)` with the `tr` it built *before* calling the command -- a
 * transaction now stale, since the Yjs-triggered dispatch already advanced `view.state` out from
 * under it. Undriven, that produces `RangeError: Applying a mismatched transaction`. `tr.setMeta('preventDispatch', true)`
 * is Tiptap's own documented escape hatch for exactly this shape of command (one that dispatches
 * itself): it suppresses `CommandManager`'s trailing dispatch of the now-irrelevant `tr`, leaving
 * the Yjs-triggered dispatch as the only one that happens.
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    screenplayYjs: {
      /** @example editor.commands.undo() */
      undo: () => ReturnType;
      /** @example editor.commands.redo() */
      redo: () => ReturnType;
    };
  }
}

const ScreenplayYjsExtension = Extension.create<{ fragment: Y.XmlFragment }>({
  addCommands() {
    return {
      undo:
        () =>
        ({ state, dispatch, tr }: CommandProps) => {
          if (!dispatch) return undoCommand(state, undefined);
          const didUndo = undoCommand(state, () => undefined);
          tr.setMeta('preventDispatch', true);
          return didUndo;
        },
      redo:
        () =>
        ({ state, dispatch, tr }: CommandProps) => {
          if (!dispatch) return redoCommand(state, undefined);
          const didRedo = redoCommand(state, () => undefined);
          tr.setMeta('preventDispatch', true);
          return didRedo;
        },
    };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-z': () => this.editor.commands.undo(),
      'Mod-y': () => this.editor.commands.redo(),
      'Shift-Mod-z': () => this.editor.commands.redo(),
    };
  },
  addProseMirrorPlugins() {
    // No `mapping` option: passing one computed independently of Tiptap's own schema would be
    // actively wrong, not merely unhelpful. Tiptap's `Editor` always derives `editor.schema` for
    // itself from the resolved `extensions` array (`Editor.ts`: `this.schema =
    // this.extensionManager.schema`, with no way to inject a precomputed instance) -- so a
    // `mapping` built against any *other* `Schema` instance (even one built from the identical
    // node specs) would tie `ySyncPlugin`'s Y-type-to-PM-node bookkeeping to node objects that do
    // not belong to `editor.schema`, silently corrupting position arithmetic the moment a real
    // edit ran through it. `ScreenplayEditorInit` documents the resulting redundant transaction
    // and the plugins that had to be made tolerant of it instead.
    return [ySyncPlugin(this.options.fragment), yUndoPlugin()];
  },
  name: 'screenplayYjs',
});

/**
 * The bare node/mark schema every screenplay editor -- collaborative or, in a test, purely local
 * -- is built from. `apps/collab` (the Hocuspocus server) needs exactly this and nothing more: it
 * never renders or edits, it only reads a `Y.XmlFragment` back into a `ProseMirrorNode` to compute
 * the canonical projection (see `projectYDocScreenplay` below), and `Schema` construction is the
 * one piece of `@tiptap/core` machinery that doesn't require a `document`/DOM to exist. Computed
 * once and cached: `getSchema` rebuilds a fresh `Schema` instance on every call, and two different
 * `Schema` instances are never `===`-equal even when structurally identical, which matters because
 * ProseMirror's `Node.type` comparisons and `NodeType`-keyed maps rely on object identity, not
 * structural equality.
 */
let cachedSchema: ReturnType<typeof getSchema> | undefined;
export function getScreenplayEditorSchema(): ReturnType<typeof getSchema> {
  cachedSchema ??= getSchema([ScreenplayDocument, ScreenplayBlockNode, ScreenplayText]);
  return cachedSchema;
}

/**
 * Builds a screenplay editor's starting document and its full extension set together from a
 * `Y.XmlFragment` -- the document is a projection of the Yjs document (plan.md, "Collaboration,
 * history, and restoration"), so the two cannot be constructed independently the way a plain
 * `content` option and a static `screenplayExtensions` array once were.
 *
 * `fragment` is expected to already belong to a `Y.Doc` -- either one a `HocuspocusProvider` is
 * syncing (the real editor, `App.tsx`; the fragment may still be empty at this point, genuinely,
 * until the provider's first sync completes) or a bare local one a test seeded synchronously (see
 * `createLocalScreenplayEditorInit` below, the common case for a test that wants starting content
 * with no network involved at all).
 *
 * Returns plain JSON (`yXmlFragmentToProseMirrorRootNode(...).toJSON()`), not the `ProseMirrorNode`
 * that helper actually builds. That node's `.type` fields belong to `getScreenplayEditorSchema()`'s
 * cached `Schema` instance -- a *different* object than `editor.schema`, which Tiptap always
 * derives fresh from the resolved `extensions` array with no way to inject one (`Editor.ts`:
 * `this.schema = this.extensionManager.schema`). `createNodeFromContent` special-cases an
 * already-a-`Node` `content` value by returning it completely unparsed, so passing that node
 * directly would seed `editor.state.doc` with `NodeType`s from the wrong schema instance --
 * `===`-driven internals throughout `prosemirror-transform` (this editor's own hand-rolled
 * `splitScreenplayBlock` among them) then fail in confusing, position-arithmetic-shaped ways.
 * Round-tripping through plain JSON forces Tiptap's own `createDocument` down its
 * `schema.nodeFromJSON(content)` path instead, which rebuilds the document from `editor.schema`
 * and is the only way to guarantee every node in the live document belongs to it.
 *
 * The consequence: `ySyncPlugin` (registered with no `mapping` option -- see
 * `ScreenplayYjsExtension`'s own comment) always performs one forced-rerender transaction right
 * after the view mounts, a full-document `tr.replace(0, size, contentFromY)` -- even when that
 * content is byte-identical to what `content` already seeded the state with, since `ySyncPlugin`
 * has no way to know that without the (schema-identity-unsafe) `mapping` option. A full-range
 * replace is, to `Decoration.map`/`Mapping`, indistinguishable from deleting the whole old
 * document and inserting a whole new one: every decoration anchored inside the old range is
 * dropped, not remapped. `paginationExtension.ts`'s page-break widgets and `seamCaret.ts`'s drawn
 * caret both anchor decorations from positions computed in their own plugin `init()`, and both
 * were updated to recompute (not merely remap) when they see this specific transaction
 * (`tr.getMeta(ySyncPluginKey)`) -- a real fix, not a test workaround, since the identical forced
 * rerender happens against a live `HocuspocusProvider` fragment too, not only a test's local one.
 */
export function createScreenplayEditorInit(fragment: Y.XmlFragment): {
  content: EditorContent;
  extensions: AnyExtension[];
} {
  const doc = yXmlFragmentToProseMirrorRootNode(fragment, getScreenplayEditorSchema());
  return {
    content: doc.toJSON() as EditorContent,
    extensions: [
      ScreenplayDocument,
      ScreenplayBlockNode,
      ScreenplayText,
      ScreenplayYjsExtension.configure({ fragment }),
      ScreenplayPasteSanitizer,
    ],
  };
}

/**
 * Builds a fresh, local `Y.Doc` whose `SCREENPLAY_YJS_FRAGMENT` fragment is seeded from `content`
 * (the same `EditorContent` shape `editorContentFromScreenplay` below produces). The one server-
 * side call site is `apps/collab`'s `onLoadDocument`, which seeds a brand-new Yjs document for a
 * screenplay that predates this slice -- one that has a `canonical_screenplay` row but no
 * `document_yjs_state` row yet (see progress/collaboration-slice-1.md). `createLocalScreenplayEditorInit`
 * below is the equivalent for a test that wants a whole editor, not just the `Y.Doc`.
 *
 * Deliberately not used to *rehydrate* an existing collaborative document from a later save --
 * `prosemirrorJSONToYDoc`'s own doc comment is explicit that doing so discards Yjs history. It is
 * only ever called once per document, at the moment a Yjs document is first created for it.
 */
export function createLocalScreenplayYDoc(content: EditorContent): Y.Doc {
  return prosemirrorJSONToYDoc(getScreenplayEditorSchema(), content, SCREENPLAY_YJS_FRAGMENT);
}

/**
 * The one call every unit test that builds an editor with starting content needs: seeds a local,
 * unconnected `Y.Doc` from `content` and builds the same `{ content, extensions }` pair
 * `createScreenplayEditorInit` builds for a real, network-bound fragment. Passing the result
 * straight into `new Editor({ element, ...createLocalScreenplayEditorInit(content) })` reproduces
 * exactly what the old `new Editor({ content, extensions: screenplayExtensions })` call sites did
 * before this slice, decoration-anchoring plugins included.
 */
export function createLocalScreenplayEditorInit(content: EditorContent): {
  content: EditorContent;
  extensions: AnyExtension[];
} {
  return createScreenplayEditorInit(
    createLocalScreenplayYDoc(content).getXmlFragment(SCREENPLAY_YJS_FRAGMENT),
  );
}

function readOptionalString(map: Y.Map<unknown>, key: string): string | undefined {
  const value = map.get(key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readOptionalStringArray(map: Y.Map<unknown>, key: string): string[] | undefined {
  const value = map.get(key);
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : undefined;
}

/**
 * True exactly when `map` (`TITLE_PAGE_YJS_MAP`) holds a title page -- an `id` key, which is the
 * one field `writeTitlePageToYMap` always writes whenever it is given a real `TitlePage`, and the
 * one field it never omits even for a title page a writer has cleared down to nothing (mirroring
 * `titlePageFromState`'s own convention, `apps/web`'s `titlePageFromState`: an emptied title page
 * still has an `id` and still counts as one title page). An unseeded map -- one
 * `writeTitlePageToYMap` has never been called on -- has no `id` key at all, which is exactly
 * what distinguishes "no title page" from "a title page with every field blank," and what
 * `apps/collab/src/database.ts`'s migration backfill uses to tell "this document predates title
 * pages living in Yjs" apart from "a writer already edited this collaboratively, however sparsely."
 */
export function isTitlePageMapSeeded(map: Y.Map<unknown>): boolean {
  return typeof map.get('id') === 'string';
}

/**
 * Reads the collaborative document's single title page back out of `TITLE_PAGE_YJS_MAP`, or
 * `undefined` when the map holds none at all (`isTitlePageMapSeeded` above is `false`) -- matching
 * `titlePages: []` in the canonical screenplay, and `titlePageState === undefined` in `App.tsx`
 * (no title page rendered at all). An empty scalar or list field is read back as absent, not `''`/
 * `[]`, the same "ordinary deletable text" convention `titlePageFromState` already uses -- this is
 * the reverse of `writeTitlePageToYMap` below, and the two are meant to be read together.
 */
export function titlePageFromYMap(map: Y.Map<unknown>): TitlePage | undefined {
  if (!isTitlePageMapSeeded(map)) return undefined;
  const titlePage: TitlePage = { id: map.get('id') as string };
  const title = readOptionalString(map, 'title');
  if (title !== undefined) titlePage.title = title;
  const credit = readOptionalString(map, 'credit');
  if (credit !== undefined) titlePage.credit = credit;
  const source = readOptionalString(map, 'source');
  if (source !== undefined) titlePage.source = source;
  const draftDate = readOptionalString(map, 'draftDate');
  if (draftDate !== undefined) titlePage.draftDate = draftDate;
  const authors = readOptionalStringArray(map, 'authors');
  if (authors !== undefined) titlePage.authors = authors;
  const contact = readOptionalStringArray(map, 'contact');
  if (contact !== undefined) titlePage.contact = contact;
  return titlePage;
}

/**
 * Writes `titlePage` into `TITLE_PAGE_YJS_MAP` as plain last-write-wins values, one key per field
 * -- see `TITLE_PAGE_YJS_MAP`'s own comment for why these are plain values, not `Y.Text`. The only
 * function that mutates this map, on both the client (`App.tsx`'s `updateTitlePageState`, wrapped
 * in the caller's own `doc.transact()`) and the server (`apps/collab/src/database.ts`'s one-shot
 * seed/backfill, used bare since nothing else shares its transaction).
 *
 * Clears every existing key first -- not merely overwriting the six known ones -- so a stale key
 * from a future field this function doesn't yet know about can never survive a write it should
 * have been part of, and so `undefined`-out fields (a writer clearing a field back to nothing,
 * `titlePage.title === undefined`) are actually removed rather than left holding a stale value:
 * `titlePageFromYMap` above reads an *absent* key as "no value," never a leftover one.
 */
export function writeTitlePageToYMap(map: Y.Map<unknown>, titlePage: TitlePage | undefined): void {
  for (const key of [...map.keys()]) map.delete(key);
  if (!titlePage) return;
  map.set('id', titlePage.id);
  if (titlePage.title !== undefined) map.set('title', titlePage.title);
  if (titlePage.credit !== undefined) map.set('credit', titlePage.credit);
  if (titlePage.source !== undefined) map.set('source', titlePage.source);
  if (titlePage.draftDate !== undefined) map.set('draftDate', titlePage.draftDate);
  if (titlePage.authors !== undefined) map.set('authors', [...titlePage.authors]);
  if (titlePage.contact !== undefined) map.set('contact', [...titlePage.contact]);
}

const DOCUMENT_SETTINGS_KEYS = [
  'characterIndentIn',
  'parentheticalIndentIn',
  'parentheticalWidthIn',
  'pageNumberStyle',
  'sceneNumbersEnabled',
  'autoMoreContinued',
] as const satisfies readonly (keyof DocumentSettings)[];

/** True exactly when `map` (`DOCUMENT_SETTINGS_YJS_MAP`) has ever been written to -- see
 * `isTitlePageMapSeeded`'s own comment; the equivalent check for the settings map, which (unlike
 * the title page map) has no field that is always present, so map-non-emptiness is the signal. */
export function isDocumentSettingsMapSeeded(map: Y.Map<unknown>): boolean {
  return map.size > 0;
}

/**
 * Reads `documentSettings` back out of `DOCUMENT_SETTINGS_YJS_MAP`, or `undefined` when the map is
 * empty (`isDocumentSettingsMapSeeded` above is `false`) -- `ProjectScreenplayOptions.documentSettings`
 * is deliberately left unset in that case rather than defaulted here, so `safeParseScreenplay`'s
 * own schema default (see that option's own comment) remains the single place that default lives.
 * A *partially* populated map still returns a complete object, falling each individually missing
 * key back to `DEFAULT_DOCUMENT_SETTINGS` -- defensive only: every writer of this map
 * (`writeDocumentSettingsToYMap` below) always writes all six keys atomically in one
 * `doc.transact()`, and nothing here is expected to ever see a genuine partial write.
 */
export function documentSettingsFromYMap(map: Y.Map<unknown>): DocumentSettings | undefined {
  if (!isDocumentSettingsMapSeeded(map)) return undefined;
  const settings: Record<string, unknown> = { ...DEFAULT_DOCUMENT_SETTINGS };
  for (const key of DOCUMENT_SETTINGS_KEYS) {
    const value = map.get(key);
    if (value !== undefined) settings[key] = value;
  }
  return settings as DocumentSettings;
}

/**
 * Writes `documentSettings` into `DOCUMENT_SETTINGS_YJS_MAP`, all six keys at once -- see
 * `documentSettingsFromYMap`'s own comment on why every writer of this map keeps that invariant.
 */
export function writeDocumentSettingsToYMap(
  map: Y.Map<unknown>,
  documentSettings: DocumentSettings,
): void {
  for (const key of DOCUMENT_SETTINGS_KEYS) {
    map.set(key, documentSettings[key]);
  }
}

/**
 * Builds a fresh, local `Y.Doc` seeded from a full canonical screenplay's editable content: the
 * body (via `createLocalScreenplayYDoc`) and, new in this slice, the title page and document
 * settings maps (`writeTitlePageToYMap`/`writeDocumentSettingsToYMap`) -- all three written inside
 * one `doc.transact()`, so nothing ever observes this document with a body but no title page (or
 * vice versa) partway through.
 *
 * Two call sites, both seeding a Yjs document for the first time from a screenplay's canonical
 * content, never to rehydrate an existing collaborative one (`createLocalScreenplayYDoc`'s own
 * warning, which this still delegates to for the body):
 *
 *  - `apps/collab/src/database.ts`'s `createFetch`, seeding a brand-new collaborative document the
 *    first time a screenplay is opened collaboratively at all, and backfilling the title page and
 *    document settings maps of one whose `document_yjs_state` already exists but predates this
 *    slice (see that module's own comment on the migration).
 *  - `apps/web/src/App.tsx`'s local (no collaboration server configured, or an unsupported schema)
 *    fallback path, which needs the identical shape so this app's own title-page/document-settings
 *    observers behave the same with or without a real `HocuspocusProvider` behind them.
 */
export function seedScreenplayYDoc(
  content: EditorContent,
  titlePage: TitlePage | undefined,
  documentSettings: DocumentSettings | undefined,
): Y.Doc {
  const doc = createLocalScreenplayYDoc(content);
  doc.transact(() => {
    writeTitlePageToYMap(doc.getMap(TITLE_PAGE_YJS_MAP), titlePage);
    if (documentSettings) {
      writeDocumentSettingsToYMap(doc.getMap(DOCUMENT_SETTINGS_YJS_MAP), documentSettings);
    }
  });
  return doc;
}

/**
 * The server-side half of "the canonical screenplay is a projection of the Yjs document" --
 * reads the current state of `ydoc`'s `SCREENPLAY_YJS_FRAGMENT` fragment back into a real
 * `ProseMirrorNode` (`yXmlFragmentToProseMirrorRootNode`, the non-deprecated replacement for
 * `yDocToProsemirror`), and now also reads `ydoc`'s title page and document settings maps
 * (`titlePageFromYMap`/`documentSettingsFromYMap`) rather than accepting them as options -- both
 * genuinely live in this `Y.Doc` now, so there is nothing left for a caller to supply beyond `id`/
 * `title`, which do not (title is a project/screenplay-level field, unrelated to the title *page*;
 * see `ProjectScreenplayOptions`'s own comment). Hands the result to `projectDocumentScreenplay`,
 * the exact same projection function the browser editor's own save path always used. There is only
 * one projection function in this codebase; this is the only other place that calls it.
 */
export function projectYDocScreenplay(
  ydoc: Y.Doc,
  options: Pick<ProjectScreenplayOptions, 'id' | 'title'> = {},
): LocalScreenplayProjection {
  const fragment = ydoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT);
  const doc = yXmlFragmentToProseMirrorRootNode(fragment, getScreenplayEditorSchema());
  const titlePage = titlePageFromYMap(ydoc.getMap(TITLE_PAGE_YJS_MAP));
  const documentSettings = documentSettingsFromYMap(ydoc.getMap(DOCUMENT_SETTINGS_YJS_MAP));
  return projectDocumentScreenplay(doc, {
    ...options,
    titlePages: titlePage ? [titlePage] : [],
    ...(documentSettings ? { documentSettings } : {}),
  });
}

export const initialScreenplayContent: EditorContent = {
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

// Remote presence: awareness-driven cursors and the participant list (slice 2). See
// presence.ts's own top-of-file comment for what this carries and why.
export * from './presence.js';

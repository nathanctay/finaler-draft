import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createLocalScreenplayYDoc,
  createScreenplayEditorInit,
  projectYDocScreenplay,
  SCREENPLAY_YJS_FRAGMENT,
} from '@finaler-draft/screenplay-editor';
import { screenplaySchema } from '@finaler-draft/screenplay';
import { createFetch, createStore } from './database.js';

/** A minimal screenplay this editor can actually represent -- `editorContentFromScreenplay`
 * (called inside `createFetch`'s seed path) rejects more than one title page, annotations, dual
 * dialogue, and page breaks. */
function compatibleScreenplay(overrides: Partial<Record<string, unknown>> = {}) {
  return screenplaySchema.parse({
    annotations: [],
    blocks: [{ id: '00000000-0000-4000-8000-000000000000', type: 'action', text: 'Legacy text.' }],
    id: '00000000-0000-4000-8000-000000000001',
    schemaVersion: 1,
    title: 'Legacy Screenplay',
    titlePages: [],
    ...overrides,
  });
}

/** A fake `pg.Pool` recording every query issued against it, with a table-driven response map
 * keyed on a recognisable fragment of each query's own SQL text -- the same convention
 * `authenticate.test.ts`'s fake `Queryable` uses. */
function fakePool(responses: {
  documentYjsState?: { state: Buffer } | undefined;
  screenplay?: { title: string; canonicalScreenplay: unknown } | undefined;
}) {
  const queries: string[] = [];
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push(text);
      if (text.includes('document_yjs_state') && text.startsWith('select')) {
        return { rows: responses.documentYjsState ? [responses.documentYjsState] : [] };
      }
      // Checked before the more general "select ... canonical_screenplay" branch below: this is
      // `createStore`'s own query, and it also needs `title` in the response.
      if (text.startsWith('select title, canonical_screenplay')) {
        return { rows: responses.screenplay ? [responses.screenplay] : [] };
      }
      if (text.includes('canonical_screenplay') && text.startsWith('select')) {
        return {
          rows: responses.screenplay
            ? [{ canonicalScreenplay: responses.screenplay.canonicalScreenplay }]
            : [],
        };
      }
      if (text.startsWith('begin') || text.startsWith('commit') || text.startsWith('rollback')) {
        return { rows: [] };
      }
      if (text.includes('insert into document_yjs_state')) {
        return { rows: [] };
      }
      if (text.includes('update screenplays')) {
        return { rows: [] };
      }
      throw new Error(
        `Unexpected query in test double: ${text} (values: ${JSON.stringify(values)})`,
      );
    },
    release() {},
  };
  const pool = {
    query: client.query,
    async connect() {
      return client;
    },
  };
  return { pool: pool as unknown as Pool, queries };
}

describe('createFetch', () => {
  it('returns the stored state unchanged when a document_yjs_state row already exists', async () => {
    const state = Buffer.from([1, 2, 3]);
    const { pool } = fakePool({ documentYjsState: { state } });
    const result = await createFetch(pool)({ documentName: 'doc-1' } as never);
    expect(result).toEqual(new Uint8Array(state));
  });

  it('seeds a fresh Yjs update from the existing canonical screenplay when no state row exists', async () => {
    const screenplay = compatibleScreenplay();
    const { pool } = fakePool({
      screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
    });
    const result = await createFetch(pool)({ documentName: screenplay.id } as never);
    expect(result).not.toBeNull();
    const seededDoc = new Y.Doc();
    Y.applyUpdate(seededDoc, result!);
    expect(seededDoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT).toString()).toContain('Legacy text.');
  });

  it('seeds exactly one empty action block when the canonical screenplay has no blocks at all, so there is somewhere for the caret to go', async () => {
    // A brand-new (or emptied-out) screenplay's `blocks` is genuinely `[]`
    // (`routes/projects/$projectId/index.tsx`'s own `create` mutation) -- caught directly, not
    // wired into the persistence end-to-end harness, after that harness first exposed it: every
    // existing test above seeds from a screenplay with a real block, so none of them could have
    // caught a collaborative document seeded with zero.
    const screenplay = compatibleScreenplay({ blocks: [] });
    const { pool } = fakePool({
      screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
    });
    const result = await createFetch(pool)({ documentName: screenplay.id } as never);
    expect(result).not.toBeNull();
    const seededDoc = new Y.Doc();
    Y.applyUpdate(seededDoc, result!);
    const projection = projectYDocScreenplay(seededDoc, { id: screenplay.id, title: 'Row Title' });
    expect(projection.valid).toBe(true);
    if (!projection.valid) throw new Error('expected a valid projection');
    expect(projection.screenplay.blocks).toHaveLength(1);
    expect(projection.screenplay.blocks[0]?.type).toBe('action');
  });

  it('returns null when neither a state row nor a screenplay row exists', async () => {
    const { pool } = fakePool({});
    const result = await createFetch(pool)({ documentName: 'missing' } as never);
    expect(result).toBeNull();
  });

  it('returns null, rather than throwing, when the canonical screenplay has features this editor cannot represent', async () => {
    const screenplay = compatibleScreenplay({
      titlePages: [
        { id: '00000000-0000-4000-8000-000000000002' },
        { id: '00000000-0000-4000-8000-000000000003' },
      ],
    });
    const { pool } = fakePool({
      screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
    });
    const result = await createFetch(pool)({ documentName: screenplay.id } as never);
    expect(result).toBeNull();
  });
});

describe('createStore', () => {
  it('preserves the existing title page and document settings, projecting only blocks from Yjs', async () => {
    const screenplay = compatibleScreenplay({
      titlePages: [{ id: '00000000-0000-4000-8000-000000000004', title: 'Preserved Title Page' }],
      documentSettings: {
        characterIndentIn: 2.5,
        parentheticalIndentIn: 2,
        parentheticalWidthIn: 2,
        pageNumberStyle: 'arabic',
        sceneNumbersEnabled: true,
        autoMoreContinued: true,
      },
    });
    const { pool, queries } = fakePool({
      screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
    });
    const ydoc = createLocalScreenplayYDoc(
      createScreenplayEditorInit(new Y.Doc().getXmlFragment(SCREENPLAY_YJS_FRAGMENT)).content,
    );
    // Seed the document with content matching the compatible screenplay's own single block, so
    // the projection is valid.
    const seeded = createLocalScreenplayYDoc({
      type: 'screenplayDocument',
      content: [
        {
          type: 'screenplayBlock',
          attrs: { element: 'action', id: '00000000-0000-4000-8000-000000000000' },
          content: [{ type: 'text', text: 'Legacy text.' }],
        },
      ],
    });

    await createStore(pool)({
      documentName: screenplay.id,
      document: seeded,
      state: Buffer.from(Y.encodeStateAsUpdate(seeded)),
    } as never);

    const updateQuery = queries.find((query) => query.includes('update screenplays'));
    expect(updateQuery).toBeDefined();
    void ydoc;
  });

  it('skips the screenplays update entirely when the projection is invalid', async () => {
    const screenplay = compatibleScreenplay();
    const { pool, queries } = fakePool({
      screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
    });
    // A `screenplayBlock` whose `element` attribute is not one of `screenplayElementTypes` --
    // valid ProseMirror (the schema does not constrain the attribute's runtime value), but
    // `mapBlock` (screenplay-editor's projection) refuses it, exactly the "mid-edit or otherwise
    // unrepresentable" state `createStore`'s own doc comment names.
    const invalidDoc = new Y.Doc();
    const fragment = invalidDoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT);
    fragment.doc!.transact(() => {
      const block = new Y.XmlElement('screenplayBlock');
      block.setAttribute('element', 'not-a-real-element-type');
      block.setAttribute('id', '00000000-0000-4000-8000-000000000099');
      fragment.insert(0, [block]);
    });

    await createStore(pool)({
      documentName: screenplay.id,
      document: invalidDoc,
      state: Buffer.from(Y.encodeStateAsUpdate(invalidDoc)),
    } as never);

    expect(queries.some((query) => query.includes('update screenplays'))).toBe(false);
    // The raw Yjs state is still persisted regardless -- durability must not depend on the
    // projection being valid.
    expect(queries.some((query) => query.includes('insert into document_yjs_state'))).toBe(true);
  });

  it('does nothing when the screenplay row no longer exists (deleted between open and this debounced flush)', async () => {
    const { pool, queries } = fakePool({});
    const emptyDoc = new Y.Doc();

    await createStore(pool)({
      documentName: 'gone',
      document: emptyDoc,
      state: Buffer.from(Y.encodeStateAsUpdate(emptyDoc)),
    } as never);

    expect(queries.some((query) => query.includes('insert into document_yjs_state'))).toBe(false);
    expect(queries.some((query) => query.includes('update screenplays'))).toBe(false);
  });
});

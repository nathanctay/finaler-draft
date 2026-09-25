import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createLocalScreenplayYDoc,
  createScreenplayEditorInit,
  documentSettingsFromYMap,
  DOCUMENT_SETTINGS_YJS_MAP,
  isDocumentSettingsMapSeeded,
  isTitlePageMapSeeded,
  projectYDocScreenplay,
  SCREENPLAY_YJS_FRAGMENT,
  seedScreenplayYDoc,
  titlePageFromYMap,
  TITLE_PAGE_YJS_MAP,
  writeTitlePageToYMap,
} from '@finaler-draft/screenplay-editor';
import { screenplaySchema, type DocumentSettings, type TitlePage } from '@finaler-draft/screenplay';
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
 * `authenticate.test.ts`'s fake `Queryable` uses. Records both the raw SQL text (`queries`, for
 * tests that only care *whether* a query ran) and `{ text, values }` pairs (`calls`, for tests
 * that need to inspect what was actually persisted). */
function fakePool(responses: {
  documentYjsState?: { state: Buffer } | undefined;
  screenplay?: { title: string; canonicalScreenplay: unknown } | undefined;
}) {
  const queries: string[] = [];
  const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push(text);
      calls.push({ text, values });
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
  return { pool: pool as unknown as Pool, queries, calls };
}

/** A seeded Y.Doc's encoded state, for a stored-state fixture -- `createFetch`'s "row already
 * exists" branch now genuinely decodes the stored bytes (to check whether the title page/document
 * settings maps are seeded), so a stored-state fixture must be real encoded Yjs, not arbitrary
 * bytes the way the old pass-through-only implementation could get away with. */
function encodedState(doc: Y.Doc): Buffer {
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

describe('createFetch', () => {
  it('returns the stored state unchanged, with no canonical query at all, when the document is already fully seeded', async () => {
    const seeded = seedScreenplayYDoc(
      createScreenplayEditorInit(new Y.Doc().getXmlFragment(SCREENPLAY_YJS_FRAGMENT)).content,
      { id: '00000000-0000-4000-8000-000000000050', title: 'Already Seeded' },
      {
        characterIndentIn: 3.7,
        parentheticalIndentIn: 3.1,
        parentheticalWidthIn: 2,
        pageNumberStyle: 'arabic',
        sceneNumbersEnabled: false,
        autoMoreContinued: true,
      },
    );
    const state = encodedState(seeded);
    const { pool, calls } = fakePool({ documentYjsState: { state } });

    const result = await createFetch(pool)({ documentName: 'doc-1' } as never);

    expect(result).toEqual(new Uint8Array(state));
    expect(calls.some((call) => call.text.includes('canonical_screenplay'))).toBe(false);
  });

  it('seeds a fresh Yjs update -- body, title page, and document settings together -- when no state row exists', async () => {
    const screenplay = compatibleScreenplay({
      titlePages: [{ id: '00000000-0000-4000-8000-000000000060', title: 'A Real Title' }],
      documentSettings: {
        characterIndentIn: 2.9,
        parentheticalIndentIn: 2.4,
        parentheticalWidthIn: 2,
        pageNumberStyle: 'roman',
        sceneNumbersEnabled: true,
        autoMoreContinued: false,
      },
    });
    const { pool } = fakePool({
      screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
    });
    const result = await createFetch(pool)({ documentName: screenplay.id } as never);
    expect(result).not.toBeNull();
    const seededDoc = new Y.Doc();
    Y.applyUpdate(seededDoc, result!);
    expect(seededDoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT).toString()).toContain('Legacy text.');
    expect(titlePageFromYMap(seededDoc.getMap(TITLE_PAGE_YJS_MAP))).toEqual(
      screenplay.titlePages[0],
    );
    expect(documentSettingsFromYMap(seededDoc.getMap(DOCUMENT_SETTINGS_YJS_MAP))).toEqual(
      screenplay.documentSettings,
    );
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

  describe('migration: a Yjs document that predates title pages/document settings living in Yjs', () => {
    it('backfills the title page and document settings from canonical_screenplay when the stored document has neither', async () => {
      // Models a screenplay that was already opened collaboratively under the pre-this-slice
      // code: it has a real `document_yjs_state` row (body content only -- the title page and
      // document settings maps were never written, since that concept didn't exist yet).
      const preSliceDoc = createLocalScreenplayYDoc(
        createScreenplayEditorInit(new Y.Doc().getXmlFragment(SCREENPLAY_YJS_FRAGMENT)).content,
      );
      const state = encodedState(preSliceDoc);
      const canonicalTitlePage: TitlePage = {
        id: '00000000-0000-4000-8000-000000000070',
        title: 'The Owner Real Screenplay',
        authors: ['A Real Writer'],
      };
      const canonicalSettings: DocumentSettings = {
        characterIndentIn: 3.7,
        parentheticalIndentIn: 3.1,
        parentheticalWidthIn: 2,
        pageNumberStyle: 'arabic',
        sceneNumbersEnabled: false,
        autoMoreContinued: true,
      };
      const screenplay = compatibleScreenplay({
        titlePages: [canonicalTitlePage],
        documentSettings: canonicalSettings,
      });
      const { pool, calls } = fakePool({
        documentYjsState: { state },
        screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
      });

      const result = await createFetch(pool)({ documentName: screenplay.id } as never);

      expect(result).not.toBeNull();
      // The migration is a real, distinct write, not a no-op: the returned bytes differ from what
      // was stored.
      expect(result).not.toEqual(new Uint8Array(state));
      expect(calls.some((call) => call.text.includes('canonical_screenplay'))).toBe(true);

      const migratedDoc = new Y.Doc();
      Y.applyUpdate(migratedDoc, result!);
      expect(titlePageFromYMap(migratedDoc.getMap(TITLE_PAGE_YJS_MAP))).toEqual(canonicalTitlePage);
      expect(documentSettingsFromYMap(migratedDoc.getMap(DOCUMENT_SETTINGS_YJS_MAP))).toEqual(
        canonicalSettings,
      );
      // The pre-existing body content is untouched -- the migration only ever adds the two maps,
      // never rebuilds the document.
      expect(migratedDoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT).toString()).toEqual(
        preSliceDoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT).toString(),
      );
    });

    it('is idempotent: never overwrites a title page a writer has already edited collaboratively, even when canonical_screenplay disagrees', async () => {
      // A writer already edited the title page collaboratively (through this slice's own save
      // path) since the document was first opened -- the map is seeded, with content that has
      // since diverged from whatever is sitting in `canonical_screenplay` (a stale read, or a
      // debounce window not yet flushed). This is exactly the scenario the migration must never
      // clobber.
      const doc = createLocalScreenplayYDoc(
        createScreenplayEditorInit(new Y.Doc().getXmlFragment(SCREENPLAY_YJS_FRAGMENT)).content,
      );
      const writerEditedTitlePage: TitlePage = {
        id: '00000000-0000-4000-8000-000000000080',
        title: "The Writer's Current Title",
      };
      doc.transact(() => {
        writeTitlePageToYMap(doc.getMap(TITLE_PAGE_YJS_MAP), writerEditedTitlePage);
      });
      const state = encodedState(doc);

      const staleCanonicalTitlePage: TitlePage = {
        id: '00000000-0000-4000-8000-000000000081',
        title: 'A Stale, Different Title',
      };
      const screenplay = compatibleScreenplay({ titlePages: [staleCanonicalTitlePage] });
      const { pool } = fakePool({
        documentYjsState: { state },
        screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
      });

      const result = await createFetch(pool)({ documentName: screenplay.id } as never);

      expect(result).not.toBeNull();
      const resultDoc = new Y.Doc();
      Y.applyUpdate(resultDoc, result!);
      // The writer's own collaborative edit survives untouched -- not overwritten by the stale
      // canonical row.
      expect(titlePageFromYMap(resultDoc.getMap(TITLE_PAGE_YJS_MAP))).toEqual(
        writerEditedTitlePage,
      );
    });

    it('leaves a genuinely title-page-less screenplay unseeded, not inventing content from nothing', async () => {
      const preSliceDoc = createLocalScreenplayYDoc(
        createScreenplayEditorInit(new Y.Doc().getXmlFragment(SCREENPLAY_YJS_FRAGMENT)).content,
      );
      const state = encodedState(preSliceDoc);
      const screenplay = compatibleScreenplay({ titlePages: [] });
      const { pool } = fakePool({
        documentYjsState: { state },
        screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
      });

      const result = await createFetch(pool)({ documentName: screenplay.id } as never);

      expect(result).not.toBeNull();
      const resultDoc = new Y.Doc();
      Y.applyUpdate(resultDoc, result!);
      expect(isTitlePageMapSeeded(resultDoc.getMap(TITLE_PAGE_YJS_MAP))).toBe(false);
      // Document settings are real on this fixture (`compatibleScreenplay`'s schema default), so
      // that map is still backfilled even though the title page is not -- the two are independent.
      expect(isDocumentSettingsMapSeeded(resultDoc.getMap(DOCUMENT_SETTINGS_YJS_MAP))).toBe(true);
    });

    it('hands back the stored state unchanged, not throwing, when the screenplay row has been deleted since', async () => {
      const preSliceDoc = createLocalScreenplayYDoc(
        createScreenplayEditorInit(new Y.Doc().getXmlFragment(SCREENPLAY_YJS_FRAGMENT)).content,
      );
      const state = encodedState(preSliceDoc);
      const { pool } = fakePool({ documentYjsState: { state } });

      const result = await createFetch(pool)({ documentName: 'gone' } as never);

      expect(result).toEqual(new Uint8Array(state));
    });
  });
});

describe('createStore', () => {
  it("reads the title page and document settings from the Y.Doc's own maps, not the existing row -- proving the old pass-through is gone", async () => {
    // The existing row deliberately disagrees with the Y.Doc: if `createStore` still read from the
    // row (the pre-this-slice pass-through), the persisted projection would carry the row's stale
    // values instead of the doc's real ones.
    const staleRowTitlePage: TitlePage = {
      id: '00000000-0000-4000-8000-000000000090',
      title: 'Stale Row Title Page',
    };
    const screenplay = compatibleScreenplay({ titlePages: [staleRowTitlePage] });
    const { pool, calls } = fakePool({
      screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
    });

    const liveTitlePage: TitlePage = {
      id: '00000000-0000-4000-8000-000000000091',
      title: 'Live Yjs Title Page',
    };
    const liveSettings: DocumentSettings = {
      characterIndentIn: 3,
      parentheticalIndentIn: 2.5,
      parentheticalWidthIn: 1.5,
      pageNumberStyle: 'roman',
      sceneNumbersEnabled: true,
      autoMoreContinued: false,
    };
    const seeded = seedScreenplayYDoc(
      {
        type: 'screenplayDocument',
        content: [
          {
            type: 'screenplayBlock',
            attrs: { element: 'action', id: '00000000-0000-4000-8000-000000000000' },
            content: [{ type: 'text', text: 'Legacy text.' }],
          },
        ],
      },
      liveTitlePage,
      liveSettings,
    );

    await createStore(pool)({
      documentName: screenplay.id,
      document: seeded,
      state: Buffer.from(Y.encodeStateAsUpdate(seeded)),
    } as never);

    const updateCall = calls.find((call) => call.text.includes('update screenplays'));
    expect(updateCall).toBeDefined();
    const persisted = JSON.parse(updateCall!.values![0] as string);
    expect(persisted.titlePages).toEqual([liveTitlePage]);
    expect(persisted.documentSettings).toEqual(liveSettings);
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

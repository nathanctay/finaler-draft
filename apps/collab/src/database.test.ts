import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

// `createFetch`/`createStore` (database.ts) now delegate the durable-log mechanics entirely to
// `updateLog.ts` -- append, checkpoint, compaction, and reconstruction are proven directly against
// a real row-level model in `updateLog.test.ts`. What is left to prove *here* is the orchestration
// built on top: which of `updateLog.ts`'s functions `database.ts` calls, in what order, and with
// what data, for each of createFetch's/createStore's own branches (already-seeded, migration
// backfill, brand-new seed, invalid projection, deleted screenplay). Mocking `updateLog.ts` is what
// makes that separation possible without database.test.ts also having to re-implement a SQL-level
// fake of two tables it does not itself query.
vi.mock('./updateLog.js', () => ({
  reconstructDocumentState: vi.fn(),
  writeCheckpoint: vi.fn(),
  createCheckpoint: vi.fn(),
}));

// Collaboration slice 4a's structural-change revision trigger (`revisions.ts`, called from
// `createStore` below) is proven on its own terms in `revisions.test.ts`, against a real model of
// `document_revisions` -- mocked here for the identical separation-of-concerns reason `updateLog.js`
// is mocked above: this file's own `fakePool` only models the `screenplays` table queries
// `database.ts` issues directly, and has no reason to also grow a fake `document_revisions` table
// just to keep `createStore`'s own tests passing.
vi.mock('./revisions.js', () => ({
  maybeCreateStructuralChangeRevision: vi.fn(),
}));

import { createFetch, createStore, DEFAULT_EPOCH } from './database.js';
import { reconstructDocumentState, writeCheckpoint, createCheckpoint } from './updateLog.js';
import { maybeCreateStructuralChangeRevision } from './revisions.js';

const mockReconstructDocumentState = reconstructDocumentState as ReturnType<typeof vi.fn>;
const mockWriteCheckpoint = writeCheckpoint as ReturnType<typeof vi.fn>;
const mockCreateCheckpoint = createCheckpoint as ReturnType<typeof vi.fn>;
const mockMaybeCreateStructuralChangeRevision = maybeCreateStructuralChangeRevision as ReturnType<
  typeof vi.fn
>;

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

/** A fake `pg.Pool` for the queries `database.ts` still issues directly (the `screenplays` table
 * only -- everything durable-log-related goes through the mocked `updateLog.ts` above). */
function fakePool(responses: { screenplay?: { title: string; canonicalScreenplay: unknown } }) {
  const queries: string[] = [];
  const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  const pool = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push(text);
      calls.push({ text, values });
      if (text.startsWith('select canonical_screenplay')) {
        return {
          rows: responses.screenplay
            ? [{ canonicalScreenplay: responses.screenplay.canonicalScreenplay }]
            : [],
        };
      }
      if (text.startsWith('select title, canonical_screenplay')) {
        return { rows: responses.screenplay ? [responses.screenplay] : [] };
      }
      if (text.startsWith('update screenplays')) {
        return { rows: [] };
      }
      throw new Error(
        `Unexpected query in test double: ${text} (values: ${JSON.stringify(values)})`,
      );
    },
  };
  return { pool: pool as unknown as Pool, queries, calls };
}

function bareDoc(): Y.Doc {
  return createLocalScreenplayYDoc(
    createScreenplayEditorInit(new Y.Doc().getXmlFragment(SCREENPLAY_YJS_FRAGMENT)).content,
  );
}

beforeEach(() => {
  mockReconstructDocumentState.mockReset();
  mockWriteCheckpoint.mockReset();
  mockCreateCheckpoint.mockReset();
  mockMaybeCreateStructuralChangeRevision.mockReset().mockResolvedValue(undefined);
});

describe('createFetch', () => {
  it('returns the reconstructed state unchanged, with no canonical query at all, when the document is already fully seeded', async () => {
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
    mockReconstructDocumentState.mockResolvedValue({ doc: seeded, throughSequence: 5 });
    const { pool, calls } = fakePool({});

    const result = await createFetch(pool)({ documentName: 'doc-1' } as never);

    expect(result).toEqual(Y.encodeStateAsUpdate(seeded));
    expect(mockReconstructDocumentState).toHaveBeenCalledWith(pool, 'doc-1', DEFAULT_EPOCH);
    expect(calls).toHaveLength(0);
    expect(mockWriteCheckpoint).not.toHaveBeenCalled();
  });

  it('seeds a fresh Yjs update -- body, title page, and document settings together -- and persists it as the first checkpoint, when no checkpoint exists yet', async () => {
    mockReconstructDocumentState.mockResolvedValue(undefined);
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
    // The seed is durable *before* fetch returns -- writeCheckpoint at throughSequence 0, so a
    // future delta appended relative to it has a real base to integrate against.
    expect(mockWriteCheckpoint).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        screenplayId: screenplay.id,
        epoch: DEFAULT_EPOCH,
        throughSequence: 0,
      }),
    );
  });

  it('seeds exactly one empty action block when the canonical screenplay has no blocks at all, so there is somewhere for the caret to go', async () => {
    mockReconstructDocumentState.mockResolvedValue(undefined);
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

  it('returns null, writing no checkpoint, when neither a checkpoint nor a screenplay row exists', async () => {
    mockReconstructDocumentState.mockResolvedValue(undefined);
    const { pool } = fakePool({});
    const result = await createFetch(pool)({ documentName: 'missing' } as never);
    expect(result).toBeNull();
    expect(mockWriteCheckpoint).not.toHaveBeenCalled();
  });

  it('returns null, rather than throwing, when the canonical screenplay has features this editor cannot represent', async () => {
    mockReconstructDocumentState.mockResolvedValue(undefined);
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
    expect(mockWriteCheckpoint).not.toHaveBeenCalled();
  });

  describe('migration: a Yjs document that predates title pages/document settings living in Yjs', () => {
    it('backfills the title page and document settings from canonical_screenplay when the reconstructed document has neither, and persists a supplementary checkpoint', async () => {
      const preSliceDoc = bareDoc();
      mockReconstructDocumentState.mockResolvedValue({ doc: preSliceDoc, throughSequence: 7 });
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
      const { pool } = fakePool({
        screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
      });

      const result = await createFetch(pool)({ documentName: screenplay.id } as never);

      expect(result).not.toBeNull();
      const migratedDoc = new Y.Doc();
      Y.applyUpdate(migratedDoc, result!);
      expect(titlePageFromYMap(migratedDoc.getMap(TITLE_PAGE_YJS_MAP))).toEqual(canonicalTitlePage);
      expect(documentSettingsFromYMap(migratedDoc.getMap(DOCUMENT_SETTINGS_YJS_MAP))).toEqual(
        canonicalSettings,
      );
      expect(migratedDoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT).toString()).toEqual(
        preSliceDoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT).toString(),
      );
      // The supplementary checkpoint carries the *existing* throughSequence forward unchanged --
      // this enriches the checkpoint's content, it does not claim to have absorbed anything new.
      expect(mockWriteCheckpoint).toHaveBeenCalledWith(
        pool,
        expect.objectContaining({
          screenplayId: screenplay.id,
          epoch: DEFAULT_EPOCH,
          throughSequence: 7,
        }),
      );
    });

    it('is idempotent: never overwrites a title page a writer has already edited collaboratively, even when canonical_screenplay disagrees, and writes no supplementary checkpoint', async () => {
      const doc = bareDoc();
      const writerEditedTitlePage: TitlePage = {
        id: '00000000-0000-4000-8000-000000000080',
        title: "The Writer's Current Title",
      };
      doc.transact(() => {
        writeTitlePageToYMap(doc.getMap(TITLE_PAGE_YJS_MAP), writerEditedTitlePage);
      });
      mockReconstructDocumentState.mockResolvedValue({ doc, throughSequence: 3 });

      const staleCanonicalTitlePage: TitlePage = {
        id: '00000000-0000-4000-8000-000000000081',
        title: 'A Stale, Different Title',
      };
      const screenplay = compatibleScreenplay({ titlePages: [staleCanonicalTitlePage] });
      const { pool } = fakePool({
        screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
      });

      const result = await createFetch(pool)({ documentName: screenplay.id } as never);

      expect(result).not.toBeNull();
      const resultDoc = new Y.Doc();
      Y.applyUpdate(resultDoc, result!);
      expect(titlePageFromYMap(resultDoc.getMap(TITLE_PAGE_YJS_MAP))).toEqual(
        writerEditedTitlePage,
      );
      // Document settings are unseeded here too but the fixture has real settings, so a
      // supplementary write still happens for *that* map -- only a fully-seeded document skips it
      // entirely (covered by the "already fully seeded" test above).
      expect(mockWriteCheckpoint).toHaveBeenCalledWith(
        pool,
        expect.objectContaining({ throughSequence: 3 }),
      );
    });

    it('leaves a genuinely title-page-less screenplay unseeded, not inventing content from nothing', async () => {
      const preSliceDoc = bareDoc();
      mockReconstructDocumentState.mockResolvedValue({ doc: preSliceDoc, throughSequence: 0 });
      const screenplay = compatibleScreenplay({ titlePages: [] });
      const { pool } = fakePool({
        screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
      });

      const result = await createFetch(pool)({ documentName: screenplay.id } as never);

      expect(result).not.toBeNull();
      const resultDoc = new Y.Doc();
      Y.applyUpdate(resultDoc, result!);
      expect(isTitlePageMapSeeded(resultDoc.getMap(TITLE_PAGE_YJS_MAP))).toBe(false);
      expect(isDocumentSettingsMapSeeded(resultDoc.getMap(DOCUMENT_SETTINGS_YJS_MAP))).toBe(true);
    });

    it('hands back the reconstructed state unchanged, not throwing and writing no checkpoint, when the screenplay row has been deleted since', async () => {
      const preSliceDoc = bareDoc();
      mockReconstructDocumentState.mockResolvedValue({ doc: preSliceDoc, throughSequence: 2 });
      const { pool } = fakePool({});

      const result = await createFetch(pool)({ documentName: 'gone' } as never);

      expect(result).toEqual(Y.encodeStateAsUpdate(preSliceDoc));
      expect(mockWriteCheckpoint).not.toHaveBeenCalled();
    });
  });
});

describe('createStore', () => {
  it("reads the title page and document settings from the Y.Doc's own maps, not the existing row -- proving the old pass-through is gone -- and compacts via createCheckpoint", async () => {
    const staleRowTitlePage: TitlePage = {
      id: '00000000-0000-4000-8000-000000000090',
      title: 'Stale Row Title Page',
    };
    const screenplay = compatibleScreenplay({ titlePages: [staleRowTitlePage] });
    const { pool, calls } = fakePool({
      screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
    });
    mockCreateCheckpoint.mockResolvedValue({ throughSequence: 4 });

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

    expect(mockCreateCheckpoint).toHaveBeenCalledWith(pool, {
      screenplayId: screenplay.id,
      epoch: DEFAULT_EPOCH,
    });
    const updateCall = calls.find((call) => call.text.startsWith('update screenplays'));
    expect(updateCall).toBeDefined();
    const persisted = JSON.parse(updateCall!.values![0] as string);
    expect(persisted.titlePages).toEqual([liveTitlePage]);
    expect(persisted.documentSettings).toEqual(liveSettings);
    // The structural-change revision trigger runs on the exact same valid projection just
    // persisted above -- see `revisions.test.ts` for what it does with it.
    expect(mockMaybeCreateStructuralChangeRevision).toHaveBeenCalledWith(pool, {
      screenplayId: screenplay.id,
      epoch: DEFAULT_EPOCH,
      screenplay: persisted,
    });
  });

  it('never regresses the canonical write when the structural-change trigger itself throws', async () => {
    const screenplay = compatibleScreenplay();
    const { pool } = fakePool({
      screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
    });
    mockCreateCheckpoint.mockResolvedValue({ throughSequence: 1 });
    mockMaybeCreateStructuralChangeRevision.mockRejectedValue(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      createStore(pool)({
        documentName: screenplay.id,
        document: bareDoc(),
        state: Buffer.from(Y.encodeStateAsUpdate(bareDoc())),
      } as never),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('structural_change_revision_failed'),
    );
    errorSpy.mockRestore();
  });

  it('skips the screenplays update entirely when the projection is invalid, but still compacts', async () => {
    const screenplay = compatibleScreenplay();
    const { pool, queries } = fakePool({
      screenplay: { title: 'Row Title', canonicalScreenplay: screenplay },
    });
    mockCreateCheckpoint.mockResolvedValue(undefined);
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

    expect(mockCreateCheckpoint).toHaveBeenCalled();
    expect(queries.some((query) => query.startsWith('update screenplays'))).toBe(false);
  });

  it('does nothing -- not even compaction -- when the screenplay row no longer exists (deleted between open and this debounced flush)', async () => {
    const { pool, queries } = fakePool({});
    const emptyDoc = new Y.Doc();

    await createStore(pool)({
      documentName: 'gone',
      document: emptyDoc,
      state: Buffer.from(Y.encodeStateAsUpdate(emptyDoc)),
    } as never);

    expect(queries.some((query) => query.startsWith('update screenplays'))).toBe(false);
    expect(mockCreateCheckpoint).not.toHaveBeenCalled();
  });
});

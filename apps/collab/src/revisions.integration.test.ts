import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { seedScreenplayYDoc, type EditorContent } from '@finaler-draft/screenplay-editor';
import { createStore, DEFAULT_EPOCH } from './database.js';
import { createIdleSessionRevisionScheduler, maybeCreateIdleSessionRevision } from './revisions.js';
import { writeCheckpoint } from './updateLog.js';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';

/**
 * Collaboration slice 4a, proven against a real, migrated Postgres database -- the brief's own
 * explicit requirement: "a revision is written with the exact projection at that moment; a later
 * edit does not mutate it; no revision is created when the hash is unchanged." A real database,
 * not a fake pool, is what actually proves the advisory-lock dedupe in
 * `@finaler-draft/database`'s `insertRevisionIfChanged` holds under Postgres's own transaction
 * semantics -- `revisions.test.ts` (this package) already proves the orchestration logic against a
 * fake pool; this file proves the same triggers end to end against the real table.
 *
 * No Hocuspocus `Server` or WebSocket here, unlike `collaboration.integration.test.ts` -- these
 * triggers live entirely inside `createStore`/`maybeCreateIdleSessionRevision`, both plain
 * functions over a `Pool`, so driving them directly is a more direct exercise of the exact claim
 * under test than adding a socket layer neither trigger depends on.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;

let admin: Pool | undefined;
let pool: Pool | undefined;
let databaseCreated = false;

describe.skipIf(!databaseUrl)('collaboration slice 4a revisions (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);
    pool = createIntegrationPool({ connectionString: databaseUrl });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  it('captures a structural_change revision with the exact projection at that moment, and a later, unrelated minor edit never mutates it', async () => {
    const screenplayId = await createScreenplay();

    // 8 blocks: one scene heading plus seven action lines -- large enough that editing exactly one
    // of them later stays comfortably under the 25% block-ratio threshold (1/8 = 12.5%).
    const before = buildDoc([sceneHeading(0, 'INT. KITCHEN - DAY'), ...actionBlocks(1, 7)]);
    await createStore(pool!)({
      documentName: screenplayId,
      document: before,
      state: Buffer.from(Y.encodeStateAsUpdate(before)),
    } as never);

    const afterFirstSave = await fetchRevisions(screenplayId);
    expect(afterFirstSave).toHaveLength(1);
    const captured = afterFirstSave[0]!;
    expect(captured.kind).toBe('structural_change');
    expect(captured.canonicalScreenplay.blocks).toHaveLength(8);
    expect(captured.canonicalScreenplay.blocks[0]).toMatchObject({
      type: 'scene_heading',
      text: 'INT. KITCHEN - DAY',
    });

    // A later, unrelated minor edit -- one action block's text changes, well under the
    // structural-change threshold, so this must not create a second revision.
    const after = buildDoc([
      sceneHeading(0, 'INT. KITCHEN - DAY'),
      ...actionBlocks(1, 6),
      { id: blockId(7), type: 'action', text: 'Edited on a later save.' },
    ]);
    await createStore(pool!)({
      documentName: screenplayId,
      document: after,
      state: Buffer.from(Y.encodeStateAsUpdate(after)),
    } as never);

    const afterSecondSave = await fetchRevisions(screenplayId);
    expect(afterSecondSave).toHaveLength(1);
    // The one existing revision is byte-identical to what was captured after the first save --
    // proof this is immutable, not merely "still one row by coincidence."
    expect(afterSecondSave[0]).toEqual(captured);

    // The *live*, mutable projection did move on to the later edit -- confirming the revision's
    // stability above is because it is a genuinely separate, immutable copy, not because the
    // second save was silently a no-op.
    const liveRow = await pool!.query<{ canonicalScreenplay: { blocks: unknown[] } }>(
      'select canonical_screenplay as "canonicalScreenplay" from screenplays where id = $1',
      [screenplayId],
    );
    expect((liveRow.rows[0]!.canonicalScreenplay.blocks[7] as { text: string }).text).toBe(
      'Edited on a later save.',
    );
  });

  it('a genuine second revision is appended, never written over the first -- the immutability case a non-creating save cannot prove', async () => {
    const screenplayId = await createScreenplay();

    const before = buildDoc([sceneHeading(0, 'INT. KITCHEN - DAY'), ...actionBlocks(1, 7)]);
    await createStore(pool!)({
      documentName: screenplayId,
      document: before,
      state: Buffer.from(Y.encodeStateAsUpdate(before)),
    } as never);

    const afterFirst = await fetchRevisions(screenplayId);
    expect(afterFirst).toHaveLength(1);
    const first = afterFirst[0]!;

    // A *structural* change this time -- a second scene heading, so the scene delta is 1 and a
    // second revision genuinely has to be inserted. This is the case the suite was missing: the
    // existing tests either create one revision, or deliberately create none, so nothing forced
    // two real inserts against the same screenplay. An implementation that wrote a revision in
    // place rather than appending one would satisfy every other test here and fail only this.
    const after = buildDoc([
      sceneHeading(0, 'INT. KITCHEN - DAY'),
      ...actionBlocks(1, 7),
      sceneHeading(8, 'EXT. DRIVEWAY - NIGHT'),
      ...actionBlocks(9, 3),
    ]);
    await createStore(pool!)({
      documentName: screenplayId,
      document: after,
      state: Buffer.from(Y.encodeStateAsUpdate(after)),
    } as never);

    const afterSecond = await fetchRevisions(screenplayId);
    expect(afterSecond).toHaveLength(2);
    // The first revision is byte-identical to what it was before the second insert: same id, same
    // hash, same canonical projection, same `created_at`. Comparing the whole row rather than a
    // field or two is deliberate -- an in-place write that happened to preserve the id would still
    // be caught here.
    expect(afterSecond[0]).toEqual(first);
    // And the second is genuinely a different revision of different content, so the assertion
    // above cannot be passing merely because nothing was written at all.
    expect(afterSecond[1]!.id).not.toBe(first.id);
    expect(afterSecond[1]!.canonicalHash).not.toBe(first.canonicalHash);
    expect(afterSecond[1]!.canonicalScreenplay.blocks).toHaveLength(12);
  });

  it('never creates a second revision across repeated debounced saves that carry no real change -- the pagination-repagination case', async () => {
    const screenplayId = await createScreenplay();
    const doc = buildDoc([sceneHeading(0, 'INT. KITCHEN - DAY'), ...actionBlocks(1, 7)]);

    // Two debounced saves in a row with the *identical* document content -- standing in for
    // Hocuspocus's own `onStoreDocument` firing again after a decoration-only pagination
    // recompute that never touched the Yjs document at all (plan.md's exact stated trap).
    await createStore(pool!)({
      documentName: screenplayId,
      document: doc,
      state: Buffer.from(Y.encodeStateAsUpdate(doc)),
    } as never);
    const hashAfterFirst = await fetchCanonicalHash(screenplayId);
    const revisionsAfterFirst = await fetchRevisions(screenplayId);
    expect(revisionsAfterFirst).toHaveLength(1);

    await createStore(pool!)({
      documentName: screenplayId,
      document: doc,
      state: Buffer.from(Y.encodeStateAsUpdate(doc)),
    } as never);
    const hashAfterSecond = await fetchCanonicalHash(screenplayId);
    const revisionsAfterSecond = await fetchRevisions(screenplayId);

    expect(hashAfterSecond).toBe(hashAfterFirst);
    expect(revisionsAfterSecond).toHaveLength(1);
    expect(revisionsAfterSecond[0]).toEqual(revisionsAfterFirst[0]);
  });

  it('creates an idle-session revision from the durably reconstructed document, and never a duplicate on repeated idle fires with no new activity', async () => {
    const screenplayId = await createScreenplay();
    const doc = buildDoc([sceneHeading(0, 'INT. KITCHEN - DAY'), ...actionBlocks(1, 3)]);
    // The identical bootstrap `createFetch` performs for a screenplay's first-ever collaborative
    // open: persist the seed as a checkpoint *before* anything reads it back, so
    // `reconstructDocumentState` (what `maybeCreateIdleSessionRevision` reads from) has something
    // durable to reconstruct.
    await writeCheckpoint(pool!, {
      screenplayId,
      epoch: DEFAULT_EPOCH,
      throughSequence: 0,
      doc,
    });

    const first = await maybeCreateIdleSessionRevision(pool!, {
      screenplayId,
      epoch: DEFAULT_EPOCH,
    });
    expect(first?.created).toBe(true);
    expect(first?.kind).toBe('idle_session');
    const rows = await fetchRevisions(screenplayId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.canonicalScreenplay.blocks).toHaveLength(4);

    // Fired again with no new checkpoint and no new activity: the reconstructed document is
    // identical, so this must not create a second revision.
    const second = await maybeCreateIdleSessionRevision(pool!, {
      screenplayId,
      epoch: DEFAULT_EPOCH,
    });
    expect(second?.created).toBe(false);
    expect(await fetchRevisions(screenplayId)).toHaveLength(1);
  });

  it('the idle-session scheduler itself fires the real trigger after genuine silence, against the real database', async () => {
    const screenplayId = await createScreenplay();
    const doc = buildDoc([sceneHeading(0, 'INT. KITCHEN - DAY'), ...actionBlocks(1, 2)]);
    await writeCheckpoint(pool!, {
      screenplayId,
      epoch: DEFAULT_EPOCH,
      throughSequence: 0,
      doc,
    });

    const errors: unknown[] = [];
    const scheduler = createIdleSessionRevisionScheduler(
      (id, epoch) => maybeCreateIdleSessionRevision(pool!, { screenplayId: id, epoch }),
      { idleMs: 30, onError: (error) => errors.push(error) },
    );
    scheduler.noteActivity(screenplayId, DEFAULT_EPOCH);

    await waitFor(async () => (await fetchRevisions(screenplayId)).length === 1, 2000);
    expect(errors).toEqual([]);
    const rows = await fetchRevisions(screenplayId);
    expect(rows[0]!.kind).toBe('idle_session');

    scheduler.dispose();
  });
});

interface RevisionRow {
  id: string;
  kind: string;
  label: string | null;
  canonicalScreenplay: { blocks: unknown[] };
  canonicalHash: string;
  createdAt: string;
}

async function fetchRevisions(screenplayId: string): Promise<RevisionRow[]> {
  const result = await pool!.query<RevisionRow>(
    `select id, kind, label, canonical_screenplay as "canonicalScreenplay",
            canonical_hash as "canonicalHash", created_at as "createdAt"
       from document_revisions
      where screenplay_id = $1
      order by created_at asc, id asc`,
    [screenplayId],
  );
  return result.rows;
}

async function fetchCanonicalHash(screenplayId: string): Promise<string> {
  const result = await pool!.query<{ canonicalHash: string }>(
    'select canonical_hash as "canonicalHash" from screenplays where id = $1',
    [screenplayId],
  );
  return result.rows[0]!.canonicalHash;
}

async function createScreenplay(): Promise<string> {
  const projectId = randomUUID();
  const screenplayId = randomUUID();
  await pool!.query('insert into projects (id, title) values ($1, $2)', [
    projectId,
    'Test Project',
  ]);
  // A placeholder seed row -- `createFetch` is never exercised in this file, so this content is
  // only ever read by `createStore`'s own `select title, canonical_screenplay ...` (for the
  // screenplay-level `title`, distinct from any title *page*) before it is immediately overwritten
  // by whatever `createStore` projects.
  await pool!.query(
    `insert into screenplays (id, project_id, title, canonical_screenplay, canonical_hash)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [
      screenplayId,
      projectId,
      'Test Screenplay',
      JSON.stringify({ title: 'Test Screenplay' }),
      'seed-hash',
    ],
  );
  return screenplayId;
}

function blockId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function sceneHeading(index: number, text: string) {
  return { id: blockId(index), type: 'scene_heading', text };
}

function actionBlocks(startIndex: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: blockId(startIndex + i),
    type: 'action',
    text: `Action line ${startIndex + i}.`,
  }));
}

function buildDoc(blocks: Array<{ id: string; type: string; text: string }>): Y.Doc {
  const content: EditorContent = {
    type: 'screenplayDocument',
    content: blocks.map((block) => ({
      type: 'screenplayBlock',
      attrs: {
        element: block.type as EditorContent['content'][number]['attrs']['element'],
        id: block.id,
      },
      content: [{ type: 'text', text: block.text }],
    })),
  };
  return seedScreenplayYDoc(content, undefined, undefined);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 15));
  }
}

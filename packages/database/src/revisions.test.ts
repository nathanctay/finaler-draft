import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  getRevisionById,
  insertRevisionIfChanged,
  latestRevision,
  listRevisionsForScreenplay,
  type RevisionKind,
} from './revisions.js';

/**
 * A real (if tiny) in-memory model of `document_revisions`, following the same convention
 * `apps/collab/src/updateLog.test.ts`'s own fake pool establishes: genuine row semantics (insert,
 * order-by, limit) and a genuine FIFO async mutex standing in for `pg_advisory_xact_lock`, not a
 * stub that only records which queries ran. The lock is what makes the "two concurrent writers
 * racing the dedupe check" test below meaningful -- a lock request for a key already held really
 * does not resolve until the holder's transaction commits or rolls back, the same guarantee
 * Postgres's own advisory lock gives `insertRevisionIfChanged` in production.
 */
interface Row {
  id: string;
  screenplayId: string;
  sourceEpoch: number;
  kind: RevisionKind;
  label: string | null;
  authoredBy: string | null;
  canonicalScreenplay: unknown;
  canonicalHash: string;
  renderedText: string;
  previewMetadata: unknown;
  createdAt: Date;
}

function createFakePool() {
  const rows: Row[] = [];
  let nextId = 1;
  let nextCreatedAtMs = Date.parse('2026-01-01T00:00:00.000Z');

  const mutexes = new Map<string, Promise<unknown>>();
  function acquireLock(key: string): Promise<() => void> {
    const prior = mutexes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    mutexes.set(
      key,
      prior.then(() => released),
    );
    return prior.then(() => release);
  }

  function makeClient() {
    let staged: Row[] | undefined;
    let releaseLock: (() => void) | undefined;
    const current = () => staged ?? rows;
    const writable = () => (staged ??= [...rows]);

    const client = {
      async query(text: string, values: readonly unknown[] = []) {
        const sql = text.trim();
        if (sql === 'begin') {
          staged = undefined;
          return { rows: [] };
        }
        if (sql === 'commit') {
          if (staged) {
            rows.length = 0;
            rows.push(...staged);
          }
          staged = undefined;
          releaseLock?.();
          releaseLock = undefined;
          return { rows: [] };
        }
        if (sql === 'rollback') {
          staged = undefined;
          releaseLock?.();
          releaseLock = undefined;
          return { rows: [] };
        }
        if (sql.startsWith('select pg_advisory_xact_lock')) {
          const [screenplayId, namespace] = values as [string, number];
          releaseLock = await acquireLock(`${screenplayId}:${namespace}`);
          return { rows: [] };
        }
        if (sql.startsWith('select') && sql.includes('from document_revisions')) {
          if (sql.includes('and id = $2')) {
            const [screenplayId, id] = values as [string, string];
            const row = current().find((r) => r.screenplayId === screenplayId && r.id === id);
            return { rows: row ? [serialize(row, sql)] : [] };
          }
          const [screenplayId] = values as [string];
          const matches = current()
            .filter((r) => r.screenplayId === screenplayId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          if (sql.includes('limit 1')) {
            return { rows: matches[0] ? [serialize(matches[0], sql)] : [] };
          }
          return { rows: matches.map((row) => serialize(row, sql)) };
        }
        if (sql.startsWith('insert into document_revisions')) {
          const [
            screenplayId,
            sourceEpoch,
            kind,
            label,
            authoredBy,
            canonicalScreenplayJson,
            canonicalHash,
            renderedText,
            previewMetadataJson,
          ] = values as [
            string,
            number,
            RevisionKind,
            string | null,
            string | null,
            string,
            string,
            string,
            string | null,
          ];
          const row: Row = {
            id: `revision-${nextId++}`,
            screenplayId,
            sourceEpoch,
            kind,
            label,
            authoredBy,
            canonicalScreenplay: JSON.parse(canonicalScreenplayJson) as unknown,
            canonicalHash,
            renderedText,
            previewMetadata: previewMetadataJson
              ? (JSON.parse(previewMetadataJson) as unknown)
              : null,
            createdAt: new Date(nextCreatedAtMs++),
          };
          writable().push(row);
          return { rows: [serialize(row, sql)] };
        }
        throw new Error(
          `Unexpected query in fake pool: ${sql} (values: ${JSON.stringify(values)})`,
        );
      },
      release() {},
    };
    return client;
  }

  function serialize(row: Row, sql: string): Record<string, unknown> {
    const base = {
      id: row.id,
      screenplayId: row.screenplayId,
      sourceEpoch: row.sourceEpoch,
      kind: row.kind,
      label: row.label,
      authoredBy: row.authoredBy,
      canonicalHash: row.canonicalHash,
      renderedText: row.renderedText,
      previewMetadata: row.previewMetadata,
      createdAt: row.createdAt,
    };
    return sql.includes('canonical_screenplay as "canonicalScreenplay"')
      ? { ...base, canonicalScreenplay: row.canonicalScreenplay }
      : base;
  }

  const pool = {
    async connect() {
      return makeClient() as unknown as PoolClient;
    },
    // A bare `pool.query` (no explicit `connect()` + `begin`/`commit`), used by the read helpers
    // (`latestRevision`/`listRevisionsForScreenplay`/`getRevisionById`) that accept a plain
    // `Queryable` rather than a `Pool` -- matching `apps/collab/src/updateLog.test.ts`'s identical
    // autocommit wrapper for the same reason: a single statement issued this way is its own
    // implicit transaction in real Postgres.
    async query(text: string, values?: readonly unknown[]) {
      const client = makeClient();
      await client.query('begin');
      const result = await client.query(text, values ?? []);
      await client.query('commit');
      return result;
    },
  };

  return { pool: pool as unknown as Pool, rows };
}

const SCREENPLAY_A = '00000000-0000-4000-8000-0000000000a1';
const SCREENPLAY_B = '00000000-0000-4000-8000-0000000000b2';

function params(overrides: Partial<Parameters<typeof insertRevisionIfChanged>[1]> = {}) {
  const screenplay = { id: 'x', title: 'Fixture', blocks: [] };
  return {
    screenplayId: SCREENPLAY_A,
    sourceEpoch: 0,
    kind: 'structural_change' as RevisionKind,
    label: null,
    authoredBy: null,
    canonicalScreenplayJson: JSON.stringify(screenplay),
    canonicalHash: 'hash-1',
    renderedText: 'FIXTURE\n',
    previewMetadata: { sceneCount: 0, blockCount: 0 },
    ...overrides,
  };
}

describe('insertRevisionIfChanged', () => {
  it('inserts a new revision carrying every field through unchanged', async () => {
    const { pool } = createFakePool();
    const result = await insertRevisionIfChanged(
      pool,
      params({ authoredBy: 'user-1', kind: 'named', label: 'Draft 2' }),
    );
    expect(result.created).toBe(true);
    expect(result.kind).toBe('named');
    expect(result.label).toBe('Draft 2');
    expect(result.authoredBy).toBe('user-1');
    expect(result.canonicalHash).toBe('hash-1');
    expect(result.renderedText).toBe('FIXTURE\n');
    expect(result.previewMetadata).toEqual({ sceneCount: 0, blockCount: 0 });
  });

  // The dedupe invariant this whole module exists to protect (plan.md: "If pagination mutates the
  // document, the hash changes when nobody edited anything, and revision history fills with
  // automatic commits"). This is the test named directly by the mutation-testing instruction: "make
  // revision creation skip its hash dedupe (a no-change revision must appear, and a test must
  // fail)" targets exactly the `if (existing && existing.canonicalHash === ...)` branch this test
  // exercises.
  it('never creates a second revision when the canonical hash is unchanged from the latest one', async () => {
    const { pool, rows } = createFakePool();
    const first = await insertRevisionIfChanged(pool, params({ canonicalHash: 'same-hash' }));
    const second = await insertRevisionIfChanged(
      pool,
      params({ canonicalHash: 'same-hash', kind: 'idle_session' }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    // The caller still gets back a real, existing revision id to reference (the reasoning
    // `InsertRevisionResult.created`'s own doc comment gives for an export/named caller) -- not an
    // empty or null result.
    expect(second.id).toBe(first.id);
    expect(second.kind).toBe(first.kind); // 'structural_change', the first write's own kind -- unchanged
    expect(rows).toHaveLength(1);
  });

  it('creates a new revision once the canonical hash actually changes', async () => {
    const { pool, rows } = createFakePool();
    await insertRevisionIfChanged(pool, params({ canonicalHash: 'hash-1' }));
    const second = await insertRevisionIfChanged(pool, params({ canonicalHash: 'hash-2' }));

    expect(second.created).toBe(true);
    expect(second.canonicalHash).toBe('hash-2');
    expect(rows).toHaveLength(2);
  });

  // The real defect this closes, found by a real browser test
  // (`apps/web/e2e/revision-history-persistence.spec.ts`): typing a writer's first words into an
  // empty screenplay already crosses the structural-change threshold on its own, so by the time a
  // writer explicitly names a milestone moments later, the canonical hash already matches that
  // automatic revision. Deduping the named save against it silently discarded the writer's own
  // label. `kind: 'named'` is excluded from the dedupe set specifically so this never happens.
  it('never dedupes a named revision, even when the hash exactly matches the latest (automatic) revision', async () => {
    const { pool, rows } = createFakePool();
    const automatic = await insertRevisionIfChanged(
      pool,
      params({ kind: 'structural_change', canonicalHash: 'same-hash' }),
    );
    const named = await insertRevisionIfChanged(
      pool,
      params({ kind: 'named', label: 'First milestone', canonicalHash: 'same-hash' }),
    );

    expect(automatic.created).toBe(true);
    expect(named.created).toBe(true);
    expect(named.id).not.toBe(automatic.id);
    expect(named.label).toBe('First milestone');
    expect(rows).toHaveLength(2);
  });

  it('dedupes an export revision against the latest (automatic) revision, the same as idle_session/structural_change', async () => {
    const { pool, rows } = createFakePool();
    const automatic = await insertRevisionIfChanged(
      pool,
      params({ kind: 'idle_session', canonicalHash: 'same-hash' }),
    );
    const exported = await insertRevisionIfChanged(
      pool,
      params({ kind: 'export', canonicalHash: 'same-hash' }),
    );

    expect(exported.created).toBe(false);
    expect(exported.id).toBe(automatic.id);
    expect(rows).toHaveLength(1);
  });

  it('scopes deduping to one screenplay -- an identical hash on a different screenplay still creates a revision', async () => {
    const { pool, rows } = createFakePool();
    await insertRevisionIfChanged(pool, params({ screenplayId: SCREENPLAY_A, canonicalHash: 'h' }));
    const other = await insertRevisionIfChanged(
      pool,
      params({ screenplayId: SCREENPLAY_B, canonicalHash: 'h' }),
    );

    expect(other.created).toBe(true);
    expect(rows).toHaveLength(2);
  });

  // The concurrency proof: two writers for the *same* screenplay racing the identical dedupe
  // decision must still never produce two rows with the same hash. Without
  // `acquireRevisionLock`'s advisory lock, both transactions could read "no existing revision" (or
  // "existing revision with a different hash") before either commits, and both would insert --
  // exactly the class of bug `apps/collab/src/updateLog.ts`'s own "torn read" compaction race
  // guards against, applied here to `document_revisions` instead.
  it('serializes two concurrent writers for the same screenplay so a race cannot double-insert an identical hash', async () => {
    const { pool, rows } = createFakePool();
    const [a, b] = await Promise.all([
      insertRevisionIfChanged(pool, params({ canonicalHash: 'race-hash', kind: 'idle_session' })),
      insertRevisionIfChanged(
        pool,
        params({ canonicalHash: 'race-hash', kind: 'structural_change' }),
      ),
    ]);

    expect(rows).toHaveLength(1);
    // Exactly one of the two calls actually inserted; the other deduped against it.
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.id).toBe(b.id);
  });
});

describe('latestRevision / listRevisionsForScreenplay / getRevisionById', () => {
  it('latestRevision returns the most recently created row for that screenplay only', async () => {
    const { pool } = createFakePool();
    await insertRevisionIfChanged(pool, params({ canonicalHash: 'h1' }));
    const second = await insertRevisionIfChanged(pool, params({ canonicalHash: 'h2' }));
    await insertRevisionIfChanged(
      pool,
      params({ screenplayId: SCREENPLAY_B, canonicalHash: 'h1' }),
    );

    const latest = await latestRevision(pool, SCREENPLAY_A);
    expect(latest?.id).toBe(second.id);
    expect(latest?.canonicalScreenplay).toBeDefined();
  });

  it('listRevisionsForScreenplay returns every revision for that screenplay, newest first, scoped correctly', async () => {
    const { pool } = createFakePool();
    const first = await insertRevisionIfChanged(pool, params({ canonicalHash: 'h1' }));
    const second = await insertRevisionIfChanged(pool, params({ canonicalHash: 'h2' }));
    await insertRevisionIfChanged(
      pool,
      params({ screenplayId: SCREENPLAY_B, canonicalHash: 'h1' }),
    );

    const list = await listRevisionsForScreenplay(pool, SCREENPLAY_A);
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('getRevisionById returns undefined for a revision id that belongs to a different screenplay', async () => {
    const { pool } = createFakePool();
    const revision = await insertRevisionIfChanged(
      pool,
      params({ screenplayId: SCREENPLAY_A, canonicalHash: 'h1' }),
    );

    expect(await getRevisionById(pool, SCREENPLAY_A, revision.id)).toBeDefined();
    expect(await getRevisionById(pool, SCREENPLAY_B, revision.id)).toBeUndefined();
  });
});

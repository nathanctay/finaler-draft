import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screenplayFixture, minimalScreenplayFixture } from '@finaler-draft/screenplay/fixtures';

// Isolates this file's own orchestration (membership resolution, `named` vs `export`
// authorization, which fields flow into the insert) from `@finaler-draft/database`'s write/read
// mechanics -- those are proven directly, against a real row-level model, in
// `packages/database/src/revisions.test.ts`. The identical separation-of-concerns convention
// `apps/collab/src/database.test.ts` already establishes for mocking `updateLog.js`.
vi.mock('@finaler-draft/database', () => ({
  insertRevisionIfChanged: vi.fn(),
  listRevisionsForScreenplay: vi.fn(),
  getRevisionById: vi.fn(),
}));

import {
  insertRevisionIfChanged,
  listRevisionsForScreenplay,
  getRevisionById,
} from '@finaler-draft/database';
import { createPostgresRevisionStore, createRevisionInput } from './revisions.js';

const mockInsert = insertRevisionIfChanged as ReturnType<typeof vi.fn>;
const mockList = listRevisionsForScreenplay as ReturnType<typeof vi.fn>;
const mockGetById = getRevisionById as ReturnType<typeof vi.fn>;

const actorId = 'actor-1';
const screenplayId = 'ecf1118c-3a2e-4656-84e6-fce75c461710';

function rows(values: Record<string, unknown>[]) {
  return { rowCount: values.length, rows: values };
}

function fakePool(results: Array<{ rowCount: number; rows: Record<string, unknown>[] }>) {
  return {
    query: vi.fn(async () => results.shift() ?? rows([])),
  } as never;
}

const createdAt = new Date('2026-08-06T00:00:00Z');
function revisionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'revision-1',
    screenplayId,
    sourceEpoch: 0,
    kind: 'named',
    label: 'Draft 2',
    authoredBy: actorId,
    canonicalHash: 'hash-1',
    renderedText: 'FIXTURE\n',
    previewMetadata: { sceneCount: 1, blockCount: 4 },
    createdAt,
    ...overrides,
  };
}

beforeEach(() => {
  mockInsert.mockReset();
  mockList.mockReset();
  mockGetById.mockReset();
});

describe('createRevisionInput', () => {
  it('accepts a named input with a trimmed, non-empty label', () => {
    expect(createRevisionInput.parse({ epoch: 0, kind: 'named', label: ' Draft 2 ' })).toEqual({
      epoch: 0,
      kind: 'named',
      label: 'Draft 2',
    });
  });

  it('rejects a named input with a blank or overlong label', () => {
    expect(() => createRevisionInput.parse({ epoch: 0, kind: 'named', label: '' })).toThrow();
    expect(() =>
      createRevisionInput.parse({ epoch: 0, kind: 'named', label: 'x'.repeat(201) }),
    ).toThrow();
  });

  it('accepts an export input with a known format and rejects an unknown one', () => {
    expect(createRevisionInput.parse({ epoch: 0, kind: 'export', format: 'pdf' })).toEqual({
      epoch: 0,
      kind: 'export',
      format: 'pdf',
    });
    expect(() => createRevisionInput.parse({ epoch: 0, kind: 'export', format: 'txt' })).toThrow();
  });

  it('rejects a named input carrying an export-only field, and vice versa', () => {
    expect(() =>
      createRevisionInput.parse({ epoch: 0, kind: 'named', label: 'x', format: 'pdf' }),
    ).toThrow();
    expect(() =>
      createRevisionInput.parse({ epoch: 0, kind: 'export', format: 'pdf', label: 'x' }),
    ).toThrow();
  });
});

describe('listRevisions', () => {
  it('returns "missing" for an actor with no membership on the screenplay', async () => {
    const pool = fakePool([rows([])]);
    const store = createPostgresRevisionStore(pool);
    await expect(store.listRevisions(actorId, screenplayId)).resolves.toBe('missing');
    expect(mockList).not.toHaveBeenCalled();
  });

  it('lists every revision for a member of any role, including a reviewer', async () => {
    const pool = fakePool([rows([{ role: 'reviewer' }])]);
    mockList.mockResolvedValue([revisionRow(), revisionRow({ id: 'revision-2', kind: 'export' })]);

    const store = createPostgresRevisionStore(pool);
    const result = await store.listRevisions(actorId, screenplayId);

    expect(result).not.toBe('missing');
    expect(result as unknown[]).toHaveLength(2);
    expect(mockList).toHaveBeenCalledWith(pool, screenplayId);
  });
});

describe('getRevision', () => {
  it('returns "missing" when the actor has no membership', async () => {
    const pool = fakePool([rows([])]);
    const store = createPostgresRevisionStore(pool);
    await expect(store.getRevision(actorId, screenplayId, 'revision-1')).resolves.toBe('missing');
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('returns "missing" when no such revision exists for this screenplay', async () => {
    const pool = fakePool([rows([{ role: 'owner' }])]);
    mockGetById.mockResolvedValue(undefined);
    const store = createPostgresRevisionStore(pool);
    await expect(store.getRevision(actorId, screenplayId, 'nope')).resolves.toBe('missing');
  });

  it('returns the revision with its own immutable canonical screenplay for any member, including a reviewer', async () => {
    const pool = fakePool([rows([{ role: 'reviewer' }])]);
    mockGetById.mockResolvedValue({
      ...revisionRow(),
      canonicalScreenplay: screenplayFixture,
    });
    const store = createPostgresRevisionStore(pool);

    const result = await store.getRevision(actorId, screenplayId, 'revision-1');

    expect(result).not.toBe('missing');
    expect((result as { screenplay: unknown }).screenplay).toEqual(screenplayFixture);
    expect((result as { screenplayId: string }).screenplayId).toBe(screenplayId);
  });

  it('returns "missing" rather than throwing when a stored row fails to parse as a screenplay', async () => {
    const pool = fakePool([rows([{ role: 'owner' }])]);
    mockGetById.mockResolvedValue({ ...revisionRow(), canonicalScreenplay: { not: 'valid' } });
    const store = createPostgresRevisionStore(pool);
    await expect(store.getRevision(actorId, screenplayId, 'revision-1')).resolves.toBe('missing');
  });
});

describe('createRevision', () => {
  it('returns "missing" when the actor has no membership on the screenplay', async () => {
    const pool = fakePool([rows([])]);
    const store = createPostgresRevisionStore(pool);
    await expect(
      store.createRevision(actorId, screenplayId, { epoch: 0, kind: 'named', label: 'Draft 2' }),
    ).resolves.toBe('missing');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns "forbidden" for a reviewer attempting to name a milestone', async () => {
    const pool = fakePool([rows([{ role: 'reviewer' }])]);
    const store = createPostgresRevisionStore(pool);
    await expect(
      store.createRevision(actorId, screenplayId, { epoch: 0, kind: 'named', label: 'Draft 2' }),
    ).resolves.toBe('forbidden');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('allows an editor to name a milestone', async () => {
    const pool = fakePool([
      rows([{ role: 'editor' }]),
      rows([
        { canonicalScreenplay: screenplayFixture, canonicalHash: 'live-hash', currentEpoch: 0 },
      ]),
    ]);
    mockInsert.mockResolvedValue({ ...revisionRow(), created: true });
    const store = createPostgresRevisionStore(pool);

    const result = await store.createRevision(actorId, screenplayId, {
      epoch: 0,
      kind: 'named',
      label: 'Draft 2',
    });

    expect(result).not.toBe('missing');
    expect(result).not.toBe('forbidden');
    expect((result as { created: boolean }).created).toBe(true);
    expect(mockInsert).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        screenplayId,
        kind: 'named',
        label: 'Draft 2',
        authoredBy: actorId,
        canonicalHash: 'live-hash',
      }),
    );
  });

  /**
   * Collaboration slice 5's HTTP half of plan.md step 4, "the server rejects writes to the old
   * epoch". The content this revision would capture is never *wrong* -- `createRevision` always
   * reads the screenplay's current canonical projection, never the client's -- but a writer naming
   * "this moment" after a restore has replaced what they were looking at is labelling content they
   * never saw. Refused before the insert, not after it.
   */
  it('refuses a revision confirmed against an epoch a restore has since retired, without inserting anything', async () => {
    const pool = fakePool([
      rows([{ role: 'owner' }]),
      rows([
        { canonicalScreenplay: screenplayFixture, canonicalHash: 'live-hash', currentEpoch: 2 },
      ]),
    ]);
    const store = createPostgresRevisionStore(pool);

    await expect(
      store.createRevision(actorId, screenplayId, { epoch: 1, kind: 'named', label: 'Draft 2' }),
    ).resolves.toBe('stale-epoch');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('refuses a stale epoch for an export revision too -- the gate is the write, not the kind', async () => {
    const pool = fakePool([
      rows([{ role: 'reviewer' }]),
      rows([
        { canonicalScreenplay: screenplayFixture, canonicalHash: 'live-hash', currentEpoch: 1 },
      ]),
    ]);
    const store = createPostgresRevisionStore(pool);

    await expect(
      store.createRevision(actorId, screenplayId, { epoch: 0, kind: 'export', format: 'pdf' }),
    ).resolves.toBe('stale-epoch');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  /**
   * The epoch actually written is the screenplay's own `current_epoch`, read in the same query as
   * the canonical projection this revision captures -- not the literal `0` this code held before
   * slice 5, and not the client's claim either (that is only ever checked, never written).
   */
  it("records the screenplay's real current epoch as the revision's source epoch", async () => {
    const pool = fakePool([
      rows([{ role: 'owner' }]),
      rows([
        { canonicalScreenplay: screenplayFixture, canonicalHash: 'live-hash', currentEpoch: 3 },
      ]),
    ]);
    mockInsert.mockResolvedValue({ ...revisionRow({ sourceEpoch: 3 }), created: true });
    const store = createPostgresRevisionStore(pool);

    await store.createRevision(actorId, screenplayId, { epoch: 3, kind: 'named', label: 'D' });

    expect(mockInsert).toHaveBeenCalledWith(pool, expect.objectContaining({ sourceEpoch: 3 }));
  });

  // The reviewer/export case plan.md requires: "a lapsed account keeps every screenplay readable
  // and exportable" -- exporting (and the revision it captures) must never be gated behind edit
  // rights the way naming a milestone is.
  it('allows a reviewer to trigger an export revision', async () => {
    const pool = fakePool([
      rows([{ role: 'reviewer' }]),
      rows([
        { canonicalScreenplay: screenplayFixture, canonicalHash: 'live-hash', currentEpoch: 0 },
      ]),
    ]);
    mockInsert.mockResolvedValue({ ...revisionRow(), kind: 'export', label: null, created: true });
    const store = createPostgresRevisionStore(pool);

    const result = await store.createRevision(actorId, screenplayId, {
      epoch: 0,
      kind: 'export',
      format: 'pdf',
    });

    expect(result).not.toBe('missing');
    expect(result).not.toBe('forbidden');
    expect(mockInsert).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        screenplayId,
        kind: 'export',
        label: null,
        authoredBy: actorId,
      }),
    );
  });

  it('returns "missing" when the screenplay was deleted between the membership check and the read', async () => {
    const pool = fakePool([rows([{ role: 'owner' }]), rows([])]);
    const store = createPostgresRevisionStore(pool);
    await expect(
      store.createRevision(actorId, screenplayId, { epoch: 0, kind: 'named', label: 'Draft 2' }),
    ).resolves.toBe('missing');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  // `kind: 'export'`, not `'named'`: `insertRevisionIfChanged` (packages/database) never dedupes
  // a named revision (see that function's own comment on why), so `created: false` is a real
  // outcome only for the automatic-ish kinds -- this test exercises `createRevision`'s pass-through
  // of whatever the real write path reports, using the one kind that can actually produce it.
  it("surfaces insertRevisionIfChanged's own dedupe: created: false when an export's hash is unchanged", async () => {
    const pool = fakePool([
      rows([{ role: 'owner' }]),
      rows([
        {
          canonicalScreenplay: screenplayFixture,
          canonicalHash: 'unchanged-hash',
          currentEpoch: 0,
        },
      ]),
    ]);
    mockInsert.mockResolvedValue({ ...revisionRow(), kind: 'export', label: null, created: false });
    const store = createPostgresRevisionStore(pool);

    const result = await store.createRevision(actorId, screenplayId, {
      epoch: 0,
      kind: 'export',
      format: 'pdf',
    });

    expect((result as { created: boolean }).created).toBe(false);
  });
});

describe('getRevisionDiff', () => {
  it('returns "missing" when the actor has no membership', async () => {
    const pool = fakePool([rows([])]);
    const store = createPostgresRevisionStore(pool);
    await expect(store.getRevisionDiff(actorId, screenplayId, 'revision-1')).resolves.toBe(
      'missing',
    );
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('returns "missing" when the base revision does not exist for this screenplay', async () => {
    const pool = fakePool([rows([{ role: 'reviewer' }])]);
    mockGetById.mockResolvedValue(undefined);
    const store = createPostgresRevisionStore(pool);
    await expect(store.getRevisionDiff(actorId, screenplayId, 'nope')).resolves.toBe('missing');
  });

  it('returns "missing" rather than throwing when the base revision fails to parse as a screenplay', async () => {
    const pool = fakePool([rows([{ role: 'reviewer' }])]);
    mockGetById.mockResolvedValue({ ...revisionRow(), canonicalScreenplay: { not: 'valid' } });
    const store = createPostgresRevisionStore(pool);
    await expect(store.getRevisionDiff(actorId, screenplayId, 'revision-1')).resolves.toBe(
      'missing',
    );
  });

  it("with no `against`, diffs the revision against the screenplay's current live projection, reporting the revision as the older side", async () => {
    const pool = fakePool([
      rows([{ role: 'reviewer' }]),
      rows([{ canonicalScreenplay: screenplayFixture, canonicalHash: 'live-hash' }]),
    ]);
    mockGetById.mockResolvedValue({
      ...revisionRow(),
      canonicalScreenplay: minimalScreenplayFixture,
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    const store = createPostgresRevisionStore(pool);

    const result = await store.getRevisionDiff(actorId, screenplayId, 'revision-1');

    expect(result).not.toBe('missing');
    const diffResult = result as Exclude<typeof result, 'missing'>;
    expect(diffResult.screenplayId).toBe(screenplayId);
    expect(diffResult.older).toMatchObject({ id: 'revision-1', kind: 'named' });
    expect(diffResult.newer).toEqual({ id: 'current', kind: null, label: null, createdAt: null });
    // The minimal fixture has no blocks and the real fixture has several -- a genuine, non-empty
    // diff proves `diffScreenplays` was actually called with the two real screenplays, not stubs.
    expect(diffResult.diff.isEmpty).toBe(false);
  });

  it('returns "missing" when the live screenplay is gone (deleted since the membership check)', async () => {
    const pool = fakePool([rows([{ role: 'owner' }]), rows([])]);
    mockGetById.mockResolvedValue({ ...revisionRow(), canonicalScreenplay: screenplayFixture });
    const store = createPostgresRevisionStore(pool);
    await expect(store.getRevisionDiff(actorId, screenplayId, 'revision-1')).resolves.toBe(
      'missing',
    );
  });

  it('with `against`, diffs two stored revisions against each other without reading the live screenplay at all', async () => {
    const pool = fakePool([rows([{ role: 'editor' }])]);
    mockGetById
      .mockResolvedValueOnce({
        ...revisionRow(),
        id: 'revision-1',
        canonicalScreenplay: minimalScreenplayFixture,
        createdAt: new Date('2026-08-01T00:00:00Z'),
      })
      .mockResolvedValueOnce({
        ...revisionRow(),
        id: 'revision-2',
        kind: 'export',
        label: null,
        canonicalScreenplay: screenplayFixture,
        createdAt: new Date('2026-08-05T00:00:00Z'),
      });
    const store = createPostgresRevisionStore(pool);

    const result = await store.getRevisionDiff(actorId, screenplayId, 'revision-1', 'revision-2');

    expect(result).not.toBe('missing');
    const diffResult = result as Exclude<typeof result, 'missing'>;
    expect(diffResult.older.id).toBe('revision-1');
    expect(diffResult.newer).toMatchObject({ id: 'revision-2', kind: 'export' });
    expect(diffResult.diff.isEmpty).toBe(false);
    // Only the one query the membership check itself makes -- the live screenplay row is never
    // read when both sides are stored revisions.
    expect((pool as unknown as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
  });

  it('reorders chronologically: the revision passed as `revisionId` becomes the newer side when it is in fact the later one', async () => {
    const pool = fakePool([rows([{ role: 'editor' }])]);
    mockGetById
      .mockResolvedValueOnce({
        ...revisionRow(),
        id: 'revision-2',
        canonicalScreenplay: screenplayFixture,
        createdAt: new Date('2026-08-05T00:00:00Z'),
      })
      .mockResolvedValueOnce({
        ...revisionRow(),
        id: 'revision-1',
        canonicalScreenplay: minimalScreenplayFixture,
        createdAt: new Date('2026-08-01T00:00:00Z'),
      });
    const store = createPostgresRevisionStore(pool);

    const result = await store.getRevisionDiff(actorId, screenplayId, 'revision-2', 'revision-1');

    expect(result).not.toBe('missing');
    const diffResult = result as Exclude<typeof result, 'missing'>;
    expect(diffResult.older.id).toBe('revision-1');
    expect(diffResult.newer.id).toBe('revision-2');
  });

  it('returns "missing" when the `against` revision does not exist for this screenplay', async () => {
    const pool = fakePool([rows([{ role: 'editor' }])]);
    mockGetById
      .mockResolvedValueOnce({ ...revisionRow(), canonicalScreenplay: screenplayFixture })
      .mockResolvedValueOnce(undefined);
    const store = createPostgresRevisionStore(pool);
    await expect(store.getRevisionDiff(actorId, screenplayId, 'revision-1', 'nope')).resolves.toBe(
      'missing',
    );
  });

  it('returns "missing" rather than throwing when the `against` revision fails to parse as a screenplay', async () => {
    const pool = fakePool([rows([{ role: 'editor' }])]);
    mockGetById
      .mockResolvedValueOnce({ ...revisionRow(), canonicalScreenplay: screenplayFixture })
      .mockResolvedValueOnce({
        ...revisionRow(),
        id: 'revision-2',
        canonicalScreenplay: { not: 'valid' },
      });
    const store = createPostgresRevisionStore(pool);
    await expect(
      store.getRevisionDiff(actorId, screenplayId, 'revision-1', 'revision-2'),
    ).resolves.toBe('missing');
  });
});

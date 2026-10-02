import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';

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
    expect(createRevisionInput.parse({ kind: 'named', label: ' Draft 2 ' })).toEqual({
      kind: 'named',
      label: 'Draft 2',
    });
  });

  it('rejects a named input with a blank or overlong label', () => {
    expect(() => createRevisionInput.parse({ kind: 'named', label: '' })).toThrow();
    expect(() => createRevisionInput.parse({ kind: 'named', label: 'x'.repeat(201) })).toThrow();
  });

  it('accepts an export input with a known format and rejects an unknown one', () => {
    expect(createRevisionInput.parse({ kind: 'export', format: 'pdf' })).toEqual({
      kind: 'export',
      format: 'pdf',
    });
    expect(() => createRevisionInput.parse({ kind: 'export', format: 'txt' })).toThrow();
  });

  it('rejects a named input carrying an export-only field, and vice versa', () => {
    expect(() => createRevisionInput.parse({ kind: 'named', label: 'x', format: 'pdf' })).toThrow();
    expect(() =>
      createRevisionInput.parse({ kind: 'export', format: 'pdf', label: 'x' }),
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
      store.createRevision(actorId, screenplayId, { kind: 'named', label: 'Draft 2' }),
    ).resolves.toBe('missing');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns "forbidden" for a reviewer attempting to name a milestone', async () => {
    const pool = fakePool([rows([{ role: 'reviewer' }])]);
    const store = createPostgresRevisionStore(pool);
    await expect(
      store.createRevision(actorId, screenplayId, { kind: 'named', label: 'Draft 2' }),
    ).resolves.toBe('forbidden');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('allows an editor to name a milestone', async () => {
    const pool = fakePool([
      rows([{ role: 'editor' }]),
      rows([{ canonicalScreenplay: screenplayFixture, canonicalHash: 'live-hash' }]),
    ]);
    mockInsert.mockResolvedValue({ ...revisionRow(), created: true });
    const store = createPostgresRevisionStore(pool);

    const result = await store.createRevision(actorId, screenplayId, {
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

  // The reviewer/export case plan.md requires: "a lapsed account keeps every screenplay readable
  // and exportable" -- exporting (and the revision it captures) must never be gated behind edit
  // rights the way naming a milestone is.
  it('allows a reviewer to trigger an export revision', async () => {
    const pool = fakePool([
      rows([{ role: 'reviewer' }]),
      rows([{ canonicalScreenplay: screenplayFixture, canonicalHash: 'live-hash' }]),
    ]);
    mockInsert.mockResolvedValue({ ...revisionRow(), kind: 'export', label: null, created: true });
    const store = createPostgresRevisionStore(pool);

    const result = await store.createRevision(actorId, screenplayId, {
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
      store.createRevision(actorId, screenplayId, { kind: 'named', label: 'Draft 2' }),
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
      rows([{ canonicalScreenplay: screenplayFixture, canonicalHash: 'unchanged-hash' }]),
    ]);
    mockInsert.mockResolvedValue({ ...revisionRow(), kind: 'export', label: null, created: false });
    const store = createPostgresRevisionStore(pool);

    const result = await store.createRevision(actorId, screenplayId, {
      kind: 'export',
      format: 'pdf',
    });

    expect((result as { created: boolean }).created).toBe(false);
  });
});

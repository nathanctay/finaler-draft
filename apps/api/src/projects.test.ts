import { describe, expect, it, vi } from 'vitest';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import {
  ForbiddenError,
  createPostgresProjectStore,
  createScreenplayInput,
  renameInput,
} from './projects.js';

const actorId = 'actor-1';
const projectId = '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f';
const screenplayId = 'ecf1118c-3a2e-4656-84e6-fce75c461710';

describe('project persistence validation', () => {
  it('accepts canonical screenplay input and rejects malformed requests', () => {
    expect(
      createScreenplayInput.parse({ title: ' Draft ', screenplay: screenplayFixture }),
    ).toEqual({
      title: 'Draft',
      screenplay: screenplayFixture,
    });
    expect(() =>
      createScreenplayInput.parse({ title: '', screenplay: screenplayFixture }),
    ).toThrow();
    expect(() => createScreenplayInput.parse({ title: 'Draft', screenplay: {} })).toThrow();
  });

  it('trims rename titles and rejects blank or overlong ones', () => {
    expect(renameInput.parse({ title: ' New Title ' })).toEqual({ title: 'New Title' });
    expect(() => renameInput.parse({ title: '' })).toThrow();
    expect(() => renameInput.parse({ title: 'x'.repeat(201) })).toThrow();
  });
});

describe('PostgreSQL project store', () => {
  it('lists projects and screenplays with ISO timestamps', async () => {
    const pool = fakePool([
      rows([
        {
          id: projectId,
          title: 'Project',
          updatedAt: new Date('2026-08-06T00:00:00Z'),
          role: 'owner',
        },
      ]),
      rows([
        {
          id: screenplayId,
          title: 'Script',
          updatedAt: new Date('2026-08-06T00:00:00Z'),
        },
      ]),
    ]);
    const store = createPostgresProjectStore(pool);
    await expect(store.listProjects(actorId)).resolves.toEqual([
      { id: projectId, title: 'Project', updatedAt: '2026-08-06T00:00:00.000Z', role: 'owner' },
    ]);
    await expect(store.listScreenplays(actorId, projectId)).resolves.toEqual([
      { id: screenplayId, title: 'Script', updatedAt: '2026-08-06T00:00:00.000Z' },
    ]);
  });

  it('creates a project with its owner membership atomically', async () => {
    const client = fakeClient([empty(), empty(), empty(), empty()]);
    const pool = fakePool([], client);
    const created = await createPostgresProjectStore(pool).createProject(actorId, 'Project');
    expect(created.title).toBe('Project');
    expect(client.query).toHaveBeenCalledWith('begin');
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('creates a screenplay only after locking an owner or editor membership', async () => {
    const client = fakeClient([
      empty(),
      rows([{ role: 'editor' }]),
      rows([{ id: screenplayId }]),
      empty(),
    ]);
    const store = createPostgresProjectStore(fakePool([], client));
    await expect(
      store.createScreenplay(actorId, projectId, {
        title: 'Script',
        screenplay: screenplayFixture,
      }),
    ).resolves.toEqual({ id: screenplayId });
    const insertCall = client.query.mock.calls.find(
      ([query]) => typeof query === 'string' && query.startsWith('insert into screenplays'),
    );
    expect(insertCall).toBeDefined();
    const insertParameters = insertCall?.[1] as unknown[];
    expect(insertParameters[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(JSON.parse(insertParameters[3] as string)).toMatchObject({ id: insertParameters[0] });
    expect(client.query).toHaveBeenCalledWith(
      'update projects set updated_at = now() where id = $1',
      [projectId],
    );
    expect(client.query).toHaveBeenCalledWith('commit');

    const deniedClient = fakeClient([empty(), rows([{ role: 'reviewer' }]), empty()]);
    const denied = createPostgresProjectStore(fakePool([], deniedClient)).createScreenplay(
      actorId,
      projectId,
      {
        title: 'Script',
        screenplay: screenplayFixture,
      },
    );
    await expect(denied).rejects.toBeInstanceOf(ForbiddenError);
    expect(deniedClient.query).toHaveBeenCalledWith('rollback');
  });

  // Owner-only as of the owner-only-rename slice (progress/owner-only-rename.md) -- an editor
  // used to be allowed here too, matching `canEdit`; narrowed to match `deleteProject`/
  // `restoreProject`'s existing owner-only bar. Mutation check: loosening the `isOwner` guard in
  // `renameProject` back to `canEdit` (or removing it) makes the editor assertion below fail,
  // since an editor would then receive `{ id: projectId, title: 'New Title' }` instead of
  // `'forbidden'`.
  it('renames a project only for its owner, and reports missing without leaking existence details', async () => {
    const missingProjectClient = fakeClient([empty(), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], missingProjectClient)).renameProject(
        actorId,
        projectId,
        'New Title',
      ),
    ).resolves.toBe('missing');
    expect(missingProjectClient.query).toHaveBeenCalledWith('rollback');

    const noMemberClient = fakeClient([empty(), rows([{ id: projectId }]), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], noMemberClient)).renameProject(
        actorId,
        projectId,
        'New Title',
      ),
    ).resolves.toBe('missing');

    const reviewerClient = fakeClient([
      empty(),
      rows([{ id: projectId }]),
      rows([{ role: 'reviewer' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], reviewerClient)).renameProject(
        actorId,
        projectId,
        'New Title',
      ),
    ).resolves.toBe('forbidden');
    expect(reviewerClient.query).toHaveBeenCalledWith('rollback');

    const editorClient = fakeClient([
      empty(),
      rows([{ id: projectId }]),
      rows([{ role: 'editor' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], editorClient)).renameProject(
        actorId,
        projectId,
        'New Title',
      ),
    ).resolves.toBe('forbidden');
    expect(editorClient.query).toHaveBeenCalledWith('rollback');

    const ownerClient = fakeClient([
      empty(),
      rows([{ id: projectId }]),
      rows([{ role: 'owner' }]),
      rows([{ id: projectId, title: 'New Title' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], ownerClient)).renameProject(
        actorId,
        projectId,
        'New Title',
      ),
    ).resolves.toEqual({ id: projectId, title: 'New Title' });
    expect(ownerClient.query).toHaveBeenCalledWith('commit');

    for (const client of [
      missingProjectClient,
      noMemberClient,
      reviewerClient,
      editorClient,
      ownerClient,
    ]) {
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  // Mutation check: loosening `deleteProject`'s `isOwner` guard back to `canEdit` (or removing it)
  // makes the editor assertion below fail, since an editor would then receive `{ id: projectId }`
  // instead of `'forbidden'`.
  it('deletes a project only for its owner', async () => {
    const missingClient = fakeClient([empty(), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], missingClient)).deleteProject(actorId, projectId),
    ).resolves.toBe('missing');

    // A project that exists but has no membership row for this actor is a distinct code path
    // from "the project doesn't exist" above, and must reach the same 'missing' answer so a
    // non-member cannot distinguish the two.
    const noMemberClient = fakeClient([empty(), rows([{ id: projectId }]), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], noMemberClient)).deleteProject(actorId, projectId),
    ).resolves.toBe('missing');

    const editorClient = fakeClient([
      empty(),
      rows([{ id: projectId }]),
      rows([{ role: 'editor' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], editorClient)).deleteProject(actorId, projectId),
    ).resolves.toBe('forbidden');
    expect(editorClient.query).toHaveBeenCalledWith('rollback');

    const ownerClient = fakeClient([empty(), rows([{ id: projectId }]), rows([{ role: 'owner' }])]);
    await expect(
      createPostgresProjectStore(fakePool([], ownerClient)).deleteProject(actorId, projectId),
    ).resolves.toEqual({ id: projectId });
    expect(ownerClient.query).toHaveBeenCalledWith(
      'update projects set deleted_at = now() where id = $1',
      [projectId],
    );
    expect(ownerClient.query).toHaveBeenCalledWith('commit');

    for (const client of [missingClient, noMemberClient, editorClient, ownerClient]) {
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  // Mutation check: loosening `restoreProject`'s `isOwner` guard back to `canEdit` (or removing
  // it) makes the editor assertion below fail, since an editor would then receive
  // `{ id: projectId, title: 'Project' }` instead of `'forbidden'`.
  it('restores a project only for its owner, mirroring delete authorisation exactly', async () => {
    const notDeletedClient = fakeClient([empty(), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], notDeletedClient)).restoreProject(actorId, projectId),
    ).resolves.toBe('missing');

    const editorClient = fakeClient([
      empty(),
      rows([{ id: projectId }]),
      rows([{ role: 'editor' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], editorClient)).restoreProject(actorId, projectId),
    ).resolves.toBe('forbidden');

    const ownerClient = fakeClient([
      empty(),
      rows([{ id: projectId }]),
      rows([{ role: 'owner' }]),
      rows([{ id: projectId, title: 'Project' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], ownerClient)).restoreProject(actorId, projectId),
    ).resolves.toEqual({ id: projectId, title: 'Project' });
    expect(ownerClient.query).toHaveBeenCalledWith('commit');

    for (const client of [notDeletedClient, editorClient, ownerClient]) {
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  // Owner-only as of the owner-only-rename slice (progress/owner-only-rename.md) -- an editor
  // used to be allowed here too, matching `canEdit`. Mutation check: loosening `renameScreenplay`'s
  // `isOwner` guard back to `canEdit` (or removing it) makes the editor assertion below fail,
  // since an editor would then receive `{ id: screenplayId, title: 'New Title' }` instead of
  // `'forbidden'`. The same owner-vs-editor decision is additionally proven against a real
  // database, for both `project_members` and `screenplay_members`, in
  // `projectsAuthorization.integration.test.ts`.
  it('renames a screenplay only for its owner, and reports missing for a nonexistent or already-deleted one', async () => {
    const missingClient = fakeClient([empty(), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], missingClient)).renameScreenplay(
        actorId,
        screenplayId,
        'New Title',
      ),
    ).resolves.toBe('missing');

    // One queued result for the lock-and-resolve-role query, not two: since the
    // screenplay-invitations slice `lockScreenplayRow` resolves the actor's effective role in the
    // same statement that locks the row (through `screenplayRoleLateral`), rather than this store
    // running a second `select role from project_members`.
    const reviewerClient = fakeClient([empty(), rows([{ projectId, role: 'reviewer' }])]);
    await expect(
      createPostgresProjectStore(fakePool([], reviewerClient)).renameScreenplay(
        actorId,
        screenplayId,
        'New Title',
      ),
    ).resolves.toBe('forbidden');

    const editorClient = fakeClient([empty(), rows([{ projectId, role: 'editor' }])]);
    await expect(
      createPostgresProjectStore(fakePool([], editorClient)).renameScreenplay(
        actorId,
        screenplayId,
        'New Title',
      ),
    ).resolves.toBe('forbidden');

    const ownerClient = fakeClient([
      empty(),
      rows([{ projectId, role: 'owner' }]),
      rows([{ id: screenplayId, title: 'New Title' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], ownerClient)).renameScreenplay(
        actorId,
        screenplayId,
        'New Title',
      ),
    ).resolves.toEqual({ id: screenplayId, title: 'New Title' });

    for (const client of [missingClient, reviewerClient, editorClient, ownerClient]) {
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  // Owner-only as of the owner-only-rename slice -- an editor used to be allowed here too,
  // matching `canEdit`, which this test's old title ("unlike project deletion which requires the
  // owner") called out as the asymmetry this slice removed: both resources now require the owner.
  // Mutation check: loosening `deleteScreenplay`'s `isOwner` guard back to `canEdit` (or removing
  // it) makes the editor assertion below fail, since an editor would then receive
  // `{ id: screenplayId }` instead of `'forbidden'`.
  it('deletes a screenplay only for its owner, matching project deletion', async () => {
    const ownerClient = fakeClient([empty(), rows([{ projectId, role: 'owner' }])]);
    await expect(
      createPostgresProjectStore(fakePool([], ownerClient)).deleteScreenplay(actorId, screenplayId),
    ).resolves.toEqual({ id: screenplayId });
    expect(ownerClient.query).toHaveBeenCalledWith(
      'update screenplays set deleted_at = now() where id = $1',
      [screenplayId],
    );

    const editorClient = fakeClient([empty(), rows([{ projectId, role: 'editor' }])]);
    await expect(
      createPostgresProjectStore(fakePool([], editorClient)).deleteScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toBe('forbidden');

    const reviewerClient = fakeClient([empty(), rows([{ projectId, role: 'reviewer' }])]);
    await expect(
      createPostgresProjectStore(fakePool([], reviewerClient)).deleteScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toBe('forbidden');

    for (const client of [ownerClient, editorClient, reviewerClient]) {
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  it('lists deleted projects and screenplays with ISO timestamps, inside one repeatable-read transaction', async () => {
    const client = fakeClient([
      empty(),
      rows([
        {
          id: projectId,
          title: 'Deleted project',
          updatedAt: new Date('2026-08-06T00:00:00Z'),
          deletedAt: new Date('2026-08-07T00:00:00Z'),
        },
      ]),
      rows([
        {
          id: screenplayId,
          title: 'Deleted screenplay',
          updatedAt: new Date('2026-08-06T00:00:00Z'),
          deletedAt: new Date('2026-08-07T00:00:00Z'),
          projectId,
          projectTitle: 'Active project',
        },
      ]),
      empty(),
    ]);
    const store = createPostgresProjectStore(fakePool([], client));
    await expect(store.listDeleted(actorId)).resolves.toEqual({
      projects: [
        {
          id: projectId,
          title: 'Deleted project',
          updatedAt: '2026-08-06T00:00:00.000Z',
          deletedAt: '2026-08-07T00:00:00.000Z',
        },
      ],
      screenplays: [
        {
          id: screenplayId,
          title: 'Deleted screenplay',
          updatedAt: '2026-08-06T00:00:00.000Z',
          deletedAt: '2026-08-07T00:00:00.000Z',
          projectId,
          projectTitle: 'Active project',
        },
      ],
    });
    // The two collections must be read inside one snapshot, not as two independent pool
    // queries: a concurrent restore between them could otherwise produce a response that never
    // existed in the database at any single instant (see the store's own comment on listDeleted).
    expect(client.query).toHaveBeenCalledWith('begin isolation level repeatable read read only');
    expect(client.query).toHaveBeenCalledWith('commit');
    expect(client.release).toHaveBeenCalledOnce();
    const [projectsQuery] = client.query.mock.calls[1] as [string, unknown[]];
    const [screenplaysQuery] = client.query.mock.calls[2] as [string, unknown[]];
    // The scoping rules are the load-bearing part of this query: assert them directly rather
    // than only through fixture output, so a future edit that drops a predicate fails here even
    // if the fixture rows happen not to expose it.
    expect(projectsQuery).toContain("m.role = 'owner'");
    expect(projectsQuery).toContain('p.deleted_at is not null');
    // Owner-only as of the owner-only-rename slice (progress/owner-only-rename.md) -- this was
    // `m.role in ('owner', 'editor')` before that slice narrowed `restoreScreenplay` itself to
    // owner-only. Mutation check: widening this predicate back to `in ('owner', 'editor')` without
    // also narrowing `restoreScreenplay` would make this test's string assertion fail, which is
    // exactly the drift this assertion exists to catch -- the listing and the restore it backs
    // must agree, or a listed row's Restore button can come back 403.
    expect(screenplaysQuery).toContain("m.role = 'owner'");
    expect(screenplaysQuery).toContain('s.deleted_at is not null');
    expect(screenplaysQuery).toContain('p.deleted_at is null');
  });

  // Owner-only as of the owner-only-rename slice -- an editor used to be allowed here too,
  // matching `canEdit`. Mutation check: loosening `restoreScreenplay`'s `isOwner` guard back to
  // `canEdit` (or removing it) makes the editor assertion below fail, since an editor would then
  // receive `{ id: screenplayId, title: 'Draft' }` instead of `'forbidden'`.
  it('restores a screenplay only for its owner, and reports missing when it is not currently deleted', async () => {
    const notDeletedClient = fakeClient([empty(), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], notDeletedClient)).restoreScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toBe('missing');

    // The actor holds no membership of either kind. Since the screenplay-invitations slice that is
    // the *same* query as the row lock -- `screenplayRoleLateral` is a `cross join lateral`, so "no
    // role" eliminates the row entirely and the lock itself returns nothing -- which is why this
    // queues an empty result for the lock rather than a found row plus an empty membership lookup.
    // It must still reach the same 'missing' answer, which is what this asserts.
    const noMemberClient = fakeClient([empty(), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], noMemberClient)).restoreScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toBe('missing');

    const editorClient = fakeClient([empty(), rows([{ projectId, role: 'editor' }])]);
    await expect(
      createPostgresProjectStore(fakePool([], editorClient)).restoreScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toBe('forbidden');

    const ownerClient = fakeClient([
      empty(),
      rows([{ projectId, role: 'owner' }]),
      rows([{ id: screenplayId, title: 'Draft' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], ownerClient)).restoreScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toEqual({ id: screenplayId, title: 'Draft' });
    expect(ownerClient.query).toHaveBeenCalledWith('commit');

    for (const client of [notDeletedClient, noMemberClient, editorClient, ownerClient]) {
      expect(client.release).toHaveBeenCalledOnce();
    }
  });
});

function rows(values: Record<string, unknown>[]) {
  return { rowCount: values.length, rows: values };
}

function empty() {
  return rows([]);
}

function fakeClient(results: Array<{ rowCount: number; rows: Record<string, unknown>[] }>) {
  return {
    query: vi.fn(async (...args: unknown[]) => {
      void args;
      return results.shift() ?? empty();
    }),
    release: vi.fn(),
  };
}

function fakePool(
  results: Array<{ rowCount: number; rows: Record<string, unknown>[] }>,
  client = fakeClient([]),
) {
  return {
    query: vi.fn(async (...args: unknown[]) => {
      void args;
      return results.shift() ?? empty();
    }),
    connect: vi.fn(async () => client),
  } as never;
}

import { describe, expect, it, vi } from 'vitest';
import { minimalScreenplayFixture, screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import {
  ForbiddenError,
  createPostgresProjectStore,
  createScreenplayInput,
  renameInput,
  updateScreenplayInput,
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
    expect(
      updateScreenplayInput.parse({ expectedVersion: 1, screenplay: minimalScreenplayFixture }),
    ).toEqual({
      expectedVersion: 1,
      screenplay: minimalScreenplayFixture,
    });
    expect(() =>
      createScreenplayInput.parse({ title: '', screenplay: screenplayFixture }),
    ).toThrow();
    expect(() =>
      updateScreenplayInput.parse({ expectedVersion: 0, screenplay: screenplayFixture }),
    ).toThrow();
    expect(() => updateScreenplayInput.parse({ expectedVersion: 1, screenplay: {} })).toThrow();
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
          version: 4,
          updatedAt: new Date('2026-08-06T00:00:00Z'),
        },
      ]),
    ]);
    const store = createPostgresProjectStore(pool);
    await expect(store.listProjects(actorId)).resolves.toEqual([
      { id: projectId, title: 'Project', updatedAt: '2026-08-06T00:00:00.000Z', role: 'owner' },
    ]);
    await expect(store.listScreenplays(actorId, projectId)).resolves.toEqual([
      { id: screenplayId, title: 'Script', version: 4, updatedAt: '2026-08-06T00:00:00.000Z' },
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
      rows([{ id: screenplayId, version: 1 }]),
      empty(),
    ]);
    const store = createPostgresProjectStore(fakePool([], client));
    await expect(
      store.createScreenplay(actorId, projectId, {
        title: 'Script',
        screenplay: screenplayFixture,
      }),
    ).resolves.toEqual({ id: screenplayId, version: 1 });
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

  it('reports missing, forbidden, identity mismatch, stale, and successful saves without leaving transactions open', async () => {
    const missingClient = fakeClient([empty(), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], missingClient)).updateScreenplay(
        actorId,
        screenplayId,
        updateInput(),
      ),
    ).resolves.toBe('missing');

    const noMemberClient = fakeClient([
      empty(),
      rows([{ projectId, version: 1 }]),
      empty(),
      empty(),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], noMemberClient)).updateScreenplay(
        actorId,
        screenplayId,
        updateInput(),
      ),
    ).resolves.toBe('missing');

    const reviewerClient = fakeClient([
      empty(),
      rows([{ projectId, version: 1 }]),
      rows([{ role: 'reviewer' }]),
      empty(),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], reviewerClient)).updateScreenplay(
        actorId,
        screenplayId,
        updateInput(),
      ),
    ).resolves.toBe('forbidden');

    const identityMismatchClient = fakeClient([
      empty(),
      rows([{ projectId, version: 1 }]),
      rows([{ role: 'owner' }]),
      empty(),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], identityMismatchClient)).updateScreenplay(
        actorId,
        screenplayId,
        {
          expectedVersion: 1,
          screenplay: { ...screenplayFixture, id: 'f6b92413-4aa4-413c-8d0a-dd86d09fc326' },
        },
      ),
    ).resolves.toBe('invalid');
    expect(identityMismatchClient.query).toHaveBeenCalledWith('rollback');

    const staleClient = fakeClient([
      empty(),
      rows([{ projectId, version: 2 }]),
      rows([{ role: 'owner' }]),
      empty(),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], staleClient)).updateScreenplay(
        actorId,
        screenplayId,
        updateInput(),
      ),
    ).resolves.toBe('conflict');

    const savedClient = fakeClient([
      empty(),
      rows([{ projectId, version: 1 }]),
      rows([{ role: 'owner' }]),
      rows([{ version: 2 }]),
      empty(),
      empty(),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], savedClient)).updateScreenplay(
        actorId,
        screenplayId,
        updateInput(),
      ),
    ).resolves.toEqual({ version: 2 });
    expect(savedClient.query).toHaveBeenCalledWith('commit');
    for (const client of [
      missingClient,
      noMemberClient,
      reviewerClient,
      identityMismatchClient,
      staleClient,
      savedClient,
    ]) {
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  it('renames a project only for an owner or editor, and reports missing without leaking existence details', async () => {
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
      rows([{ id: projectId, title: 'New Title' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], editorClient)).renameProject(
        actorId,
        projectId,
        'New Title',
      ),
    ).resolves.toEqual({ id: projectId, title: 'New Title' });
    expect(editorClient.query).toHaveBeenCalledWith('commit');

    for (const client of [missingProjectClient, noMemberClient, reviewerClient, editorClient]) {
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  it('deletes a project only for its owner, unlike rename which also allows an editor', async () => {
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

  it('renames a screenplay for an owner or editor and reports missing for a nonexistent or already-deleted one', async () => {
    const missingClient = fakeClient([empty(), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], missingClient)).renameScreenplay(
        actorId,
        screenplayId,
        'New Title',
      ),
    ).resolves.toBe('missing');

    const reviewerClient = fakeClient([
      empty(),
      rows([{ projectId, version: 1 }]),
      rows([{ role: 'reviewer' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], reviewerClient)).renameScreenplay(
        actorId,
        screenplayId,
        'New Title',
      ),
    ).resolves.toBe('forbidden');

    const editorClient = fakeClient([
      empty(),
      rows([{ projectId, version: 1 }]),
      rows([{ role: 'editor' }]),
      rows([{ id: screenplayId, title: 'New Title' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], editorClient)).renameScreenplay(
        actorId,
        screenplayId,
        'New Title',
      ),
    ).resolves.toEqual({ id: screenplayId, title: 'New Title' });

    for (const client of [missingClient, reviewerClient, editorClient]) {
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  it('deletes a screenplay for an owner or editor, unlike project deletion which requires the owner', async () => {
    const editorClient = fakeClient([
      empty(),
      rows([{ projectId, version: 1 }]),
      rows([{ role: 'editor' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], editorClient)).deleteScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toEqual({ id: screenplayId });
    expect(editorClient.query).toHaveBeenCalledWith(
      'update screenplays set deleted_at = now() where id = $1',
      [screenplayId],
    );

    const reviewerClient = fakeClient([
      empty(),
      rows([{ projectId, version: 1 }]),
      rows([{ role: 'reviewer' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], reviewerClient)).deleteScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toBe('forbidden');

    for (const client of [editorClient, reviewerClient]) {
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
    expect(screenplaysQuery).toContain("m.role in ('owner', 'editor')");
    expect(screenplaysQuery).toContain('s.deleted_at is not null');
    expect(screenplaysQuery).toContain('p.deleted_at is null');
  });

  it('restores a screenplay for an owner or editor, and reports missing when it is not currently deleted', async () => {
    const notDeletedClient = fakeClient([empty(), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], notDeletedClient)).restoreScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toBe('missing');

    // The screenplay is genuinely soft-deleted and its project active (lockScreenplayRow finds
    // it), but the actor has no membership row at all — a distinct code path from "not deleted"
    // above, and it must reach the same 'missing' answer.
    const noMemberClient = fakeClient([empty(), rows([{ projectId, version: 1 }]), empty()]);
    await expect(
      createPostgresProjectStore(fakePool([], noMemberClient)).restoreScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toBe('missing');

    const editorClient = fakeClient([
      empty(),
      rows([{ projectId, version: 1 }]),
      rows([{ role: 'editor' }]),
      rows([{ id: screenplayId, title: 'Draft' }]),
    ]);
    await expect(
      createPostgresProjectStore(fakePool([], editorClient)).restoreScreenplay(
        actorId,
        screenplayId,
      ),
    ).resolves.toEqual({ id: screenplayId, title: 'Draft' });
    expect(editorClient.query).toHaveBeenCalledWith('commit');

    for (const client of [notDeletedClient, noMemberClient, editorClient]) {
      expect(client.release).toHaveBeenCalledOnce();
    }
  });
});

function updateInput() {
  return { expectedVersion: 1, screenplay: { ...screenplayFixture, id: screenplayId } };
}

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

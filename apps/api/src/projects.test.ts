import { describe, expect, it, vi } from 'vitest';
import { minimalScreenplayFixture, screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import {
  ForbiddenError,
  createPostgresProjectStore,
  createScreenplayInput,
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
      rows([{ project_id: projectId, version: 1 }]),
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
      rows([{ project_id: projectId, version: 1 }]),
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
      rows([{ project_id: projectId, version: 1 }]),
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
      rows([{ project_id: projectId, version: 2 }]),
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
      rows([{ project_id: projectId, version: 1 }]),
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

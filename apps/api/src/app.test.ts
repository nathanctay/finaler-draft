import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp, MAX_SCREENPLAY_REQUEST_BODY_BYTES } from './app.js';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { ProjectStore } from './projects.js';

const app = await buildApp();

afterAll(async () => {
  await app.close();
});

describe('GET /api/health', () => {
  it('returns an explicit healthy status', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('production client serving', () => {
  it('uses the default client root when no override is supplied', async () => {
    const productionApp = await buildApp({ serveClient: true });

    try {
      const response = await productionApp.inject({ method: 'GET', url: '/api/health' });

      expect(response.statusCode).toBe(200);
    } finally {
      await productionApp.close();
    }
  });

  it('serves the client entry point while preserving API 404 responses', async () => {
    const productionApp = await buildApp({
      serveClient: true,
      clientRoot: new URL('./fixtures/web/', import.meta.url),
    });

    try {
      const clientResponse = await productionApp.inject({
        method: 'GET',
        url: '/writer/the-long-way-home',
      });
      const apiResponse = await productionApp.inject({ method: 'GET', url: '/api/unknown' });

      expect(clientResponse.statusCode).toBe(200);
      expect(clientResponse.body).toContain('Finaler Draft workspace fixture');
      expect(apiResponse.statusCode).toBe(404);
      expect(apiResponse.json()).toEqual({ error: 'Not found' });
    } finally {
      await productionApp.close();
    }
  });
});

describe('logging', () => {
  it('raises the logging threshold in production', async () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const productionApp = await buildApp();

    try {
      expect(productionApp.log.level).toBe('info');
    } finally {
      await productionApp.close();
      if (previousEnvironment === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousEnvironment;
      }
    }
  });
});

describe('persisted project API', () => {
  let createScreenplayResult: { id: string; version: number } | 'forbidden' = {
    id: 'ecf1118c-3a2e-4656-84e6-fce75c461710',
    version: 1,
  };
  let updateResult: Awaited<ReturnType<ProjectStore['updateScreenplay']>> = 'conflict';
  let renameProjectResult: Awaited<ReturnType<ProjectStore['renameProject']>> = {
    id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
    title: 'Renamed',
  };
  let deleteProjectResult: Awaited<ReturnType<ProjectStore['deleteProject']>> = {
    id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
  };
  let restoreProjectResult: Awaited<ReturnType<ProjectStore['restoreProject']>> = {
    id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
    title: 'Project',
  };
  let renameScreenplayResult: Awaited<ReturnType<ProjectStore['renameScreenplay']>> = {
    id: 'ecf1118c-3a2e-4656-84e6-fce75c461710',
    title: 'Renamed',
  };
  let deleteScreenplayResult: Awaited<ReturnType<ProjectStore['deleteScreenplay']>> = {
    id: 'ecf1118c-3a2e-4656-84e6-fce75c461710',
  };
  let restoreScreenplayResult: Awaited<ReturnType<ProjectStore['restoreScreenplay']>> = {
    id: 'ecf1118c-3a2e-4656-84e6-fce75c461710',
    title: 'Draft',
  };
  const listDeletedResult: Awaited<ReturnType<ProjectStore['listDeleted']>> = {
    projects: [
      {
        id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
        title: 'Deleted project',
        updatedAt: '2026-08-06T00:00:00Z',
        deletedAt: '2026-08-07T00:00:00Z',
      },
    ],
    screenplays: [
      {
        id: 'ecf1118c-3a2e-4656-84e6-fce75c461710',
        title: 'Deleted screenplay',
        updatedAt: '2026-08-06T00:00:00Z',
        deletedAt: '2026-08-07T00:00:00Z',
        projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
        projectTitle: 'Active project',
      },
    ],
  };
  const store: ProjectStore = {
    listProjects: async () => [
      {
        id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
        title: 'Project',
        updatedAt: '2026-08-06T00:00:00Z',
        role: 'owner',
      },
    ],
    createProject: async (_actorId, title) => ({
      id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
      title,
    }),
    renameProject: async () => renameProjectResult,
    deleteProject: async () => deleteProjectResult,
    restoreProject: async () => restoreProjectResult,
    listScreenplays: async () => [],
    createScreenplay: async () => {
      if (createScreenplayResult === 'forbidden')
        throw new (await import('./projects.js')).ForbiddenError();
      return createScreenplayResult;
    },
    getScreenplay: async () => ({
      id: 'ecf1118c-3a2e-4656-84e6-fce75c461710',
      projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
      title: 'Draft',
      version: 1,
      screenplay: screenplayFixture,
    }),
    renameScreenplay: async () => renameScreenplayResult,
    deleteScreenplay: async () => deleteScreenplayResult,
    restoreScreenplay: async () => restoreScreenplayResult,
    listDeleted: async () => listDeletedResult,
    updateScreenplay: async () => updateResult,
  };
  const auth = {
    baseUrl: 'https://app.example.test',
    handler: async () =>
      new Response('auth', { headers: { 'set-cookie': 'session=test; HttpOnly' } }),
    getActorId: async (headers: Headers) =>
      headers.get('cookie') === 'session=test' ? 'actor-1' : null,
  };
  it('forwards cookies through auth and rejects unauthenticated project access', async () => {
    const app = await buildApp({ auth, projects: store });
    try {
      const authResponse = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'writer@example.test' },
      });
      expect(authResponse.headers['set-cookie']).toContain('session=test');
      expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
      const projects = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { cookie: 'session=test' },
      });
      expect(projects.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it('rejects an unauthenticated request for authentication, not schema validation, even when its id is malformed', async () => {
    // Fastify's lifecycle runs preValidation -> schema validation -> preHandler -> the route
    // handler. Before this refactor, every id/body check was a manual `.parse()` call inside the
    // handler, which is later than all of those hooks, so an unauthenticated request with a
    // malformed id or body was always rejected for authentication (401) rather than validation
    // (400). Declaring params/body as route schemas moves validation ahead of preHandler; this
    // proves the auth-check hook still runs first (it lives in preValidation, not preHandler) and
    // that ordering, and therefore this status code, is unchanged by the refactor.
    const app = await buildApp({ auth, projects: store });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/projects/not-a-uuid/screenplays',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Authentication required' });
    } finally {
      await app.close();
    }
  });
  it('returns response bodies whose fields exactly match the store, unstripped by the new response schemas', async () => {
    // fastify-type-provider-zod's response schemas serialize by re-parsing the handler's return
    // value and can silently drop any field the schema doesn't declare. Every assertion here uses
    // `.toEqual` (exact deep equality), not `.toMatchObject`, specifically to catch that failure
    // mode for every route this refactor attached a response schema to.
    const app = await buildApp({ auth, projects: store });
    try {
      const headers = { cookie: 'session=test' };
      expect((await app.inject({ method: 'GET', url: '/api/projects', headers })).json()).toEqual([
        {
          id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
          title: 'Project',
          updatedAt: '2026-08-06T00:00:00Z',
          role: 'owner',
        },
      ]);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/projects',
            headers,
            payload: { title: 'New Project' },
          })
        ).json(),
      ).toEqual({ id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f', title: 'New Project' });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/projects/5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f/screenplays',
            headers,
          })
        ).json(),
      ).toEqual([]);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/projects/5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f/screenplays',
            headers,
            payload: { title: 'Draft', screenplay: screenplayFixture },
          })
        ).json(),
      ).toEqual({ id: 'ecf1118c-3a2e-4656-84e6-fce75c461710', version: 1 });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
            headers,
          })
        ).json(),
      ).toEqual({
        id: 'ecf1118c-3a2e-4656-84e6-fce75c461710',
        projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
        title: 'Draft',
        version: 1,
        screenplay: screenplayFixture,
      });
    } finally {
      await app.close();
    }
  });

  it('validates canonical autosave input and returns optimistic conflicts', async () => {
    const app = await buildApp({ auth, projects: store });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
        headers: { cookie: 'session=test' },
        payload: { expectedVersion: 1, screenplay: screenplayFixture },
      });
      expect(response.statusCode).toBe(409);
      const invalid = await app.inject({
        method: 'PUT',
        url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
        headers: { cookie: 'session=test' },
        payload: { expectedVersion: 1, screenplay: { schemaVersion: 1 } },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('exposes every protected project operation and maps authorization outcomes', async () => {
    const app = await buildApp({ auth, projects: store });
    try {
      const headers = { cookie: 'session=test' };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/projects',
            headers,
            payload: { title: 'New' },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/projects/5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f/screenplays',
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
            headers,
          })
        ).json(),
      ).toMatchObject({ title: 'Draft', version: 1, screenplay: screenplayFixture });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/projects/5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f/screenplays',
            headers,
            payload: { title: 'Draft', screenplay: screenplayFixture },
          })
        ).statusCode,
      ).toBe(201);
      createScreenplayResult = 'forbidden';
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/projects/5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f/screenplays',
            headers,
            payload: { title: 'Draft', screenplay: screenplayFixture },
          })
        ).statusCode,
      ).toBe(403);
      createScreenplayResult = { id: 'ecf1118c-3a2e-4656-84e6-fce75c461710', version: 1 };
      updateResult = 'missing';
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
            headers,
            payload: { expectedVersion: 1, screenplay: screenplayFixture },
          })
        ).statusCode,
      ).toBe(404);
      updateResult = 'forbidden';
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
            headers,
            payload: { expectedVersion: 1, screenplay: screenplayFixture },
          })
        ).statusCode,
      ).toBe(403);
      updateResult = 'invalid';
      const invalidIdentity = await app.inject({
        method: 'PUT',
        url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
        headers,
        payload: { expectedVersion: 1, screenplay: screenplayFixture },
      });
      expect(invalidIdentity.statusCode).toBe(400);
      expect(invalidIdentity.json()).toEqual({
        error: 'Screenplay identity must match request path',
      });
      updateResult = { version: 2 };
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
            headers,
            payload: { expectedVersion: 1, screenplay: screenplayFixture },
          })
        ).json(),
      ).toEqual({ version: 2 });
      expect(
        (await app.inject({ method: 'GET', url: '/api/projects/not-a-uuid/screenplays', headers }))
          .statusCode,
      ).toBe(400);
    } finally {
      updateResult = 'conflict';
      await app.close();
    }
  });

  it('accepts the full canonical worst-case wire body and rejects oversized bodies', async () => {
    const app = await buildApp({ auth, projects: store });
    try {
      const headers = { cookie: 'session=test' };
      updateResult = { version: 2 };
      const payload = JSON.stringify({ expectedVersion: 1, screenplay: maximumWireScreenplay() });
      expect(Buffer.byteLength(payload)).toBeGreaterThan(10 * 1024 * 1024);
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(MAX_SCREENPLAY_REQUEST_BODY_BYTES);
      const valid = await app.inject({
        method: 'PUT',
        url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
        headers: { ...headers, 'content-type': 'application/json' },
        payload,
      });
      expect(valid.statusCode).toBe(200);
      const tooLarge = await app.inject({
        method: 'PUT',
        url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: `"${'x'.repeat(MAX_SCREENPLAY_REQUEST_BODY_BYTES)}"`,
      });
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json()).toEqual({ error: 'Request too large' });
    } finally {
      updateResult = 'conflict';
      await app.close();
    }
  });

  it('returns a safe response when the auth transport fails', async () => {
    const app = await buildApp({
      projects: store,
      auth: {
        ...auth,
        handler: async () => {
          throw new Error('transport down');
        },
      },
    });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/api/auth/sign-in/email' })).statusCode,
      ).toBe(500);
    } finally {
      await app.close();
    }
  });

  it('does not 5xx when a bodyless auth request carries a JSON content-type', async () => {
    const app = await buildApp({ auth, projects: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-out',
        headers: { 'content-type': 'application/json' },
      });
      expect(response.statusCode).toBeLessThan(500);
    } finally {
      await app.close();
    }
  });

  it('returns 400 rather than 500 for malformed JSON request bodies', async () => {
    const app = await buildApp({ auth, projects: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { 'content-type': 'application/json' },
        payload: '{not valid json',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Invalid request' });
    } finally {
      await app.close();
    }
  });

  it('returns 400 with the generic body, not 500, when a ZodError from @finaler-draft/screenplay reaches the handler', async () => {
    // Regression guard for the error handler's `error instanceof z.ZodError` branch. The
    // screenplay's own `screenplaySchema.parse()` throws a ZodError constructed by
    // @finaler-draft/screenplay's zod import; this proves that error is still recognized here
    // and mapped to 400, not a 500, now that the string-name fallback has been removed.
    const app = await buildApp({ auth, projects: store });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
        headers: { cookie: 'session=test' },
        payload: { expectedVersion: 1, screenplay: { schemaVersion: 1 } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Invalid request' });
    } finally {
      await app.close();
    }
  });

  it('logs only the error name for an unmapped internal error and returns the generic body', async () => {
    const secretDetail = 'do-not-leak-connection-string';
    const failingStore: ProjectStore = {
      ...store,
      listProjects: async () => {
        throw new Error(secretDetail);
      },
    };
    const app = await buildApp({ auth, projects: failingStore });
    let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
    app.addHook('onRequest', async (request) => {
      errorSpy = vi.spyOn(request.log, 'error');
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { cookie: 'session=test' },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'Internal server error' });
      expect(errorSpy).toHaveBeenCalledWith({ err: 'Error' }, 'Request failed');
    } finally {
      await app.close();
    }
  });

  describe('rename, soft delete, and restore', () => {
    const projectId = '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f';
    const screenplayId = 'ecf1118c-3a2e-4656-84e6-fce75c461710';
    const headers = { cookie: 'session=test' };

    it('renames a project and returns the exact store response, unstripped', async () => {
      renameProjectResult = { id: projectId, title: 'New Title' };
      const app = await buildApp({ auth, projects: store });
      try {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/projects/${projectId}`,
          headers,
          payload: { title: 'New Title' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: projectId, title: 'New Title' });
      } finally {
        renameProjectResult = { id: projectId, title: 'Renamed' };
        await app.close();
      }
    });

    it('maps project rename outcomes to 404 for missing and 403 for forbidden', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        renameProjectResult = 'missing';
        const missing = await app.inject({
          method: 'PATCH',
          url: `/api/projects/${projectId}`,
          headers,
          payload: { title: 'New Title' },
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: 'Project not found' });

        renameProjectResult = 'forbidden';
        const forbidden = await app.inject({
          method: 'PATCH',
          url: `/api/projects/${projectId}`,
          headers,
          payload: { title: 'New Title' },
        });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json()).toEqual({ error: 'Project editor access required' });
      } finally {
        renameProjectResult = { id: projectId, title: 'Renamed' };
        await app.close();
      }
    });

    it('rejects a blank or overlong rename body with 400, matching the create title constraints', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        const blank = await app.inject({
          method: 'PATCH',
          url: `/api/projects/${projectId}`,
          headers,
          payload: { title: '' },
        });
        expect(blank.statusCode).toBe(400);
        const overlong = await app.inject({
          method: 'PATCH',
          url: `/api/screenplays/${screenplayId}`,
          headers,
          payload: { title: 'x'.repeat(201) },
        });
        expect(overlong.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('soft-deletes a project and returns its id, mapping outcomes to 403 and 404', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        deleteProjectResult = { id: projectId };
        const deleted = await app.inject({
          method: 'DELETE',
          url: `/api/projects/${projectId}`,
          headers,
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ id: projectId });

        deleteProjectResult = 'forbidden';
        const forbidden = await app.inject({
          method: 'DELETE',
          url: `/api/projects/${projectId}`,
          headers,
        });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json()).toEqual({ error: 'Project owner access required' });

        deleteProjectResult = 'missing';
        const missing = await app.inject({
          method: 'DELETE',
          url: `/api/projects/${projectId}`,
          headers,
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: 'Project not found' });
      } finally {
        deleteProjectResult = { id: projectId };
        await app.close();
      }
    });

    it('restores a project and returns its id and title, mapping outcomes to 403 and 404', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        restoreProjectResult = { id: projectId, title: 'Project' };
        const restored = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/restore`,
          headers,
        });
        expect(restored.statusCode).toBe(200);
        expect(restored.json()).toEqual({ id: projectId, title: 'Project' });

        restoreProjectResult = 'forbidden';
        const forbidden = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/restore`,
          headers,
        });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json()).toEqual({ error: 'Project owner access required' });

        restoreProjectResult = 'missing';
        const missing = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/restore`,
          headers,
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: 'Project not found' });
      } finally {
        restoreProjectResult = { id: projectId, title: 'Project' };
        await app.close();
      }
    });

    it('renames a screenplay and returns the exact store response, unstripped', async () => {
      renameScreenplayResult = { id: screenplayId, title: 'New Draft Title' };
      const app = await buildApp({ auth, projects: store });
      try {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/screenplays/${screenplayId}`,
          headers,
          payload: { title: 'New Draft Title' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: screenplayId, title: 'New Draft Title' });
      } finally {
        renameScreenplayResult = { id: screenplayId, title: 'Renamed' };
        await app.close();
      }
    });

    it('maps screenplay rename outcomes to 404 for missing (including soft-deleted) and 403 for forbidden', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        renameScreenplayResult = 'missing';
        const missing = await app.inject({
          method: 'PATCH',
          url: `/api/screenplays/${screenplayId}`,
          headers,
          payload: { title: 'New Title' },
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: 'Screenplay not found' });

        renameScreenplayResult = 'forbidden';
        const forbidden = await app.inject({
          method: 'PATCH',
          url: `/api/screenplays/${screenplayId}`,
          headers,
          payload: { title: 'New Title' },
        });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json()).toEqual({ error: 'Screenplay editor access required' });
      } finally {
        renameScreenplayResult = { id: screenplayId, title: 'Renamed' };
        await app.close();
      }
    });

    it('soft-deletes a screenplay and returns its id, mapping outcomes to 403 and 404', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        deleteScreenplayResult = { id: screenplayId };
        const deleted = await app.inject({
          method: 'DELETE',
          url: `/api/screenplays/${screenplayId}`,
          headers,
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ id: screenplayId });

        deleteScreenplayResult = 'forbidden';
        const forbidden = await app.inject({
          method: 'DELETE',
          url: `/api/screenplays/${screenplayId}`,
          headers,
        });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json()).toEqual({ error: 'Screenplay editor access required' });

        deleteScreenplayResult = 'missing';
        const missing = await app.inject({
          method: 'DELETE',
          url: `/api/screenplays/${screenplayId}`,
          headers,
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: 'Screenplay not found' });
      } finally {
        deleteScreenplayResult = { id: screenplayId };
        await app.close();
      }
    });

    it('restores a screenplay and returns its id and title, mapping outcomes to 403 and 404', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        restoreScreenplayResult = { id: screenplayId, title: 'Draft' };
        const restored = await app.inject({
          method: 'POST',
          url: `/api/screenplays/${screenplayId}/restore`,
          headers,
        });
        expect(restored.statusCode).toBe(200);
        expect(restored.json()).toEqual({ id: screenplayId, title: 'Draft' });

        restoreScreenplayResult = 'forbidden';
        const forbidden = await app.inject({
          method: 'POST',
          url: `/api/screenplays/${screenplayId}/restore`,
          headers,
        });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json()).toEqual({ error: 'Screenplay editor access required' });

        restoreScreenplayResult = 'missing';
        const missing = await app.inject({
          method: 'POST',
          url: `/api/screenplays/${screenplayId}/restore`,
          headers,
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: 'Screenplay not found' });
      } finally {
        restoreScreenplayResult = { id: screenplayId, title: 'Draft' };
        await app.close();
      }
    });

    it('lists deleted projects and screenplays, requires authentication, and returns fields unstripped', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        expect((await app.inject({ method: 'GET', url: '/api/deleted' })).statusCode).toBe(401);

        const response = await app.inject({ method: 'GET', url: '/api/deleted', headers });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          projects: [
            {
              id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
              title: 'Deleted project',
              updatedAt: '2026-08-06T00:00:00Z',
              deletedAt: '2026-08-07T00:00:00Z',
            },
          ],
          screenplays: [
            {
              id: 'ecf1118c-3a2e-4656-84e6-fce75c461710',
              title: 'Deleted screenplay',
              updatedAt: '2026-08-06T00:00:00Z',
              deletedAt: '2026-08-07T00:00:00Z',
              projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
              projectTitle: 'Active project',
            },
          ],
        });
      } finally {
        await app.close();
      }
    });
  });
});

function maximumWireScreenplay() {
  const dualDialogueCount = 3571;
  const textSlots = dualDialogueCount * 4;
  let nextId = 1;
  let remainingText = 1_500_000 - 1;
  let remainingSlots = textSlots;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  const text = () => {
    const length = Math.floor(remainingText / remainingSlots--);
    remainingText -= length;
    return '\u0000'.repeat(length);
  };
  return {
    schemaVersion: 1 as const,
    id: id(),
    title: 'T',
    titlePages: [],
    blocks: Array.from({ length: dualDialogueCount }, () => ({
      id: id(),
      type: 'dual_dialogue' as const,
      left: {
        id: id(),
        blocks: [
          { id: id(), type: 'character' as const, text: text() },
          { id: id(), type: 'dialogue' as const, text: text() },
        ],
      },
      right: {
        id: id(),
        blocks: [
          { id: id(), type: 'character' as const, text: text() },
          { id: id(), type: 'dialogue' as const, text: text() },
        ],
      },
    })),
    annotations: [],
  };
}

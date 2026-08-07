import { afterAll, describe, expect, it } from 'vitest';
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

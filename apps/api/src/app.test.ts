import Stripe from 'stripe';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp, MAX_SCREENPLAY_REQUEST_BODY_BYTES } from './app.js';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { DEFAULT_API_RATE_LIMIT_MAX } from '@finaler-draft/server-config';
import type { ProjectStore } from './projects.js';
import type { BillingPort } from './stripeCheckout.js';

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

describe('auth request forwarding', () => {
  it('fills in a client IP from the connection when no proxy header is present, so rate limiting is per client', async () => {
    // Better Auth resolves a client IP from headers only -- it receives a web `Request` and cannot
    // see the socket. With none present its fallback is a single shared bucket for every client
    // combined (installed `api/rate-limiter/index.mjs`, `NO_TRUSTED_IP_KEY`), which is worse than
    // no limit at all: one abusive client exhausts it and locks everyone else out. The owner hit
    // this locally, where nothing sends `x-real-ip`.
    let seen: Headers | undefined;
    const ipApp = await buildApp({
      auth: {
        baseUrl: 'http://127.0.0.1:3001',
        getActorId: async () => null,
        handler: async (request: Request) => {
          seen = request.headers;
          return new Response('{}', {
            headers: { 'content-type': 'application/json' },
            status: 200,
          });
        },
        trustedOrigins: ['http://127.0.0.1:3001'],
      },
    });
    await ipApp.inject({ method: 'GET', url: '/api/auth/ok' });
    expect(seen?.get('x-real-ip')).toBeTruthy();

    // A header that did arrive is passed through untouched: behind a real proxy its value is the
    // client's address and must win over the connection, which is the proxy itself.
    await ipApp.inject({
      headers: { 'x-real-ip': '203.0.113.7' },
      method: 'GET',
      url: '/api/auth/ok',
    });
    expect(seen?.get('x-real-ip')).toBe('203.0.113.7');
    await ipApp.close();
  });
});

describe('GET /api/test/last-mail', () => {
  it('is not registered at all when no testMail option is supplied', async () => {
    // The default `app` built above has no `testMail` option -- this is the production shape,
    // and the assertion that matters: `undefined` here means the route was never registered, not
    // that it exists and denies. A 404 that came from Fastify's own not-found handler (no
    // `{error}` body shaped like the route's own 404 response) is how that's told apart from the
    // route responding "no mail for this address."
    const response = await app.inject({
      method: 'GET',
      url: '/api/test/last-mail?to=x@example.test',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).not.toEqual({ error: 'No mail recorded for that address' });
  });

  it('refuses to exist under NODE_ENV=production even when testMail is supplied', async () => {
    // Defence in depth against a single misplaced environment variable. This route returns the
    // body of the last email sent to an address, which carries live password-reset and
    // verification tokens -- and `FINALER_SYSTEM_TEST`, the flag that supplies `testMail`
    // upstream, is not a production kill switch: `server.ts` also uses it to relax the
    // "persistence required in production" check, so it can plausibly be set in a
    // production-shaped environment. Being passed `testMail` must therefore not be sufficient.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const productionApp = await buildApp({
        testMail: {
          latestTo: () => ({
            subject: 'Reset your password',
            text: 'token-abc123',
            to: 'writer@example.test',
          }),
        },
      });
      const response = await productionApp.inject({
        method: 'GET',
        url: '/api/test/last-mail?to=writer@example.test',
      });
      expect(response.statusCode).toBe(404);
      // Not the route's own 404: the route must not have been registered at all. If it had been,
      // this would return the recorded message and leak the token above.
      expect(response.body).not.toContain('token-abc123');
      expect(response.json()).not.toEqual({ error: 'No mail recorded for that address' });
      await productionApp.close();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('returns the recorded message for the requested address when testMail is supplied', async () => {
    const testMailApp = await buildApp({
      testMail: {
        latestTo: (to) =>
          to === 'writer@example.test'
            ? { to, subject: 'Verify your email', text: 'link: https://x' }
            : undefined,
      },
    });
    try {
      const found = await testMailApp.inject({
        method: 'GET',
        url: '/api/test/last-mail?to=writer@example.test',
      });
      expect(found.statusCode).toBe(200);
      expect(found.json()).toEqual({ subject: 'Verify your email', text: 'link: https://x' });

      const notFound = await testMailApp.inject({
        method: 'GET',
        url: '/api/test/last-mail?to=nobody@example.test',
      });
      expect(notFound.statusCode).toBe(404);
      expect(notFound.json()).toEqual({ error: 'No mail recorded for that address' });
    } finally {
      await testMailApp.close();
    }
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

  it('caches a content-hashed asset as immutable for a year, since its URL changes the moment its content does', async () => {
    const productionApp = await buildApp({
      serveClient: true,
      clientRoot: new URL('./fixtures/web/', import.meta.url),
    });
    try {
      const response = await productionApp.inject({
        method: 'GET',
        url: '/assets/index-fixturehash.js',
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    } finally {
      await productionApp.close();
    }
  });

  it('never caches index.html, whether requested directly or reached through the SPA fallback, since a new deploy answers at the same URL', async () => {
    const productionApp = await buildApp({
      serveClient: true,
      clientRoot: new URL('./fixtures/web/', import.meta.url),
    });
    try {
      const direct = await productionApp.inject({ method: 'GET', url: '/index.html' });
      const viaFallback = await productionApp.inject({ method: 'GET', url: '/writer/anything' });
      expect(direct.headers['cache-control']).toBe('no-cache');
      expect(viaFallback.headers['cache-control']).toBe('no-cache');
    } finally {
      await productionApp.close();
    }
  });

  // @fastify/static (via its @fastify/send dependency) omits Content-Type entirely on a 304
  // response -- reading its installed source confirms `sendNotModified` deletes that header
  // before sending. An earlier version of the no-cache override above keyed off
  // `Content-Type: text/html`, so it silently stopped applying the moment a browser's
  // conditional revalidation of index.html got a 304 instead of a fresh 200, leaving the
  // static plugin's `public, max-age=31536000, immutable` default in place -- letting a
  // browser cache the app shell as immutable for a year. This reproduces that exact
  // conditional-request sequence end to end.
  it('still marks index.html no-cache on a 304 conditional revalidation, not just on the initial 200', async () => {
    const productionApp = await buildApp({
      serveClient: true,
      clientRoot: new URL('./fixtures/web/', import.meta.url),
    });
    try {
      const first = await productionApp.inject({ method: 'GET', url: '/index.html' });
      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('no-cache');
      const etag = first.headers.etag;
      expect(typeof etag).toBe('string');

      const conditional = await productionApp.inject({
        method: 'GET',
        url: '/index.html',
        headers: { 'if-none-match': etag as string },
      });
      expect(conditional.statusCode).toBe(304);
      expect(conditional.headers['content-type']).toBeUndefined();
      expect(conditional.headers['cache-control']).toBe('no-cache');
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
  let createScreenplayResult: { id: string; version: number } | 'forbidden' | 'entitlement-limit' =
    {
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
      if (createScreenplayResult === 'entitlement-limit')
        throw new (await import('./entitlements.js')).EntitlementLimitError(
          'Free tier limit reached: only one editable screenplay is allowed. Choose an existing one to keep editing, or upgrade to create another.',
        );
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
    trustedOrigins: ['https://app.example.test'],
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
      const headers = { cookie: 'session=test', origin: 'https://app.example.test' };
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
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
        payload: { expectedVersion: 1, screenplay: screenplayFixture },
      });
      expect(response.statusCode).toBe(409);
      const invalid = await app.inject({
        method: 'PUT',
        url: '/api/screenplays/ecf1118c-3a2e-4656-84e6-fce75c461710',
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
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
      const headers = { cookie: 'session=test', origin: 'https://app.example.test' };
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
      // 402, not 403: distinct from the plain membership refusal just above, and distinct on
      // purpose (see app.ts's comment on this mapping) -- a billing-driven refusal is something
      // the web client (routes/projects/$projectId/index.tsx's free-tier limit prompt) needs to
      // tell apart from "you don't have access here" without parsing the message text.
      createScreenplayResult = 'entitlement-limit';
      const limitResponse = await app.inject({
        method: 'POST',
        url: '/api/projects/5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f/screenplays',
        headers,
        payload: { title: 'Draft', screenplay: screenplayFixture },
      });
      expect(limitResponse.statusCode).toBe(402);
      expect(limitResponse.json()).toEqual({
        error:
          'Free tier limit reached: only one editable screenplay is allowed. Choose an existing one to keep editing, or upgrade to create another.',
      });
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
      const headers = { cookie: 'session=test', origin: 'https://app.example.test' };
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
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
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
    const headers = { cookie: 'session=test', origin: 'https://app.example.test' };

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

  describe('same-site sibling-origin CSRF defense', () => {
    const projectId = '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f';

    it('rejects a state-changing request whose Origin is not in the trusted-origins allowlist, even with a valid session', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        const forged = await app.inject({
          method: 'DELETE',
          url: `/api/projects/${projectId}`,
          headers: {
            cookie: 'session=test',
            origin: 'https://evil.example.test',
          },
        });
        expect(forged.statusCode).toBe(403);
        expect(forged.json()).toEqual({ error: 'Cross-origin request rejected' });
      } finally {
        await app.close();
      }
    });

    it('accepts a request whose Origin is in the trusted-origins allowlist', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        const legitimate = await app.inject({
          method: 'DELETE',
          url: `/api/projects/${projectId}`,
          headers: {
            cookie: 'session=test',
            origin: 'https://app.example.test',
          },
        });
        expect(legitimate.statusCode).toBe(200);
      } finally {
        deleteProjectResult = { id: projectId };
        await app.close();
      }
    });

    // The exact dev-proxy topology `pnpm dev` runs under: Vite's proxy forwards `/api` to the
    // API with `changeOrigin: true`, which rewrites the outgoing Host header to the API's own
    // host while leaving the browser's real Origin (the Vite dev server's own origin) untouched.
    // An earlier version of this check compared Origin's host against the request's own Host
    // header, which rejected every authenticated write under this exact, documented workflow.
    // Comparing Origin against a fixed trusted-origins allowlist instead of the (proxy-rewritable)
    // Host header is what makes this pass.
    it('accepts a request whose Origin is in the trusted-origins allowlist even when the Host header does not match it', async () => {
      const devAuth = {
        ...auth,
        trustedOrigins: [...auth.trustedOrigins, 'http://localhost:5173'],
      };
      const app = await buildApp({ auth: devAuth, projects: store });
      try {
        const throughDevProxy = await app.inject({
          method: 'DELETE',
          url: `/api/projects/${projectId}`,
          headers: {
            cookie: 'session=test',
            host: 'localhost:3001',
            origin: 'http://localhost:5173',
          },
        });
        expect(throughDevProxy.statusCode).toBe(200);
      } finally {
        deleteProjectResult = { id: projectId };
        await app.close();
      }
    });

    // Safe and unsafe methods are judged differently on an absent `Origin` header -- this is the
    // refinement plan.md's security-gates section asks for, not a rewrite of the guard above.
    // Real browsers always attach `Origin` to a same-origin POST/PUT/PATCH/DELETE, so an unsafe
    // method arriving with none is refused; they omit it on ordinary same-origin GETs, so a safe
    // method arriving with none still succeeds. This pair of tests is the actual specification of
    // that behavior; the `origin` header added to every other request in this file's other
    // describe blocks only makes those tests realistic, it doesn't test this distinction itself.
    it('rejects a state-changing request with no Origin header at all, since a real browser always attaches one to a same-origin write', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        const noOrigin = await app.inject({
          method: 'DELETE',
          url: `/api/projects/${projectId}`,
          headers: { cookie: 'session=test' },
        });
        expect(noOrigin.statusCode).toBe(403);
        expect(noOrigin.json()).toEqual({ error: 'Cross-origin request rejected' });
      } finally {
        await app.close();
      }
    });

    // This is the scenario behind the owner's own report: the projects page loaded correctly on
    // an unfamiliar port because a same-origin GET carries no `Origin` header at all, and this
    // route group is read from, not just written to, through the very same `preValidation` hook.
    it('accepts a GET request with no Origin header at all, since browsers do not attach one to ordinary same-origin reads', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        const noOriginRead = await app.inject({
          method: 'GET',
          url: '/api/projects',
          headers: { cookie: 'session=test' },
        });
        expect(noOriginRead.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('rejects a malformed Origin header rather than letting it slip through unchecked', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        const malformed = await app.inject({
          method: 'DELETE',
          url: `/api/projects/${projectId}`,
          headers: { cookie: 'session=test', origin: 'not-a-url' },
        });
        expect(malformed.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('checks Origin before authentication, so a forged cross-origin request is rejected even without a valid session', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        const forgedAndUnauthenticated = await app.inject({
          method: 'DELETE',
          url: `/api/projects/${projectId}`,
          headers: { origin: 'https://evil.example.test' },
        });
        expect(forgedAndUnauthenticated.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });
  });

  describe('Cache-Control on every /api/ response', () => {
    it('marks a successful response private and non-cacheable', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/api/projects',
          headers: { cookie: 'session=test' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('private, no-store');
      } finally {
        await app.close();
      }
    });

    it('marks an error response private and non-cacheable too, not only success', async () => {
      const app = await buildApp({ auth, projects: store });
      try {
        const response = await app.inject({ method: 'GET', url: '/api/projects' });
        expect(response.statusCode).toBe(401);
        expect(response.headers['cache-control']).toBe('private, no-store');
      } finally {
        await app.close();
      }
    });

    it('applies even to /api/health, which needs no authentication', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.headers['cache-control']).toBe('private, no-store');
    });

    it('does not apply to a non-API path', async () => {
      const productionApp = await buildApp({
        serveClient: true,
        clientRoot: new URL('./fixtures/web/', import.meta.url),
      });
      try {
        const response = await productionApp.inject({ method: 'GET', url: '/writer/anything' });
        expect(response.headers['cache-control']).not.toBe('private, no-store');
      } finally {
        await productionApp.close();
      }
    });
  });

  describe('database readiness on /api/health', () => {
    it('reports healthy when no readiness probe is configured, matching every route registered without persistence', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('reports healthy when the probe resolves true, and unavailable when it resolves false', async () => {
      let ready = true;
      const probedApp = await buildApp({ databaseReady: async () => ready });
      try {
        const healthy = await probedApp.inject({ method: 'GET', url: '/api/health' });
        expect(healthy.statusCode).toBe(200);
        expect(healthy.json()).toEqual({ status: 'ok' });

        ready = false;
        const unhealthy = await probedApp.inject({ method: 'GET', url: '/api/health' });
        expect(unhealthy.statusCode).toBe(503);
        expect(unhealthy.json()).toEqual({ status: 'unavailable' });
      } finally {
        await probedApp.close();
      }
    });
  });
});

describe('entitlement API', () => {
  const entitlementAuth = {
    baseUrl: 'https://app.example.test',
    handler: async () =>
      new Response('auth', { headers: { 'set-cookie': 'session=test; HttpOnly' } }),
    getActorId: async (headers: Headers) =>
      headers.get('cookie') === 'session=test' ? 'actor-1' : null,
    trustedOrigins: ['https://app.example.test'],
  };
  const headers = { cookie: 'session=test', origin: 'https://app.example.test' };

  it('GET /api/entitlement requires authentication, same as the project routes', async () => {
    const app = await buildApp({
      auth: entitlementAuth,
      entitlements: {
        getSnapshot: async () => {
          throw new Error('must not be reached unauthenticated');
        },
        claimEmptySlot: async () => undefined,
        switchEditableScreenplay: async () => ({ outcome: 'not-a-candidate' }),
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/entitlement' });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET /api/entitlement reports a restricted account with an unambiguous single candidate', async () => {
    const app = await buildApp({
      auth: entitlementAuth,
      entitlements: {
        getSnapshot: async () => ({
          subscriptionStatus: undefined,
          candidateScreenplayIds: ['screenplay-1'],
          slot: null,
          now: new Date('2026-09-01T00:00:00Z'),
        }),
        claimEmptySlot: async () => undefined,
        switchEditableScreenplay: async () => ({ outcome: 'not-a-candidate' }),
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/entitlement', headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        tier: 'restricted',
        editableScreenplayId: 'screenplay-1',
        candidateScreenplayIds: ['screenplay-1'],
        slotUpdatedAt: null,
        cooldownEndsAt: null,
      });
    } finally {
      await app.close();
    }
  });

  it('GET /api/entitlement reports a lapsed account with several screenplays and no choice made', async () => {
    const app = await buildApp({
      auth: entitlementAuth,
      entitlements: {
        getSnapshot: async () => ({
          subscriptionStatus: 'canceled',
          candidateScreenplayIds: ['screenplay-1', 'screenplay-2'],
          slot: null,
          now: new Date('2026-09-01T00:00:00Z'),
        }),
        claimEmptySlot: async () => undefined,
        switchEditableScreenplay: async () => ({ outcome: 'not-a-candidate' }),
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/entitlement', headers });
      expect(response.json()).toEqual({
        tier: 'restricted',
        editableScreenplayId: null,
        candidateScreenplayIds: ['screenplay-1', 'screenplay-2'],
        slotUpdatedAt: null,
        cooldownEndsAt: null,
      });
    } finally {
      await app.close();
    }
  });

  it('GET /api/entitlement reports the cooldown deadline derived from the slot timestamp', async () => {
    const slotUpdatedAt = new Date('2026-09-01T00:00:00Z');
    const app = await buildApp({
      auth: entitlementAuth,
      entitlements: {
        getSnapshot: async () => ({
          subscriptionStatus: 'canceled',
          candidateScreenplayIds: ['screenplay-1', 'screenplay-2'],
          slot: { screenplayId: 'screenplay-1', updatedAt: slotUpdatedAt },
          now: new Date('2026-09-01T06:00:00Z'),
        }),
        claimEmptySlot: async () => undefined,
        switchEditableScreenplay: async () => ({ outcome: 'not-a-candidate' }),
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/entitlement', headers });
      expect(response.json()).toEqual({
        tier: 'restricted',
        editableScreenplayId: 'screenplay-1',
        candidateScreenplayIds: ['screenplay-1', 'screenplay-2'],
        slotUpdatedAt: '2026-09-01T00:00:00.000Z',
        cooldownEndsAt: '2026-09-02T00:00:00.000Z',
      });
    } finally {
      await app.close();
    }
  });

  it('GET /api/entitlement reports a paid account with no candidate list or slot needed', async () => {
    const app = await buildApp({
      auth: entitlementAuth,
      entitlements: {
        getSnapshot: async () => ({
          subscriptionStatus: 'active',
          candidateScreenplayIds: ['screenplay-1', 'screenplay-2'],
          slot: null,
          now: new Date('2026-09-01T00:00:00Z'),
        }),
        claimEmptySlot: async () => undefined,
        switchEditableScreenplay: async () => ({ outcome: 'not-a-candidate' }),
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/entitlement', headers });
      expect(response.json()).toEqual({
        tier: 'paid',
        editableScreenplayId: null,
        candidateScreenplayIds: [],
        slotUpdatedAt: null,
        cooldownEndsAt: null,
      });
    } finally {
      await app.close();
    }
  });

  it('PUT /api/entitlement/editable-screenplay reports success with the store’s own resulting timestamp', async () => {
    const updatedAt = new Date('2026-09-01T12:00:00Z');
    const app = await buildApp({
      auth: entitlementAuth,
      entitlements: {
        getSnapshot: async () => {
          throw new Error('not exercised by this route');
        },
        claimEmptySlot: async () => undefined,
        switchEditableScreenplay: async (_actorId, screenplayId) => ({
          outcome: 'applied',
          screenplayId,
          updatedAt,
        }),
      },
    });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/entitlement/editable-screenplay',
        headers,
        payload: { screenplayId: 'ecf1118c-3a2e-4656-84e6-fce75c461710' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        screenplayId: 'ecf1118c-3a2e-4656-84e6-fce75c461710',
        updatedAt: updatedAt.toISOString(),
      });
    } finally {
      await app.close();
    }
  });

  it('PUT /api/entitlement/editable-screenplay reports 404 for a screenplay outside the candidate set, not a 403 that would leak its existence', async () => {
    const app = await buildApp({
      auth: entitlementAuth,
      entitlements: {
        getSnapshot: async () => {
          throw new Error('not exercised by this route');
        },
        claimEmptySlot: async () => undefined,
        switchEditableScreenplay: async () => ({ outcome: 'not-a-candidate' }),
      },
    });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/entitlement/editable-screenplay',
        headers,
        payload: { screenplayId: 'ecf1118c-3a2e-4656-84e6-fce75c461710' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Screenplay not found' });
    } finally {
      await app.close();
    }
  });

  it('PUT /api/entitlement/editable-screenplay reports 409 while the cooldown is active', async () => {
    const app = await buildApp({
      auth: entitlementAuth,
      entitlements: {
        getSnapshot: async () => {
          throw new Error('not exercised by this route');
        },
        claimEmptySlot: async () => undefined,
        switchEditableScreenplay: async () => ({ outcome: 'cooldown' }),
      },
    });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/entitlement/editable-screenplay',
        headers,
        payload: { screenplayId: 'ecf1118c-3a2e-4656-84e6-fce75c461710' },
      });
      expect(response.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});

describe('billing checkout API', () => {
  const billingAuth = {
    baseUrl: 'https://app.example.test',
    handler: async () =>
      new Response('auth', { headers: { 'set-cookie': 'session=test; HttpOnly' } }),
    getActorId: async (headers: Headers) =>
      headers.get('cookie') === 'session=test' ? 'actor-1' : null,
    trustedOrigins: ['https://app.example.test'],
  };
  const headers = { cookie: 'session=test', origin: 'https://app.example.test' };

  // Obviously-fake test-only values, never anything resembling a real Stripe credential.
  const TEST_PRICE_ID_MONTHLY = 'price_test_FAKE_monthly';
  const TEST_PRICE_ID_ANNUAL = 'price_test_FAKE_annual';

  // A real `Stripe.errors.StripeInvalidRequestError` instance, not a plain object shaped like
  // one -- `logStripeRequestFailure` (app.ts) branches on `instanceof Stripe.errors.StripeError`,
  // so the test has to construct the real thing to exercise that branch at all. `requestId` and
  // `statusCode` aren't constructor arguments on the real SDK (they're attached separately, from
  // the HTTP response, by Stripe's own error-generation code) so they're assigned afterward here.
  function fakeStripeInvalidRequestError(fields: {
    code?: string;
    docUrl?: string;
    message?: string;
    param?: string;
    requestId?: string;
    statusCode?: number;
    type?: Stripe.RawErrorType;
  }): Stripe.errors.StripeInvalidRequestError {
    // Built by spreading only the fields actually supplied, not passing `undefined` explicitly --
    // `exactOptionalPropertyTypes` (this repo's strict tsconfig) treats `{ code: undefined }` as a
    // different, disallowed shape from simply omitting `code`.
    return new Stripe.errors.StripeInvalidRequestError({
      message: fields.message ?? 'A fake Stripe rejection for this test.',
      type: fields.type ?? 'invalid_request_error',
      ...(fields.code !== undefined ? { code: fields.code } : {}),
      ...(fields.docUrl !== undefined ? { doc_url: fields.docUrl } : {}),
      ...(fields.param !== undefined ? { param: fields.param } : {}),
      ...(fields.requestId !== undefined ? { requestId: fields.requestId } : {}),
      ...(fields.statusCode !== undefined ? { statusCode: fields.statusCode } : {}),
    });
  }

  function fakeBilling(overrides?: {
    checkoutError?: unknown;
    checkoutUrl?: string | null;
    portalError?: unknown;
    portalUrl?: string;
    plansError?: unknown;
    existingCustomerId?: string;
    subscriptionStatus?: 'active' | 'trialing' | 'past_due' | 'canceled';
    subscriptionPriceId?: string;
    cancelAtPeriodEnd?: boolean;
    canceledAt?: Date | null;
    onCheckoutCreate?: (params: unknown) => void;
  }): BillingPort {
    return {
      client: {
        checkout: {
          sessions: {
            create: async (params: unknown) => {
              if (overrides?.checkoutError) throw overrides.checkoutError;
              overrides?.onCheckoutCreate?.(params);
              return {
                id: 'cs_test_FAKE_1',
                url: overrides?.checkoutUrl ?? 'https://checkout.stripe.test/cs_test_FAKE_1',
              };
            },
          },
        },
        billingPortal: {
          sessions: {
            create: async () => {
              if (overrides?.portalError) throw overrides.portalError;
              return {
                id: 'bps_test_FAKE_1',
                url: overrides?.portalUrl ?? 'https://billing.stripe.test/bps_test_FAKE_1',
              };
            },
          },
        },
        prices: {
          retrieve: async (priceId: string) => {
            if (overrides?.plansError) throw overrides.plansError;
            return priceId === TEST_PRICE_ID_ANNUAL
              ? { id: priceId, unit_amount: 5000, currency: 'usd', recurring: { interval: 'year' } }
              : {
                  id: priceId,
                  unit_amount: 500,
                  currency: 'usd',
                  recurring: { interval: 'month' },
                };
          },
        },
      } as unknown as BillingPort['client'],
      store: {
        getSubscriptionForUser: async () =>
          overrides?.existingCustomerId
            ? {
                userId: 'actor-1',
                stripeCustomerId: overrides.existingCustomerId,
                stripeSubscriptionId: 'sub_test_FAKE_1',
                stripePriceId: overrides.subscriptionPriceId ?? TEST_PRICE_ID_MONTHLY,
                status: overrides.subscriptionStatus ?? ('active' as const),
                currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
                cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
                canceledAt: overrides.canceledAt ?? null,
              }
            : undefined,
      },
      priceIds: { monthly: TEST_PRICE_ID_MONTHLY, annual: TEST_PRICE_ID_ANNUAL },
      appOrigin: 'https://app.example.test',
    };
  }

  it('POST /api/billing/checkout-session requires authentication', async () => {
    const app = await buildApp({ auth: billingAuth, billing: fakeBilling() });
    try {
      // A same-origin request without a session -- the Origin header alone is not enough, so
      // this exercises the authentication check specifically, not the earlier CSRF/origin guard
      // (already covered for this same shared hook in the "persisted project API" suite above).
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout-session',
        headers: { origin: 'https://app.example.test' },
        payload: { plan: 'monthly' },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/billing/checkout-session rejects a body naming another user -- the schema admits no such field', async () => {
    const app = await buildApp({ auth: billingAuth, billing: fakeBilling() });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout-session',
        headers,
        // A caller cannot request a session "for" another actor: there is no field to name one
        // with, so an attempt to add one is rejected as an invalid request rather than silently
        // ignored.
        payload: { plan: 'monthly', userId: 'actor-2' },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/billing/checkout-session creates a session for the authenticated actor only, and returns its url', async () => {
    let seenUserId: unknown;
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling({
        onCheckoutCreate: (params) => {
          seenUserId = (params as { metadata?: { userId?: string } }).metadata?.userId;
        },
      }),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout-session',
        headers,
        payload: { plan: 'monthly' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ url: 'https://checkout.stripe.test/cs_test_FAKE_1' });
      expect(seenUserId).toBe('actor-1');
    } finally {
      await app.close();
    }
  });

  it('POST /api/billing/portal-session requires authentication', async () => {
    const app = await buildApp({ auth: billingAuth, billing: fakeBilling() });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/portal-session',
        headers: { origin: 'https://app.example.test' },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/billing/portal-session reports 404 when the actor has never subscribed', async () => {
    const app = await buildApp({ auth: billingAuth, billing: fakeBilling() });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/portal-session',
        headers,
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/billing/portal-session returns the Portal url for an existing customer', async () => {
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling({ existingCustomerId: 'cus_test_FAKE_1' }),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/portal-session',
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ url: 'https://billing.stripe.test/bps_test_FAKE_1' });
    } finally {
      await app.close();
    }
  });

  it('GET /api/billing/subscription requires authentication', async () => {
    const app = await buildApp({ auth: billingAuth, billing: fakeBilling() });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/billing/subscription' });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET /api/billing/subscription reports null for an account that has never subscribed', async () => {
    const app = await buildApp({ auth: billingAuth, billing: fakeBilling() });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ subscription: null });
    } finally {
      await app.close();
    }
  });

  it('GET /api/billing/subscription reports the plan, status, and dates for an active monthly subscriber, never leaking Stripe ids', async () => {
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling({ existingCustomerId: 'cus_test_FAKE_1' }),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers,
      });
      expect(response.statusCode).toBe(200);
      // `.toEqual`, not `.toMatchObject`: proves the body carries *only* this shape -- no
      // `stripeCustomerId`/`stripeSubscriptionId` leaking through alongside it.
      expect(response.json()).toEqual({
        subscription: {
          plan: 'monthly',
          status: 'active',
          currentPeriodEnd: '2026-10-01T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          canceledAt: null,
        },
      });
    } finally {
      await app.close();
    }
  });

  it('GET /api/billing/subscription reports the annual plan and pending cancellation for a subscriber who canceled at period end', async () => {
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling({
        existingCustomerId: 'cus_test_FAKE_1',
        subscriptionPriceId: TEST_PRICE_ID_ANNUAL,
        cancelAtPeriodEnd: true,
      }),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers,
      });
      expect(response.json()).toMatchObject({
        subscription: { plan: 'annual', cancelAtPeriodEnd: true },
      });
    } finally {
      await app.close();
    }
  });

  it('GET /api/billing/subscription reports a lapsed account distinctly from one that never subscribed', async () => {
    const canceledAt = new Date('2026-09-15T00:00:00Z');
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling({
        existingCustomerId: 'cus_test_FAKE_1',
        subscriptionStatus: 'canceled',
        canceledAt,
      }),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers,
      });
      expect(response.json()).toEqual({
        subscription: {
          plan: 'monthly',
          status: 'canceled',
          currentPeriodEnd: '2026-10-01T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          canceledAt: canceledAt.toISOString(),
        },
      });
    } finally {
      await app.close();
    }
  });

  it('GET /api/billing/subscription reports "unknown" for a price id that matches neither configured plan', async () => {
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling({
        existingCustomerId: 'cus_test_FAKE_1',
        subscriptionPriceId: 'price_test_FAKE_some_other_price',
      }),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers,
      });
      expect(response.json()).toMatchObject({ subscription: { plan: 'unknown' } });
    } finally {
      await app.close();
    }
  });

  it('GET /api/billing/plans requires authentication', async () => {
    const app = await buildApp({ auth: billingAuth, billing: fakeBilling() });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/billing/plans' });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET /api/billing/plans reports the real configured monthly and annual prices', async () => {
    const app = await buildApp({ auth: billingAuth, billing: fakeBilling() });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/billing/plans', headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        monthly: { amount: 500, currency: 'usd', interval: 'month' },
        annual: { amount: 5000, currency: 'usd', interval: 'year' },
      });
    } finally {
      await app.close();
    }
  });

  it('GET /api/billing/plans logs a diagnosable line and returns 502 when Stripe rejects the price lookup', async () => {
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling({
        plansError: fakeStripeInvalidRequestError({ code: 'resource_missing', statusCode: 404 }),
      }),
    });
    let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
    app.addHook('onRequest', async (request) => {
      errorSpy = vi.spyOn(request.log, 'error');
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/billing/plans', headers });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: 'Could not load pricing. Try again shortly.' });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'stripe_request_failed', operation: 'billing_plans' }),
        'Stripe rejected a request this server made',
      );
    } finally {
      await app.close();
    }
  });

  // Regression coverage for a real finding running this branch against a real Stripe sandbox:
  // both Checkout buttons returned a bare 400 with nothing in the response or the server log
  // naming why (it turned out to be an account-configuration prerequisite for `automatic_tax`,
  // not a bug -- see stripeCheckout.ts and app.ts's own comments). These prove the fix: a Stripe
  // rejection now surfaces as a distinct 502 (not the generic error handler's plain 500) and logs
  // a bounded, operator-diagnosable line naming the Stripe error's own type/code/param/requestId,
  // never the raw error object.
  it('logs a diagnosable line and returns 502, not a bare 500, when Stripe rejects the Checkout Session request', async () => {
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling({
        checkoutError: fakeStripeInvalidRequestError({
          code: 'automatic_tax_supported',
          param: 'automatic_tax[enabled]',
          requestId: 'req_test_FAKE123',
          statusCode: 400,
          message: 'This Checkout Session cannot enable automatic tax without an origin address.',
        }),
      }),
    });
    let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
    app.addHook('onRequest', async (request) => {
      errorSpy = vi.spyOn(request.log, 'error');
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout-session',
        headers,
        payload: { plan: 'monthly' },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: 'Could not start checkout. Try again shortly.' });
      expect(errorSpy).toHaveBeenCalledWith(
        {
          event: 'stripe_request_failed',
          operation: 'checkout_session',
          stripeErrorType: 'StripeInvalidRequestError',
          stripeErrorRawType: 'invalid_request_error',
          stripeErrorCode: 'automatic_tax_supported',
          stripeErrorParam: 'automatic_tax[enabled]',
          stripeRequestId: 'req_test_FAKE123',
          stripeStatusCode: 400,
          stripeDocUrl: undefined,
        },
        'Stripe rejected a request this server made',
      );
      // Never the raw error message or the error object itself -- only the bounded field set.
      const logged = JSON.stringify(errorSpy?.mock.calls);
      expect(logged).not.toContain('origin address');
    } finally {
      await app.close();
    }
  });

  it('logs a diagnosable line and returns 502 when Stripe rejects the Portal session request', async () => {
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling({
        existingCustomerId: 'cus_test_FAKE_1',
        portalError: fakeStripeInvalidRequestError({
          code: 'resource_missing',
          requestId: 'req_test_FAKE456',
          statusCode: 404,
        }),
      }),
    });
    let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
    app.addHook('onRequest', async (request) => {
      errorSpy = vi.spyOn(request.log, 'error');
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/portal-session',
        headers,
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: 'Could not open billing management. Try again shortly.',
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'stripe_request_failed',
          operation: 'portal_session',
          stripeErrorType: 'StripeInvalidRequestError',
          stripeErrorRawType: 'invalid_request_error',
          stripeErrorCode: 'resource_missing',
          stripeRequestId: 'req_test_FAKE456',
          stripeStatusCode: 404,
        }),
        'Stripe rejected a request this server made',
      );
    } finally {
      await app.close();
    }
  });

  it('logs by error name, not a Stripe-shaped line, when checkout fails for a reason other than a Stripe rejection', async () => {
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling({ checkoutError: new Error('boom') }),
    });
    let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
    app.addHook('onRequest', async (request) => {
      errorSpy = vi.spyOn(request.log, 'error');
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout-session',
        headers,
        payload: { plan: 'monthly' },
      });
      expect(response.statusCode).toBe(502);
      expect(errorSpy).toHaveBeenCalledWith(
        { event: 'stripe_request_failed', operation: 'checkout_session', err: 'Error' },
        'A billing request failed for a reason other than a Stripe API rejection',
      );
    } finally {
      await app.close();
    }
  });

  // plan.md: "The Checkout success redirect is not proof of payment. A user can navigate to the
  // success URL directly ... Granting access on redirect is the single most common way
  // subscription integrations leak paid features." Creating a Checkout Session is exactly what
  // happens before a user is sent to Stripe -- and therefore exactly what has already happened by
  // the time anyone could reach the success URL, webhook or not. This proves that act alone
  // changes nothing: the same actor's entitlement, read immediately afterward with no webhook
  // event ever delivered, is unaffected.
  it('creating a Checkout Session grants no entitlement by itself -- only the webhook can', async () => {
    const app = await buildApp({
      auth: billingAuth,
      billing: fakeBilling(),
      entitlements: {
        getSnapshot: async () => ({
          subscriptionStatus: undefined,
          candidateScreenplayIds: [],
          slot: null,
          now: new Date('2026-09-01T00:00:00Z'),
        }),
        claimEmptySlot: async () => undefined,
        switchEditableScreenplay: async () => ({ outcome: 'not-a-candidate' }),
      },
    });
    try {
      const checkoutResponse = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout-session',
        headers,
        payload: { plan: 'monthly' },
      });
      expect(checkoutResponse.statusCode).toBe(200);
      // Navigating straight to the success URL is simulated here as "read entitlement state right
      // after the session was created" -- there is no webhook delivery anywhere in this test, and
      // there must not need to be one for this assertion to hold.
      const entitlementResponse = await app.inject({
        method: 'GET',
        url: '/api/entitlement',
        headers,
      });
      expect(entitlementResponse.json()).toMatchObject({ tier: 'restricted' });
    } finally {
      await app.close();
    }
  });
});

describe('global per-client request cap', () => {
  // Distinct from Better Auth's own rate limiter (auth.test.ts, persistence.integration.test.ts):
  // this one applies ahead of every route, including `/api/health`, which is never behind
  // Better Auth's own limiter at all. A low explicit cap here, rather than driving the real
  // production default past its threshold, keeps this test fast and independent of what that
  // default happens to be set to.
  it('refuses further requests once a single client exceeds the configured cap, regardless of endpoint', async () => {
    const cappedApp = await buildApp({ rateLimit: { max: 2, timeWindowMs: 60_000 } });
    try {
      const first = await cappedApp.inject({ method: 'GET', url: '/api/health' });
      const second = await cappedApp.inject({ method: 'GET', url: '/api/health' });
      const third = await cappedApp.inject({ method: 'GET', url: '/api/health' });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(third.statusCode).toBe(429);
      expect(third.json()).toEqual({ error: 'Too many requests' });
    } finally {
      await cappedApp.close();
    }
  });

  // Asserts against the real default straight from `@finaler-draft/server-config` rather than a
  // number restated here, so this fails the moment `buildApp`'s fallback drifts from the config
  // package's own constant -- the exact silent-drift `plan.md`'s "a default that is right by luck
  // is not a decision" concern is about.
  it('applies the real production default from server-config when no override is supplied', async () => {
    const defaultApp = await buildApp();
    try {
      const response = await defaultApp.inject({ method: 'GET', url: '/api/health' });
      expect(response.headers['x-ratelimit-limit']).toBe(String(DEFAULT_API_RATE_LIMIT_MAX));
    } finally {
      await defaultApp.close();
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

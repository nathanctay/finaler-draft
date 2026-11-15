import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import type { AccountDeletionStore, DeleteAccountOutcome } from './accountDeletion.js';

/**
 * Route-level coverage for `GET /api/account/owned-projects-with-collaborators` and
 * `POST /api/account/delete`: that both are absent entirely without an `accountDeletion` store,
 * that they carry the same authenticated-actor and same-origin requirements every other route
 * here does, that each hands the store the authenticated session's own actor id, and that each of
 * `accountDeletion.ts`'s own outcomes maps to the HTTP shape this slice's brief describes. Follows
 * `feedbackRoutes.test.ts`'s shape: a fake store that records what it was called with, and
 * `app.inject` against a real `buildApp`, so the `preValidation` hook, the same-origin guard, and
 * the schema are all genuinely in the path rather than stubbed out.
 *
 * `accountDeletion.test.ts` and `accountDeletion.integration.test.ts` cover the store's own
 * orchestration and real SQL; this file covers only the HTTP surface on top of it.
 */
const actorId = 'session-actor';
const headers = { cookie: 'session=test', origin: 'https://app.example.test' };

const auth = {
  baseUrl: 'https://app.example.test',
  handler: async () => new Response(null, { status: 204 }),
  getActorId: async (requestHeaders: Headers) =>
    requestHeaders.get('cookie') === 'session=test' ? actorId : null,
  trustedOrigins: ['https://app.example.test'],
};

let findCalls: string[];
let deleteCalls: Array<{ actorId: string; deleteOwnedProjectsWithCollaborators: boolean }>;

function fakeAccountDeletionStore(
  findResult: Awaited<ReturnType<AccountDeletionStore['findOwnedProjectsWithCollaborators']>>,
  deleteResult: DeleteAccountOutcome,
): AccountDeletionStore {
  return {
    findOwnedProjectsWithCollaborators: vi.fn(async (id: string) => {
      findCalls.push(id);
      return findResult;
    }),
    deleteAccount: vi.fn(
      async (id: string, options: { deleteOwnedProjectsWithCollaborators: boolean }) => {
        deleteCalls.push({ actorId: id, ...options });
        return deleteResult;
      },
    ),
  };
}

beforeEach(() => {
  findCalls = [];
  deleteCalls = [];
});

async function withApp<T>(
  accountDeletion: AccountDeletionStore,
  run: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<T>,
) {
  const app = await buildApp({ auth, accountDeletion });
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

describe('GET /api/account/owned-projects-with-collaborators', () => {
  it('is not registered at all when no accountDeletion store is supplied', async () => {
    const app = await buildApp({ auth });
    try {
      const response = await app.inject({
        headers,
        method: 'GET',
        url: '/api/account/owned-projects-with-collaborators',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('requires an authenticated session', async () => {
    const store = fakeAccountDeletionStore([], { outcome: 'deleted' });
    await withApp(store, async (app) => {
      const response = await app.inject({
        headers: { origin: 'https://app.example.test' },
        method: 'GET',
        url: '/api/account/owned-projects-with-collaborators',
      });
      expect(response.statusCode).toBe(401);
      expect(findCalls).toEqual([]);
    });
  });

  it("reads the authenticated session's own actor, and returns the store's list verbatim", async () => {
    const projects = [{ id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f', title: 'Shared screenplay' }];
    const store = fakeAccountDeletionStore(projects, { outcome: 'deleted' });
    await withApp(store, async (app) => {
      const response = await app.inject({
        headers,
        method: 'GET',
        url: '/api/account/owned-projects-with-collaborators',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ projects });
      expect(findCalls).toEqual([actorId]);
    });
  });
});

describe('POST /api/account/delete', () => {
  it('is not registered at all when no accountDeletion store is supplied', async () => {
    const app = await buildApp({ auth });
    try {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { deleteOwnedProjectsWithCollaborators: false },
        url: '/api/account/delete',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('requires an authenticated session', async () => {
    const store = fakeAccountDeletionStore([], { outcome: 'deleted' });
    await withApp(store, async (app) => {
      const response = await app.inject({
        headers: { origin: 'https://app.example.test' },
        method: 'POST',
        payload: { deleteOwnedProjectsWithCollaborators: false },
        url: '/api/account/delete',
      });
      expect(response.statusCode).toBe(401);
      expect(deleteCalls).toEqual([]);
    });
  });

  it('refuses an untrusted origin before the session is ever looked up', async () => {
    const store = fakeAccountDeletionStore([], { outcome: 'deleted' });
    await withApp(store, async (app) => {
      const response = await app.inject({
        headers: { ...headers, origin: 'https://evil.example.test' },
        method: 'POST',
        payload: { deleteOwnedProjectsWithCollaborators: false },
        url: '/api/account/delete',
      });
      expect(response.statusCode).toBe(403);
      expect(deleteCalls).toEqual([]);
    });
  });

  it("acts as the authenticated session's own actor -- the body carries only the flag, never an account id", async () => {
    const store = fakeAccountDeletionStore([], { outcome: 'deleted' });
    await withApp(store, async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { deleteOwnedProjectsWithCollaborators: true },
        url: '/api/account/delete',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ outcome: 'deleted' });
      expect(deleteCalls).toEqual([{ actorId, deleteOwnedProjectsWithCollaborators: true }]);
    });
  });

  it('rejects an unknown field in the body, and rejects a request naming a different account entirely', async () => {
    const store = fakeAccountDeletionStore([], { outcome: 'deleted' });
    await withApp(store, async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { deleteOwnedProjectsWithCollaborators: false, actorId: 'someone-else' },
        url: '/api/account/delete',
      });
      expect(response.statusCode).toBe(400);
      expect(deleteCalls).toEqual([]);
    });
  });

  it('returns 200 with the named projects when the store refuses for having owned projects with collaborators', async () => {
    const projects = [{ id: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f', title: 'Shared screenplay' }];
    const store = fakeAccountDeletionStore([], {
      outcome: 'owned-projects-have-collaborators',
      projects,
    });
    await withApp(store, async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { deleteOwnedProjectsWithCollaborators: false },
        url: '/api/account/delete',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ outcome: 'owned-projects-have-collaborators', projects });
    });
  });

  it('returns 502 when the store reports the Stripe cancellation failed, never a 200', async () => {
    const store = fakeAccountDeletionStore([], { outcome: 'stripe-cancellation-failed' });
    await withApp(store, async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { deleteOwnedProjectsWithCollaborators: false },
        url: '/api/account/delete',
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: 'Could not cancel the subscription. Try again shortly.',
      });
    });
  });
});

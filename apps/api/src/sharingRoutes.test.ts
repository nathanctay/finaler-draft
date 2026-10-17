import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { NO_ACCOUNT_MESSAGE, type SharingScope, type SharingStore } from './sharing.js';

/**
 * Route-level coverage for the screenplay-invitations slice: every path, its status-code mapping,
 * its schema, and -- the part that matters most -- that each route hands the store the **scope its
 * own URL names** and the **authenticated session's own actor id**, never anything from the
 * request body.
 *
 * Follows `revisionRoutes.test.ts`'s shape: a fake store that records what it was called with, and
 * `app.inject` against a real `buildApp`, so the `preValidation` hook, the same-origin guard and
 * the response schemas are all genuinely in the path rather than stubbed out.
 */
const actorId = 'session-actor';
const projectId = '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f';
const screenplayId = 'ecf1118c-3a2e-4656-84e6-fce75c461710';
const invitationId = '6f2b9d7c-1d4e-4a5b-9c8d-3e7f1a2b4c5d';
const headers = { cookie: 'session=test', origin: 'https://app.example.test' };

const auth = {
  baseUrl: 'https://app.example.test',
  handler: async () => new Response(null, { status: 204 }),
  getActorId: async (requestHeaders: Headers) =>
    requestHeaders.get('cookie') === 'session=test' ? actorId : null,
  trustedOrigins: ['https://app.example.test'],
};

let calls: Array<{ method: string; args: unknown[] }>;
let results: Partial<Record<keyof SharingStore, unknown>>;

function record<K extends keyof SharingStore>(method: K) {
  return async (...args: unknown[]) => {
    calls.push({ method, args });
    return results[method] as never;
  };
}

const sharing: SharingStore = {
  listSharing: record('listSharing'),
  invite: record('invite'),
  changeMemberRole: record('changeMemberRole'),
  removeMember: record('removeMember'),
  revokeInvitation: record('revokeInvitation'),
  listInvitationsForUser: record('listInvitationsForUser'),
  respondToInvitation: record('respondToInvitation'),
};

const sharingView = {
  members: [
    {
      userId: 'member-1',
      name: 'Member',
      email: 'member@example.test',
      role: 'editor' as const,
      scope: 'project' as const,
    },
  ],
  invitations: [
    {
      id: invitationId,
      name: 'Invitee',
      email: 'invitee@example.test',
      role: 'reviewer' as const,
      createdAt: '2026-08-06T00:00:00.000Z',
    },
  ],
};

beforeEach(() => {
  calls = [];
  results = {};
});

async function withApp<T>(run: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<T>) {
  const app = await buildApp({ auth, sharing });
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

/** Every route this slice adds, paired with a minimal successful store result -- the table the
 * authentication, origin and scope assertions below all iterate, so a route added later without a
 * corresponding entry here shows up as an uncovered path rather than passing silently. */
const routes = [
  {
    name: 'project sharing view',
    method: 'GET' as const,
    url: `/api/projects/${projectId}/sharing`,
    storeMethod: 'listSharing' as const,
    result: sharingView,
    expectedScope: { kind: 'project', projectId } satisfies SharingScope,
  },
  {
    name: 'screenplay sharing view',
    method: 'GET' as const,
    url: `/api/screenplays/${screenplayId}/sharing`,
    storeMethod: 'listSharing' as const,
    result: sharingView,
    expectedScope: { kind: 'screenplay', screenplayId } satisfies SharingScope,
  },
  {
    name: 'project invite',
    method: 'POST' as const,
    url: `/api/projects/${projectId}/invitations`,
    payload: { email: 'invitee@example.test', role: 'editor' },
    storeMethod: 'invite' as const,
    result: { outcome: 'invited', created: true, invitation: sharingView.invitations[0] },
    expectedScope: { kind: 'project', projectId } satisfies SharingScope,
  },
  {
    name: 'screenplay invite',
    method: 'POST' as const,
    url: `/api/screenplays/${screenplayId}/invitations`,
    payload: { email: 'invitee@example.test', role: 'editor' },
    storeMethod: 'invite' as const,
    result: { outcome: 'invited', created: true, invitation: sharingView.invitations[0] },
    expectedScope: { kind: 'screenplay', screenplayId } satisfies SharingScope,
  },
  {
    name: 'project role change',
    method: 'PATCH' as const,
    url: `/api/projects/${projectId}/members/member-1`,
    payload: { role: 'reviewer' },
    storeMethod: 'changeMemberRole' as const,
    result: { outcome: 'changed', role: 'reviewer' },
    expectedScope: { kind: 'project', projectId } satisfies SharingScope,
  },
  {
    name: 'screenplay role change',
    method: 'PATCH' as const,
    url: `/api/screenplays/${screenplayId}/members/member-1`,
    payload: { role: 'reviewer' },
    storeMethod: 'changeMemberRole' as const,
    result: { outcome: 'changed', role: 'reviewer' },
    expectedScope: { kind: 'screenplay', screenplayId } satisfies SharingScope,
  },
  {
    name: 'project member removal',
    method: 'DELETE' as const,
    url: `/api/projects/${projectId}/members/member-1`,
    storeMethod: 'removeMember' as const,
    result: { outcome: 'removed' },
    expectedScope: { kind: 'project', projectId } satisfies SharingScope,
  },
  {
    name: 'screenplay member removal',
    method: 'DELETE' as const,
    url: `/api/screenplays/${screenplayId}/members/member-1`,
    storeMethod: 'removeMember' as const,
    result: { outcome: 'removed' },
    expectedScope: { kind: 'screenplay', screenplayId } satisfies SharingScope,
  },
  {
    name: 'invitation list',
    method: 'GET' as const,
    url: '/api/invitations',
    storeMethod: 'listInvitationsForUser' as const,
    result: [],
  },
  {
    name: 'invitation response',
    method: 'POST' as const,
    url: `/api/invitations/${invitationId}/respond`,
    payload: { response: 'accept' },
    storeMethod: 'respondToInvitation' as const,
    result: { outcome: 'accepted', projectId, screenplayId: null, role: 'editor' },
  },
  {
    name: 'invitation revocation',
    method: 'DELETE' as const,
    url: `/api/invitations/${invitationId}`,
    storeMethod: 'revokeInvitation' as const,
    result: { outcome: 'revoked' },
  },
];

describe('every sharing route', () => {
  it('is not registered at all when no sharing store is supplied', async () => {
    // The same "absent means the route does not exist, not that it exists and denies" contract
    // every other optional store in `buildApp` has.
    const app = await buildApp({ auth });
    try {
      for (const route of routes) {
        const response = await app.inject({
          headers,
          method: route.method,
          url: route.url,
          ...('payload' in route ? { payload: route.payload } : {}),
        });
        expect(response.statusCode, route.name).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it('requires an authenticated session', async () => {
    await withApp(async (app) => {
      for (const route of routes) {
        results[route.storeMethod] = route.result;
        const response = await app.inject({
          headers: { origin: 'https://app.example.test' },
          method: route.method,
          url: route.url,
          ...('payload' in route ? { payload: route.payload } : {}),
        });
        expect(response.statusCode, route.name).toBe(401);
      }
      // Not one of them reached the store.
      expect(calls).toEqual([]);
    });
  });

  it('refuses an untrusted origin before the session is ever looked up', async () => {
    await withApp(async (app) => {
      for (const route of routes) {
        results[route.storeMethod] = route.result;
        const response = await app.inject({
          headers: { ...headers, origin: 'https://evil.example.test' },
          method: route.method,
          url: route.url,
          ...('payload' in route ? { payload: route.payload } : {}),
        });
        expect(response.statusCode, route.name).toBe(403);
      }
      expect(calls).toEqual([]);
    });
  });

  it('always acts as the authenticated session’s own actor, and on the scope its URL names', async () => {
    // This is the assertion the honest "no account for that address" answer rests on: the invite
    // endpoint is reachable only with a session, and it always acts as that session's actor on a
    // scope the URL names -- there is no body field capable of naming a different actor or a
    // different project.
    await withApp(async (app) => {
      for (const route of routes) {
        calls = [];
        results[route.storeMethod] = route.result;
        const response = await app.inject({
          headers,
          method: route.method,
          url: route.url,
          ...('payload' in route ? { payload: route.payload } : {}),
        });
        expect(response.statusCode, route.name).toBe(200);
        expect(calls, route.name).toHaveLength(1);
        expect(calls[0]!.method, route.name).toBe(route.storeMethod);
        expect(calls[0]!.args[0], route.name).toBe(actorId);
        if ('expectedScope' in route) {
          expect(calls[0]!.args[1], route.name).toEqual(route.expectedScope);
        }
      }
    });
  });
});

describe('the sharing view routes', () => {
  it('returns the store’s view unstripped by the response schema', async () => {
    // `.toEqual`, not `.toMatchObject`: `fastify-type-provider-zod` serializes by re-parsing and
    // silently drops any field the schema does not declare, which for a member list would mean a
    // row with no way to identify who it is.
    results.listSharing = sharingView;
    await withApp(async (app) => {
      const response = await app.inject({
        headers,
        method: 'GET',
        url: `/api/projects/${projectId}/sharing`,
      });
      expect(response.json()).toEqual(sharingView);
    });
  });

  it('maps missing to 404 and forbidden to 403, at both scopes', async () => {
    await withApp(async (app) => {
      for (const url of [
        `/api/projects/${projectId}/sharing`,
        `/api/screenplays/${screenplayId}/sharing`,
      ]) {
        results.listSharing = 'missing';
        expect((await app.inject({ headers, method: 'GET', url })).statusCode).toBe(404);
        results.listSharing = 'forbidden';
        const forbidden = await app.inject({ headers, method: 'GET', url });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json()).toEqual({ error: 'Project editor access required to share' });
      }
    });
  });

  it('rejects a scope id that is not a uuid', async () => {
    await withApp(async (app) => {
      results.listSharing = sharingView;
      expect(
        (await app.inject({ headers, method: 'GET', url: '/api/projects/not-a-uuid/sharing' }))
          .statusCode,
      ).toBe(400);
      expect(calls).toEqual([]);
    });
  });
});

describe('the invite route', () => {
  it('forwards the validated, lowercased body and reports the invitation', async () => {
    results.invite = {
      outcome: 'invited',
      created: false,
      invitation: sharingView.invitations[0],
    };
    await withApp(async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { email: '  Invitee@Example.Test  ', role: 'reviewer' },
        url: `/api/screenplays/${screenplayId}/invitations`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        outcome: 'invited',
        created: false,
        invitation: sharingView.invitations[0],
      });
      expect(calls[0]!.args[2]).toEqual({ email: 'invitee@example.test', role: 'reviewer' });
    });
  });

  it('answers 200 with the server’s own message when the address has no account', async () => {
    // Honest and distinguishable, per the owner's explicit decision -- and a 200 rather than a 4xx
    // because nothing failed: an authorized inviter asked a legitimate question and got an answer.
    results.invite = { outcome: 'no-account' };
    await withApp(async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { email: 'nobody@example.test', role: 'editor' },
        url: `/api/projects/${projectId}/invitations`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ outcome: 'no-account', message: NO_ACCOUNT_MESSAGE });
    });
  });

  it('answers 200 for the other two non-invitation outcomes', async () => {
    await withApp(async (app) => {
      results.invite = { outcome: 'self' };
      const self = await app.inject({
        headers,
        method: 'POST',
        payload: { email: 'me@example.test', role: 'editor' },
        url: `/api/projects/${projectId}/invitations`,
      });
      expect(self.statusCode).toBe(200);
      expect(self.json()).toEqual({ outcome: 'self' });

      results.invite = { outcome: 'already-member', role: 'owner', scope: 'project' };
      const member = await app.inject({
        headers,
        method: 'POST',
        payload: { email: 'owner@example.test', role: 'editor' },
        url: `/api/screenplays/${screenplayId}/invitations`,
      });
      expect(member.statusCode).toBe(200);
      expect(member.json()).toEqual({
        outcome: 'already-member',
        role: 'owner',
        scope: 'project',
      });
    });
  });

  it('maps missing to 404 and forbidden to 403', async () => {
    await withApp(async (app) => {
      results.invite = 'missing';
      expect(
        (
          await app.inject({
            headers,
            method: 'POST',
            payload: { email: 'a@b.test', role: 'editor' },
            url: `/api/projects/${projectId}/invitations`,
          })
        ).statusCode,
      ).toBe(404);
      results.invite = 'forbidden';
      expect(
        (
          await app.inject({
            headers,
            method: 'POST',
            payload: { email: 'a@b.test', role: 'editor' },
            url: `/api/projects/${projectId}/invitations`,
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  it('rejects a role sharing cannot grant, an invalid address, and an unknown field', async () => {
    await withApp(async (app) => {
      for (const payload of [
        { email: 'a@b.test', role: 'owner' },
        { email: 'not-an-address', role: 'editor' },
        { email: 'a@b.test', role: 'editor', userId: 'someone-else' },
        { role: 'editor' },
      ]) {
        const response = await app.inject({
          headers,
          method: 'POST',
          payload,
          url: `/api/projects/${projectId}/invitations`,
        });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(calls).toEqual([]);
    });
  });
});

describe('the member routes', () => {
  it('forwards the member id from the URL and the role from the body', async () => {
    results.changeMemberRole = { outcome: 'changed', role: 'reviewer' };
    await withApp(async (app) => {
      await app.inject({
        headers,
        method: 'PATCH',
        payload: { role: 'reviewer' },
        url: `/api/screenplays/${screenplayId}/members/member-1`,
      });
      expect(calls[0]!.args.slice(2)).toEqual(['member-1', 'reviewer']);
    });
  });

  it('decodes a member id that needed escaping in the URL', async () => {
    // Better Auth user ids are opaque strings, not UUIDs, so this route must survive one
    // containing a character the path would otherwise eat.
    results.removeMember = { outcome: 'removed' };
    await withApp(async (app) => {
      await app.inject({
        headers,
        method: 'DELETE',
        url: `/api/projects/${projectId}/members/${encodeURIComponent('a/b c')}`,
      });
      expect(calls[0]!.args[2]).toBe('a/b c');
    });
  });

  it('reports not-a-member and owner-immutable as 200 outcomes, not failures', async () => {
    // Both are the server answering a legitimate request from an authorized manager -- "that
    // person is not here" and "the owner is not yours to change" -- so the dialog can say which
    // one happened rather than parsing prose out of a shared 4xx.
    await withApp(async (app) => {
      for (const outcome of ['not-a-member', 'owner-immutable'] as const) {
        results.changeMemberRole = { outcome };
        const response = await app.inject({
          headers,
          method: 'PATCH',
          payload: { role: 'reviewer' },
          url: `/api/projects/${projectId}/members/member-1`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ outcome });
      }
    });
  });

  it('maps missing to 404 and forbidden to 403 for both the change and the removal', async () => {
    await withApp(async (app) => {
      for (const [method, storeMethod] of [
        ['PATCH', 'changeMemberRole'],
        ['DELETE', 'removeMember'],
      ] as const) {
        results[storeMethod] = 'missing';
        expect(
          (
            await app.inject({
              headers,
              method,
              url: `/api/projects/${projectId}/members/member-1`,
              ...(method === 'PATCH' ? { payload: { role: 'reviewer' } } : {}),
            })
          ).statusCode,
        ).toBe(404);
        results[storeMethod] = 'forbidden';
        expect(
          (
            await app.inject({
              headers,
              method,
              url: `/api/projects/${projectId}/members/member-1`,
              ...(method === 'PATCH' ? { payload: { role: 'reviewer' } } : {}),
            })
          ).statusCode,
        ).toBe(403);
      }
    });
  });

  it('rejects a role change to owner', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        headers,
        method: 'PATCH',
        payload: { role: 'owner' },
        url: `/api/projects/${projectId}/members/member-1`,
      });
      expect(response.statusCode).toBe(400);
      expect(calls).toEqual([]);
    });
  });
});

describe('the invitee-side routes', () => {
  it('lists the actor’s own invitations, unstripped', async () => {
    const invitation = {
      id: invitationId,
      role: 'editor' as const,
      createdAt: '2026-08-06T00:00:00.000Z',
      projectId,
      projectTitle: 'Night Shoot',
      screenplayId,
      screenplayTitle: 'Act One',
      invitedByName: 'The Inviter',
    };
    results.listInvitationsForUser = [invitation];
    await withApp(async (app) => {
      const response = await app.inject({ headers, method: 'GET', url: '/api/invitations' });
      expect(response.json()).toEqual([invitation]);
      expect(calls[0]!.args).toEqual([actorId]);
    });
  });

  it('accepts and declines, and reports an already-answered invitation as an outcome', async () => {
    await withApp(async (app) => {
      results.respondToInvitation = {
        outcome: 'accepted',
        projectId,
        screenplayId,
        role: 'editor',
      };
      const accepted = await app.inject({
        headers,
        method: 'POST',
        payload: { response: 'accept' },
        url: `/api/invitations/${invitationId}/respond`,
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({
        outcome: 'accepted',
        projectId,
        screenplayId,
        role: 'editor',
      });

      results.respondToInvitation = { outcome: 'declined' };
      expect(
        (
          await app.inject({
            headers,
            method: 'POST',
            payload: { response: 'decline' },
            url: `/api/invitations/${invitationId}/respond`,
          })
        ).json(),
      ).toEqual({ outcome: 'declined' });

      results.respondToInvitation = { outcome: 'not-pending' };
      const replayed = await app.inject({
        headers,
        method: 'POST',
        payload: { response: 'accept' },
        url: `/api/invitations/${invitationId}/respond`,
      });
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json()).toEqual({ outcome: 'not-pending' });
    });
  });

  it('answers 404 -- never 403 -- for an invitation that is not the actor’s', async () => {
    // Answering 403 would confirm that the id names a real invitation belonging to someone else.
    results.respondToInvitation = 'missing';
    await withApp(async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { response: 'accept' },
        url: `/api/invitations/${invitationId}/respond`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Invitation not found' });
    });
  });

  it('rejects an unknown response value and a non-uuid invitation id', async () => {
    await withApp(async (app) => {
      expect(
        (
          await app.inject({
            headers,
            method: 'POST',
            payload: { response: 'maybe' },
            url: `/api/invitations/${invitationId}/respond`,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            headers,
            method: 'POST',
            payload: { response: 'accept' },
            url: '/api/invitations/not-a-uuid/respond',
          })
        ).statusCode,
      ).toBe(400);
      expect(calls).toEqual([]);
    });
  });

  it('revokes, and maps missing to 404 and forbidden to 403', async () => {
    await withApp(async (app) => {
      results.revokeInvitation = { outcome: 'revoked' };
      const revoked = await app.inject({
        headers,
        method: 'DELETE',
        url: `/api/invitations/${invitationId}`,
      });
      expect(revoked.json()).toEqual({ outcome: 'revoked' });
      expect(calls[0]!.args).toEqual([actorId, invitationId]);

      results.revokeInvitation = 'missing';
      expect(
        (await app.inject({ headers, method: 'DELETE', url: `/api/invitations/${invitationId}` }))
          .statusCode,
      ).toBe(404);
      results.revokeInvitation = 'forbidden';
      expect(
        (await app.inject({ headers, method: 'DELETE', url: `/api/invitations/${invitationId}` }))
          .statusCode,
      ).toBe(403);
    });
  });
});

describe('the shared-screenplays route', () => {
  it('lists the actor’s screenplay-scoped screenplays, unstripped', async () => {
    const shared = {
      id: screenplayId,
      title: 'Act One',
      updatedAt: '2026-08-06T00:00:00.000Z',
      projectId,
      projectTitle: 'Night Shoot',
      role: 'editor' as const,
    };
    const projects = {
      listProjects: async () => [],
      listSharedScreenplays: vi.fn(async () => [shared]),
      createProject: async () => ({ id: projectId, title: 'x' }),
      renameProject: async () => 'missing' as const,
      deleteProject: async () => 'missing' as const,
      restoreProject: async () => 'missing' as const,
      listScreenplays: async () => [],
      createScreenplay: async () => ({ id: screenplayId }),
      getScreenplay: async () => 'missing' as const,
      renameScreenplay: async () => 'missing' as const,
      deleteScreenplay: async () => 'missing' as const,
      restoreScreenplay: async () => 'missing' as const,
      listDeleted: async () => ({ projects: [], screenplays: [] }),
    };
    const app = await buildApp({ auth, projects });
    try {
      const response = await app.inject({
        headers,
        method: 'GET',
        url: '/api/shared-screenplays',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([shared]);
      expect(projects.listSharedScreenplays).toHaveBeenCalledWith(actorId);
    } finally {
      await app.close();
    }
  });

  it('requires an authenticated session on a trusted origin', async () => {
    // Its prefix is not `/api/projects`, so it had to be added to the `preValidation` hook's own
    // list explicitly -- this is the test that would fail if it were ever dropped from it.
    const projects = {
      listProjects: async () => [],
      listSharedScreenplays: async () => [],
      createProject: async () => ({ id: projectId, title: 'x' }),
      renameProject: async () => 'missing' as const,
      deleteProject: async () => 'missing' as const,
      restoreProject: async () => 'missing' as const,
      listScreenplays: async () => [],
      createScreenplay: async () => ({ id: screenplayId }),
      getScreenplay: async () => 'missing' as const,
      renameScreenplay: async () => 'missing' as const,
      deleteScreenplay: async () => 'missing' as const,
      restoreScreenplay: async () => 'missing' as const,
      listDeleted: async () => ({ projects: [], screenplays: [] }),
    };
    const app = await buildApp({ auth, projects });
    try {
      expect(
        (
          await app.inject({
            headers: { origin: 'https://app.example.test' },
            method: 'GET',
            url: '/api/shared-screenplays',
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('the rate limit the invite route sits behind', () => {
  /**
   * The owner's decision to answer honestly that an address has no account rests on three things
   * being true at once, and this is the third. The other two are asserted above -- the route
   * requires an authenticated session (`requires an authenticated session`) and acts only as that
   * session's own actor on a scope its URL names (`always acts as the authenticated session's own
   * actor`) -- and `sharing.test.ts` asserts the fourth, that the store additionally requires
   * owner-or-editor membership on the project.
   *
   * This one asserts the route is *not* on an exempted path: `@fastify/rate-limit`'s `allowList`
   * in `buildApp` exempts everything that does **not** start with `/api`, so every sharing route
   * is capped. Without that, an account could probe addresses without limit and the honest answer
   * would become an enumeration oracle.
   */
  it('is capped like every other /api route, with no exemption for the invitations path', async () => {
    const cappedApp = await buildApp({
      auth,
      sharing,
      rateLimit: { max: 2, timeWindowMs: 60_000 },
    });
    try {
      results.invite = { outcome: 'no-account' };
      const url = `/api/projects/${projectId}/invitations`;
      const payload = { email: 'nobody@example.test', role: 'editor' };
      expect((await cappedApp.inject({ headers, method: 'POST', payload, url })).statusCode).toBe(
        200,
      );
      expect((await cappedApp.inject({ headers, method: 'POST', payload, url })).statusCode).toBe(
        200,
      );
      const third = await cappedApp.inject({ headers, method: 'POST', payload, url });
      expect(third.statusCode).toBe(429);
      expect(third.json()).toEqual({ error: 'Too many requests' });
    } finally {
      await cappedApp.close();
    }
  });

  it('applies the real production default when no override is supplied', async () => {
    // Read from `@finaler-draft/server-config` rather than restated, so this fails if the shipped
    // cap the paragraph above depends on ever drifts.
    const { DEFAULT_API_RATE_LIMIT_MAX, DEFAULT_API_RATE_LIMIT_WINDOW_MS } = await import(
      '@finaler-draft/server-config'
    );
    expect(DEFAULT_API_RATE_LIMIT_MAX).toBe(300);
    expect(DEFAULT_API_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    results.invite = { outcome: 'no-account' };
    await withApp(async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { email: 'nobody@example.test', role: 'editor' },
        url: `/api/projects/${projectId}/invitations`,
      });
      // The limiter is registered and counting on this route: it reports the remaining budget out
      // of the real default rather than leaving the headers off entirely.
      expect(response.headers['x-ratelimit-limit']).toBe(String(DEFAULT_API_RATE_LIMIT_MAX));
    });
  });
});

describe('cache headers', () => {
  it('marks every sharing response private and no-store, like the rest of /api/', async () => {
    // These bodies carry collaborator names and email addresses, so the existing blanket
    // `/api/`-prefixed rule has to cover them -- asserted rather than assumed.
    results.listSharing = sharingView;
    results.listInvitationsForUser = [];
    await withApp(async (app) => {
      for (const url of [`/api/projects/${projectId}/sharing`, '/api/invitations']) {
        const response = await app.inject({ headers, method: 'GET', url });
        expect(response.headers['cache-control']).toBe('private, no-store');
      }
    });
  });
});

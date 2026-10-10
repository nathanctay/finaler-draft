import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { RevisionStore } from './revisions.js';
import type { RestoreResult, RestoreStore } from './restore.js';

const screenplayId = 'ecf1118c-3a2e-4656-84e6-fce75c461710';
const revisionId = '11111111-1111-4111-8111-111111111111';

const auth = {
  baseUrl: 'https://app.example.test',
  handler: async () => new Response('auth'),
  getActorId: async (headers: Headers) =>
    headers.get('cookie') === 'session=test' ? 'actor-1' : null,
  trustedOrigins: ['https://app.example.test'],
};

const revisionListItem = {
  id: revisionId,
  kind: 'named' as const,
  label: 'Draft 2',
  authoredBy: 'actor-1',
  createdAt: '2026-08-06T00:00:00.000Z',
  previewMetadata: { sceneCount: 3, blockCount: 40 },
};

const fixtureScreenplay = {
  schemaVersion: 1 as const,
  id: screenplayId,
  title: 'Fixture',
  documentSettings: {
    characterIndentIn: 3.7,
    parentheticalIndentIn: 3.1,
    parentheticalWidthIn: 2,
    pageNumberStyle: 'arabic' as const,
    sceneNumbersEnabled: false,
    autoMoreContinued: true,
  },
  titlePages: [],
  annotations: [],
  blocks: [],
};

const defaultGetResult: Awaited<ReturnType<RevisionStore['getRevision']>> = {
  ...revisionListItem,
  screenplayId,
  screenplay: fixtureScreenplay,
};
const defaultCreateResult: Awaited<ReturnType<RevisionStore['createRevision']>> = {
  ...revisionListItem,
  created: true,
};
const defaultDiffResult: Awaited<ReturnType<RevisionStore['getRevisionDiff']>> = {
  screenplayId,
  older: {
    id: revisionId,
    kind: 'named',
    label: 'Draft 2',
    createdAt: '2026-08-06T00:00:00.000Z',
  },
  newer: { id: 'current', kind: null, label: null, createdAt: null },
  diff: {
    titleChanged: false,
    titleBefore: 'Fixture',
    titleAfter: 'Fixture',
    documentSettingsChanges: [],
    titlePages: [],
    blocks: [],
    scenes: [],
    isEmpty: true,
  },
  // The two whole canonical projections the diff was computed from. The inline diff view renders the
  // document itself out of them -- see `RevisionDiffResult`'s own comment in `revisions.ts` -- so the
  // route's response schema carries them and a response without them is a 500, which is what makes
  // this fixture's presence here load-bearing rather than decorative.
  olderScreenplay: fixtureScreenplay,
  newerScreenplay: fixtureScreenplay,
};

let listResult: Awaited<ReturnType<RevisionStore['listRevisions']>> = [revisionListItem];
let getResult: Awaited<ReturnType<RevisionStore['getRevision']>> = defaultGetResult;
let createResult: Awaited<ReturnType<RevisionStore['createRevision']>> = defaultCreateResult;
let diffResult: Awaited<ReturnType<RevisionStore['getRevisionDiff']>> = defaultDiffResult;
let lastDiffArgs:
  | { screenplayId: string; revisionId: string; against: string | undefined }
  | undefined;

const store: RevisionStore = {
  listRevisions: async () => listResult,
  getRevision: async () => getResult,
  createRevision: async () => createResult,
  getRevisionDiff: async (_actorId, screenplayIdArg, revisionIdArg, against) => {
    lastDiffArgs = { screenplayId: screenplayIdArg, revisionId: revisionIdArg, against };
    return diffResult;
  },
};

describe('revision routes', () => {
  afterEach(() => {
    listResult = [revisionListItem];
    getResult = defaultGetResult;
    createResult = defaultCreateResult;
    diffResult = defaultDiffResult;
    lastDiffArgs = undefined;
  });

  it('rejects every revision route for an unauthenticated request', async () => {
    const app = await buildApp({ auth, revisions: store });
    try {
      expect(
        (await app.inject({ method: 'GET', url: `/api/screenplays/${screenplayId}/revisions` }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/screenplays/${screenplayId}/revisions/${revisionId}`,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/screenplays/${screenplayId}/revisions`,
            // A same-origin request with no session -- isolates the auth check specifically; a
            // request with no `origin` header at all is rejected first by the cross-origin guard
            // (403), not this one, per that hook's own documented ordering.
            headers: { origin: 'https://app.example.test' },
            payload: { epoch: 0, kind: 'named', label: 'Draft 2' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/screenplays/${screenplayId}/revisions/${revisionId}/diff`,
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('lists revisions for an authenticated member, with response fields unstripped by the schema', async () => {
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/screenplays/${screenplayId}/revisions`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([revisionListItem]);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the store reports the screenplay is not visible to this actor', async () => {
    listResult = 'missing';
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/screenplays/${screenplayId}/revisions`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns one revision's own canonical screenplay for historical preview", async () => {
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/screenplays/${screenplayId}/revisions/${revisionId}`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(revisionId);
      expect(body.screenplayId).toBe(screenplayId);
      expect(body.screenplay.id).toBe(screenplayId);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for a revision id the store cannot resolve', async () => {
    getResult = 'missing';
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/screenplays/${screenplayId}/revisions/${revisionId}`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('creates a named revision and reports whether it was newly created', async () => {
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/screenplays/${screenplayId}/revisions`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
        payload: { epoch: 0, kind: 'named', label: 'Draft 2' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ...revisionListItem, created: true });
    } finally {
      await app.close();
    }
  });

  it('creates an export revision', async () => {
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/screenplays/${screenplayId}/revisions`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
        payload: { epoch: 0, format: 'pdf', kind: 'export' },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('returns 403 when the store reports the actor may not name a milestone', async () => {
    createResult = 'forbidden';
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/screenplays/${screenplayId}/revisions`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
        payload: { epoch: 0, kind: 'named', label: 'Draft 2' },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the screenplay is gone', async () => {
    createResult = 'missing';
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/screenplays/${screenplayId}/revisions`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
        payload: { epoch: 0, kind: 'named', label: 'Draft 2' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed body (neither a valid named nor export shape) with 400, before ever calling the store', async () => {
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/screenplays/${screenplayId}/revisions`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
        payload: { epoch: 0, kind: 'named', label: '' },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns a diff against the current document by default, with no `against` query param forwarded to the store', async () => {
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/screenplays/${screenplayId}/revisions/${revisionId}/diff`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(defaultDiffResult);
      expect(lastDiffArgs).toEqual({ screenplayId, revisionId, against: undefined });
    } finally {
      await app.close();
    }
  });

  it('forwards an `against` revision id to the store, for revision-to-revision comparison', async () => {
    const otherRevisionId = '22222222-2222-4222-8222-222222222222';
    diffResult = {
      ...defaultDiffResult,
      newer: {
        id: otherRevisionId,
        kind: 'named',
        label: 'Draft 3',
        createdAt: '2026-08-07T00:00:00.000Z',
      },
    };
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/screenplays/${screenplayId}/revisions/${revisionId}/diff?against=${otherRevisionId}`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().newer.id).toBe(otherRevisionId);
      expect(lastDiffArgs).toEqual({ screenplayId, revisionId, against: otherRevisionId });
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed `against` query value with 400, before ever calling the store', async () => {
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/screenplays/${screenplayId}/revisions/${revisionId}/diff?against=not-a-uuid`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      });
      expect(response.statusCode).toBe(400);
      expect(lastDiffArgs).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('returns 404 for a diff the store cannot resolve (either side missing)', async () => {
    diffResult = 'missing';
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/screenplays/${screenplayId}/revisions/${revisionId}/diff`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('registers no revision routes at all when the revisions port is not supplied', async () => {
    const app = await buildApp({ auth });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/screenplays/${screenplayId}/revisions`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      });
      expect(response.statusCode).toBe(404);
      const diffResponse = await app.inject({
        method: 'GET',
        url: `/api/screenplays/${screenplayId}/revisions/${revisionId}/diff`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      });
      expect(diffResponse.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

/**
 * Collaboration slice 5's one write route, `POST /api/screenplays/:id/revisions/:revisionId/restore`.
 * Every refusal the store can resolve maps to a distinct status, and each carries a specific
 * explanation the confirmation dialog shows verbatim (`apps/web/src/api.ts`'s `restoreRevision` uses
 * `jsonWithServerMessage`) -- so these assertions are about the message as much as the code: a
 * writer told "something went wrong" after confirming a restore has no way to know whether their
 * screenplay changed.
 */
describe('restore-as-current route', () => {
  const restoreSuccess = {
    epoch: 1,
    previousEpoch: 0,
    restoreRevisionId: '33333333-3333-4333-8333-333333333333',
    canonicalHash: 'c'.repeat(64),
    previousHeadRevisionId: '44444444-4444-4444-8444-444444444444',
    created: true,
  };
  const body = { expectedEpoch: 0, restoreRequestId: '55555555-5555-4555-8555-555555555555' };

  let restoreResult: RestoreResult = restoreSuccess;
  let restoreCalls: Array<{
    actorId: string;
    screenplayId: string;
    revisionId: string;
    input: unknown;
  }> = [];
  const restore: RestoreStore = {
    restoreRevision: async (actorId, screenplayIdArg, revisionIdArg, input) => {
      restoreCalls.push({
        actorId,
        screenplayId: screenplayIdArg,
        revisionId: revisionIdArg,
        input,
      });
      return restoreResult;
    },
  };

  afterEach(() => {
    restoreResult = restoreSuccess;
    restoreCalls = [];
  });

  const post = (app: Awaited<ReturnType<typeof buildApp>>, payload: unknown = body) =>
    app.inject({
      method: 'POST',
      url: `/api/screenplays/${screenplayId}/revisions/${revisionId}/restore`,
      headers: { cookie: 'session=test', origin: 'https://app.example.test' },
      payload: payload as Record<string, unknown>,
    });

  it('restores for an authenticated editor, forwarding the actor, both ids, and the confirmed epoch and request id', async () => {
    const app = await buildApp({ auth, restore, revisions: store });
    try {
      const response = await post(app);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(restoreSuccess);
      expect(restoreCalls).toEqual([{ actorId: 'actor-1', screenplayId, revisionId, input: body }]);
    } finally {
      await app.close();
    }
  });

  it('returns the replay of an already-committed restore as a 200 with created: false, never an error', async () => {
    restoreResult = { ...restoreSuccess, created: false };
    const app = await buildApp({ auth, restore, revisions: store });
    try {
      const response = await post(app);
      expect(response.statusCode).toBe(200);
      expect(response.json().created).toBe(false);
      expect(response.json().epoch).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('rejects an unauthenticated request without reaching the store', async () => {
    const app = await buildApp({ auth, restore, revisions: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/screenplays/${screenplayId}/revisions/${revisionId}/restore`,
        headers: { origin: 'https://app.example.test' },
        payload: body,
      });
      expect(response.statusCode).toBe(401);
      expect(restoreCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['missing', 404, 'Revision not found'],
    ['forbidden', 403, 'Screenplay editor access required'],
    // 402, not 403, for the identical reason the free-tier screenplay limit answers 402: the account
    // has rights here, just not on its current tier, so the client shows an upgrade path.
    ['entitlement-required', 402, 'Make it your editable screenplay, or upgrade.'],
    ['unreadable-revision', 422, 'cannot be opened in the editor and was not restored'],
    ['stale-epoch', 409, 'already moved on to a newer version'],
    ['request-id-conflict', 409, 'belongs to another screenplay'],
  ])("maps the store's %s to %i, explaining what happened", async (outcome, status, message) => {
    restoreResult = outcome as RestoreResult;
    const app = await buildApp({ auth, restore, revisions: store });
    try {
      const response = await post(app);
      expect(response.statusCode).toBe(status);
      expect(response.json().error).toContain(message);
    } finally {
      await app.close();
    }
  });

  /**
   * The body is the evidence of *which document state* was confirmed. A request that omits either
   * field is refused at the schema, before the store is reached -- there is no path to a cutover
   * carrying no evidence at all.
   */
  it.each([
    ['an empty body', {}],
    ['no epoch', { restoreRequestId: body.restoreRequestId }],
    ['no request id', { expectedEpoch: 0 }],
    ['a non-uuid request id', { expectedEpoch: 0, restoreRequestId: 'nope' }],
    ['a negative epoch', { expectedEpoch: -1, restoreRequestId: body.restoreRequestId }],
    ['an unexpected extra field', { ...body, force: true }],
  ])('refuses %s with 400, without reaching the store', async (_label, payload) => {
    const app = await buildApp({ auth, restore, revisions: store });
    try {
      expect((await post(app, payload)).statusCode).toBe(400);
      expect(restoreCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('refuses a malformed revision id in the path with 400, without reaching the store', async () => {
    const app = await buildApp({ auth, restore, revisions: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/screenplays/${screenplayId}/revisions/not-a-uuid/restore`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(restoreCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('is not registered at all when the restore port is not supplied, even though the other revision routes are', async () => {
    const app = await buildApp({ auth, revisions: store });
    try {
      expect((await post(app)).statusCode).toBe(404);
      // The revision routes themselves are still there -- the two ports are independent.
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/screenplays/${screenplayId}/revisions`,
            headers: { cookie: 'session=test', origin: 'https://app.example.test' },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});

/**
 * Collaboration slice 5's stale-epoch rejection on the *other* HTTP write path. A named milestone
 * records "this moment"; a writer whose epoch has been retired by a restore is labelling content
 * they never saw, which is precisely the silent mislabelling an audit trail must not contain.
 */
describe('named/export revision creation and the epoch', () => {
  afterEach(() => {
    createResult = defaultCreateResult;
  });

  it('answers 409 with a reload instruction when the store reports a stale epoch', async () => {
    createResult = 'stale-epoch';
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/screenplays/${screenplayId}/revisions`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
        payload: { epoch: 0, kind: 'named', label: 'Draft 2' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('restored to an earlier revision');
    } finally {
      await app.close();
    }
  });

  /**
   * `epoch` is required, not optional, and this is the assertion that keeps it so: an optional field
   * would let exactly the client this gate exists to refuse omit it and be accepted.
   */
  it.each([
    ['a named revision with no epoch', { kind: 'named', label: 'Draft 2' }],
    ['an export revision with no epoch', { kind: 'export', format: 'pdf' }],
  ])('refuses %s with 400', async (_label, payload) => {
    const app = await buildApp({ auth, revisions: store });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/screenplays/${screenplayId}/revisions`,
        headers: { cookie: 'session=test', origin: 'https://app.example.test' },
        payload,
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { RevisionStore } from './revisions.js';

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
            payload: { kind: 'named', label: 'Draft 2' },
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
        payload: { kind: 'named', label: 'Draft 2' },
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
        payload: { kind: 'export', format: 'pdf' },
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
        payload: { kind: 'named', label: 'Draft 2' },
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
        payload: { kind: 'named', label: 'Draft 2' },
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
        payload: { kind: 'named', label: '' },
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

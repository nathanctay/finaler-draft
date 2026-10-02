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

const defaultGetResult: Awaited<ReturnType<RevisionStore['getRevision']>> = {
  ...revisionListItem,
  screenplayId,
  screenplay: {
    schemaVersion: 1,
    id: screenplayId,
    title: 'Fixture',
    documentSettings: {
      characterIndentIn: 3.7,
      parentheticalIndentIn: 3.1,
      parentheticalWidthIn: 2,
      pageNumberStyle: 'arabic',
      sceneNumbersEnabled: false,
      autoMoreContinued: true,
    },
    titlePages: [],
    annotations: [],
    blocks: [],
  },
};
const defaultCreateResult: Awaited<ReturnType<RevisionStore['createRevision']>> = {
  ...revisionListItem,
  created: true,
};

let listResult: Awaited<ReturnType<RevisionStore['listRevisions']>> = [revisionListItem];
let getResult: Awaited<ReturnType<RevisionStore['getRevision']>> = defaultGetResult;
let createResult: Awaited<ReturnType<RevisionStore['createRevision']>> = defaultCreateResult;

const store: RevisionStore = {
  listRevisions: async () => listResult,
  getRevision: async () => getResult,
  createRevision: async () => createResult,
};

describe('revision routes', () => {
  afterEach(() => {
    listResult = [revisionListItem];
    getResult = defaultGetResult;
    createResult = defaultCreateResult;
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

  it('registers no revision routes at all when the revisions port is not supplied', async () => {
    const app = await buildApp({ auth });
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
});

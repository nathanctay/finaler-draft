import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import {
  FEEDBACK_SUBMISSIONS_PER_HOUR,
  type FeedbackStore,
  type SubmitFeedbackInput,
} from './feedback.js';

/**
 * Route-level coverage for `POST /api/feedback`: that it is absent entirely without a feedback
 * store, that it carries the same authenticated-actor and same-origin requirements every other
 * route here does, that it hands the store the authenticated session's own actor id (never
 * anything a caller could put in the body), that the zod schema actually rejects what the owner's
 * brief says it must, and that the per-user rate limit is real. Follows `sharingRoutes.test.ts`'s
 * shape: a fake store that records what it was called with, and `app.inject` against a real
 * `buildApp`, so the `preValidation` hook, the same-origin guard, the schema, and the route-level
 * rate-limit configuration are all genuinely in the path rather than stubbed out.
 *
 * `feedbackNoReadPath.test.ts` is the companion file for the one property that matters most about
 * this route group: that there is, and never will quietly become, a second one that reads it back.
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

const validPayload: { body: string; context: SubmitFeedbackInput['context'] } = {
  body: 'The scene heading menu closes before I can pick an option.',
  context: { route: '/screenplays/abc/editor', appVersion: '1.4.0' },
};

let calls: Array<{ userId: string; input: SubmitFeedbackInput }>;

function fakeFeedbackStore(): FeedbackStore {
  return {
    submitFeedback: vi.fn(async (userId: string, input: SubmitFeedbackInput) => {
      calls.push({ userId, input });
      return { id: '6f2b9d7c-1d4e-4a5b-9c8d-3e7f1a2b4c5d', createdAt: '2026-08-06T00:00:00.000Z' };
    }),
  };
}

beforeEach(() => {
  calls = [];
});

async function withApp<T>(
  feedback: FeedbackStore,
  run: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<T>,
) {
  const app = await buildApp({ auth, feedback });
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

describe('POST /api/feedback', () => {
  it('is not registered at all when no feedback store is supplied', async () => {
    const app = await buildApp({ auth });
    try {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: validPayload,
        url: '/api/feedback',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('requires an authenticated session', async () => {
    await withApp(fakeFeedbackStore(), async (app) => {
      const response = await app.inject({
        headers: { origin: 'https://app.example.test' },
        method: 'POST',
        payload: validPayload,
        url: '/api/feedback',
      });
      expect(response.statusCode).toBe(401);
      expect(calls).toEqual([]);
    });
  });

  it('refuses an untrusted origin before the session is ever looked up', async () => {
    await withApp(fakeFeedbackStore(), async (app) => {
      const response = await app.inject({
        headers: { ...headers, origin: 'https://evil.example.test' },
        method: 'POST',
        payload: validPayload,
        url: '/api/feedback',
      });
      expect(response.statusCode).toBe(403);
      expect(calls).toEqual([]);
    });
  });

  it("acts as the authenticated session's own actor -- there is no field in the body capable of naming anyone else", async () => {
    await withApp(fakeFeedbackStore(), async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: validPayload,
        url: '/api/feedback',
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        id: '6f2b9d7c-1d4e-4a5b-9c8d-3e7f1a2b4c5d',
        createdAt: '2026-08-06T00:00:00.000Z',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.userId).toBe(actorId);
      expect(calls[0]!.input).toEqual(validPayload);
    });
  });

  it('rejects a body over the length cap', async () => {
    await withApp(fakeFeedbackStore(), async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { ...validPayload, body: 'x'.repeat(4001) },
        url: '/api/feedback',
      });
      expect(response.statusCode).toBe(400);
      expect(calls).toEqual([]);
    });
  });

  it('rejects an unknown top-level field -- the no-manuscript-smuggling guard', async () => {
    await withApp(fakeFeedbackStore(), async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { ...validPayload, canonicalScreenplay: { scenes: [] } },
        url: '/api/feedback',
      });
      expect(response.statusCode).toBe(400);
      expect(calls).toEqual([]);
    });
  });

  it('rejects an unknown field inside the context bundle', async () => {
    await withApp(fakeFeedbackStore(), async (app) => {
      const response = await app.inject({
        headers,
        method: 'POST',
        payload: { ...validPayload, context: { ...validPayload.context, screenplayText: 'INT.' } },
        url: '/api/feedback',
      });
      expect(response.statusCode).toBe(400);
      expect(calls).toEqual([]);
    });
  });

  it(`allows exactly ${FEEDBACK_SUBMISSIONS_PER_HOUR} submissions per hour for one writer, then rate-limits the next`, async () => {
    await withApp(fakeFeedbackStore(), async (app) => {
      for (let i = 0; i < FEEDBACK_SUBMISSIONS_PER_HOUR; i += 1) {
        const response = await app.inject({
          headers,
          method: 'POST',
          payload: validPayload,
          url: '/api/feedback',
        });
        expect(response.statusCode, `submission ${i + 1}`).toBe(201);
      }
      const limited = await app.inject({
        headers,
        method: 'POST',
        payload: validPayload,
        url: '/api/feedback',
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({ error: 'Too many requests' });
      expect(calls).toHaveLength(FEEDBACK_SUBMISSIONS_PER_HOUR);
    });
  });

  it('keys the rate limit per writer, not per IP -- a second actor on the identical connection is unaffected', async () => {
    const secondActorId = 'session-actor-two';
    const multiActorAuth = {
      ...auth,
      getActorId: async (requestHeaders: Headers) => {
        const cookie = requestHeaders.get('cookie');
        if (cookie === 'session=test') return actorId;
        if (cookie === 'session=test-2') return secondActorId;
        return null;
      },
    };
    const feedback = fakeFeedbackStore();
    const app = await buildApp({ auth: multiActorAuth, feedback });
    try {
      for (let i = 0; i < FEEDBACK_SUBMISSIONS_PER_HOUR; i += 1) {
        const response = await app.inject({
          headers,
          method: 'POST',
          payload: validPayload,
          url: '/api/feedback',
        });
        expect(response.statusCode, `first actor submission ${i + 1}`).toBe(201);
      }
      const firstActorLimited = await app.inject({
        headers,
        method: 'POST',
        payload: validPayload,
        url: '/api/feedback',
      });
      expect(firstActorLimited.statusCode).toBe(429);

      const secondActorResponse = await app.inject({
        headers: { cookie: 'session=test-2', origin: 'https://app.example.test' },
        method: 'POST',
        payload: validPayload,
        url: '/api/feedback',
      });
      expect(secondActorResponse.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});

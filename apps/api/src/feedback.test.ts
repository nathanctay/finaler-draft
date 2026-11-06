import { describe, expect, it, vi } from 'vitest';
import {
  createPostgresFeedbackStore,
  feedbackContextInput,
  FEEDBACK_BODY_MAX_LENGTH,
  submitFeedbackInput,
  type FeedbackNotification,
  type FeedbackNotifier,
} from './feedback.js';

/**
 * Covers `feedback.ts`'s own orchestration against a fake pool: the input schema's bounds and its
 * `.strict()` closure against unknown fields, the insert, and -- the part that matters most -- that
 * a notifier failure never fails `submitFeedback` and that nothing sensitive ever reaches a log
 * line. `feedbackMail.test.ts` covers the notifier itself; `feedbackRoutes.test.ts` covers the HTTP
 * route this store sits behind; `feedback.integration.test.ts` proves the SQL is real.
 */
const userId = 'actor-1';
const feedbackId = '6f2b9d7c-1d4e-4a5b-9c8d-3e7f1a2b4c5d';
const createdAt = new Date('2026-08-06T00:00:00Z');

function rows(values: Record<string, unknown>[]) {
  return { rowCount: values.length, rows: values };
}

function fakePool(results: Array<{ rowCount: number; rows: Record<string, unknown>[] }>) {
  const queued = [...results];
  /*
   * Both parameters are named and used, rather than `_`-prefixed and ignored: this signature has to
   * stay (one test reads `pool.query.mock.calls[0]` as `[sql, values]`, which needs the types), and
   * ESLint's `args: 'after-used'` default only forgives an unused parameter that a *used* one
   * follows -- so two trailing unused ones are an error, unlike the `init(_config, instance)` shape
   * used elsewhere in this repo. Naming them into the failure message costs nothing and makes an
   * over-query actually diagnosable. The value count, not the values: a feedback body is the one
   * thing this suite must not print.
   */
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    const next = queued.shift();
    if (!next) {
      throw new Error(
        `fakePool received more queries than results were queued for: ${text} (${String(values?.length ?? 0)} values)`,
      );
    }
    return next;
  });
  return { query } as unknown as { query: typeof query };
}

const validInput = {
  body: 'The scene heading menu closes before I can pick an option.',
  context: { route: '/projects/abc/screenplay', appVersion: '1.4.0' },
};

describe('submitFeedbackInput', () => {
  it('trims the body and accepts an absent screenplay id', () => {
    expect(
      submitFeedbackInput.parse({
        body: '  Something is off with the title page.  ',
        context: { route: '/title-page', appVersion: '1.4.0' },
      }),
    ).toEqual({
      body: 'Something is off with the title page.',
      context: { route: '/title-page', appVersion: '1.4.0' },
    });
  });

  it('accepts a screenplay id when the writer was inside one', () => {
    const screenplayId = 'ecf1118c-3a2e-4656-84e6-fce75c461710';
    expect(
      submitFeedbackInput.parse({
        body: 'Autosave took a while here.',
        context: { route: '/editor', screenplayId, appVersion: '1.4.0' },
      }).context,
    ).toEqual({ route: '/editor', screenplayId, appVersion: '1.4.0' });
  });

  it('rejects a blank body and a body over the length cap', () => {
    expect(() => submitFeedbackInput.parse({ ...validInput, body: '   ' })).toThrow();
    expect(() =>
      submitFeedbackInput.parse({ ...validInput, body: 'x'.repeat(FEEDBACK_BODY_MAX_LENGTH + 1) }),
    ).toThrow();
    // The cap itself is inclusive -- exactly at the limit is still accepted.
    expect(
      submitFeedbackInput.parse({ ...validInput, body: 'x'.repeat(FEEDBACK_BODY_MAX_LENGTH) }).body,
    ).toHaveLength(FEEDBACK_BODY_MAX_LENGTH);
  });

  it('rejects a missing route or app version', () => {
    expect(() =>
      submitFeedbackInput.parse({ ...validInput, context: { appVersion: '1.4.0' } }),
    ).toThrow();
    expect(() =>
      submitFeedbackInput.parse({ ...validInput, context: { route: '/editor' } }),
    ).toThrow();
  });

  it('rejects an unknown top-level field -- the whole point being that a future caller cannot smuggle document content through this route', () => {
    expect(() =>
      submitFeedbackInput.parse({ ...validInput, screenplay: { scenes: [] } }),
    ).toThrow();
    expect(() => submitFeedbackInput.parse({ ...validInput, canonicalScreenplay: '{}' })).toThrow();
  });

  it('rejects an unknown field inside the context bundle for the identical reason', () => {
    expect(() =>
      feedbackContextInput.parse({ ...validInput.context, screenplayText: 'INT. HOUSE - DAY' }),
    ).toThrow();
  });
});

describe('PostgreSQL feedback store', () => {
  it('inserts the row and returns its id and ISO-formatted creation time, without a notifier', async () => {
    const pool = fakePool([rows([{ id: feedbackId, created_at: createdAt }])]);
    const store = createPostgresFeedbackStore(pool as never);

    const result = await store.submitFeedback(userId, validInput);

    expect(result).toEqual({ id: feedbackId, createdAt: createdAt.toISOString() });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = pool.query.mock.calls[0]!;
    expect(sql).toMatch(/insert into feedback/i);
    expect(values).toEqual([userId, validInput.body, JSON.stringify(validInput.context)]);
  });

  it('looks up the writer and calls the notifier with the full notification, after the insert has already committed', async () => {
    const pool = fakePool([
      rows([{ id: feedbackId, created_at: createdAt }]),
      rows([{ name: 'Writer One', email: 'writer-one@example.test' }]),
    ]);
    const sent: FeedbackNotification[] = [];
    const notifier: FeedbackNotifier = {
      feedbackReceived: vi.fn(async (notification) => void sent.push(notification)),
    };
    const store = createPostgresFeedbackStore(pool as never, notifier);

    const result = await store.submitFeedback(userId, validInput);

    expect(result).toEqual({ id: feedbackId, createdAt: createdAt.toISOString() });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      feedbackId,
      userId,
      userEmail: 'writer-one@example.test',
      userName: 'Writer One',
      body: validInput.body,
      context: validInput.context,
      createdAt,
    });
  });

  it('falls back to a generic name when the user row cannot be found, rather than failing', async () => {
    const pool = fakePool([rows([{ id: feedbackId, created_at: createdAt }]), rows([])]);
    const sent: FeedbackNotification[] = [];
    const notifier: FeedbackNotifier = {
      feedbackReceived: vi.fn(async (notification) => void sent.push(notification)),
    };
    const store = createPostgresFeedbackStore(pool as never, notifier);

    await store.submitFeedback(userId, validInput);

    expect(sent[0]?.userName).toBe('A Finaler Draft writer');
    expect(sent[0]?.userEmail).toBe('');
  });

  it('still returns success when the notifier rejects -- the database row is authoritative, the email is best-effort', async () => {
    const pool = fakePool([
      rows([{ id: feedbackId, created_at: createdAt }]),
      rows([{ name: 'Writer One', email: 'writer-one@example.test' }]),
    ]);
    const notifier: FeedbackNotifier = {
      feedbackReceived: vi.fn(async () => Promise.reject(new Error('Resend is down'))),
    };
    const store = createPostgresFeedbackStore(pool as never, notifier);

    const result = await store.submitFeedback(userId, validInput);

    expect(result).toEqual({ id: feedbackId, createdAt: createdAt.toISOString() });
    expect(notifier.feedbackReceived).toHaveBeenCalledTimes(1);
  });

  it("logs only the row id and the fact of a send failure -- never the writer's message or email address", async () => {
    const pool = fakePool([
      rows([{ id: feedbackId, created_at: createdAt }]),
      rows([{ name: 'Writer One', email: 'writer-one@example.test' }]),
    ]);
    const notifier: FeedbackNotifier = {
      feedbackReceived: vi.fn(async () => Promise.reject(new Error('Resend is down'))),
    };
    const store = createPostgresFeedbackStore(pool as never, notifier);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await store.submitFeedback(userId, validInput);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(logged).toEqual({
        event: 'feedback_email_failed',
        feedbackId,
        err: 'Error',
      });
      const loggedText = JSON.stringify(logged);
      expect(loggedText).not.toContain(validInput.body);
      expect(loggedText).not.toContain('writer-one@example.test');
      expect(loggedText).not.toContain('Resend is down');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

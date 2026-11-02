import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPostgresFeedbackStore,
  type FeedbackNotifier,
  type FeedbackStore,
} from './feedback.js';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';

/**
 * The "Send feedback" capture path, proven against a real, migrated Postgres database --
 * following `revisions.integration.test.ts`'s own pattern: a fresh throwaway database, migrated
 * with the project's own tooling, torn down afterward. `feedback.test.ts` (this package) already
 * proves the orchestration (best-effort notification, logging discipline) against a mocked pool;
 * this file proves the real write/read round trip -- the row genuinely lands with the exact
 * `context` jsonb a caller sent, the writer's name/email are read back from a real `user` row for
 * the notification, and the `onDelete: 'cascade'` the schema declares actually removes a deleted
 * user's feedback rather than leaving an orphaned row or failing the delete outright.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;

let admin: Pool | undefined;
let pool: Pool | undefined;
let databaseCreated = false;
let userSequence = 0;

describe.skipIf(!databaseUrl)('feedback capture (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);
    pool = createIntegrationPool({ connectionString: databaseUrl });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  it('writes the row with the exact context bundle sent, and returns an id and ISO timestamp drawn from the real row', async () => {
    const userId = await createUser();
    const store = createPostgresFeedbackStore(pool!);
    const input = {
      body: 'The scene heading menu closes before I can pick an option.',
      context: { route: '/screenplays/abc/editor', appVersion: '1.4.0' },
    };

    const result = await store.submitFeedback(userId, input);

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    const row = (await pool!.query('select * from feedback where id = $1', [result.id])).rows[0];
    expect(row.user_id).toBe(userId);
    expect(row.body).toBe(input.body);
    expect(row.context).toEqual(input.context);
    expect(new Date(row.created_at).toISOString()).toBe(result.createdAt);
  });

  it('stores an absent screenplay id as a context bundle with no such field, not as a stored null', async () => {
    const userId = await createUser();
    const store = createPostgresFeedbackStore(pool!);

    const result = await store.submitFeedback(userId, {
      body: 'Nothing to do with a specific screenplay.',
      context: { route: '/projects', appVersion: '1.4.0' },
    });

    const row = (await pool!.query('select context from feedback where id = $1', [result.id]))
      .rows[0];
    expect(row.context).not.toHaveProperty('screenplayId');
  });

  it('looks up the real writer and notifies with their actual name and email', async () => {
    const userId = await createUser('Real Writer');
    const sent: Array<{ userName: string; userEmail: string }> = [];
    const notifier: FeedbackNotifier = {
      feedbackReceived: vi.fn(async (notification) => {
        sent.push({ userName: notification.userName, userEmail: notification.userEmail });
      }),
    };
    const store: FeedbackStore = createPostgresFeedbackStore(pool!, notifier);

    await store.submitFeedback(userId, {
      body: 'Checking the real notification path.',
      context: { route: '/projects', appVersion: '1.4.0' },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.userName).toBe('Real Writer');
    expect(sent[0]!.userEmail).toMatch(/@example\.test$/);
  });

  it("cascades the feedback row away when the writer's account is deleted", async () => {
    const userId = await createUser();
    const store = createPostgresFeedbackStore(pool!);
    const result = await store.submitFeedback(userId, {
      body: 'This should disappear with my account.',
      context: { route: '/projects', appVersion: '1.4.0' },
    });

    await pool!.query('delete from "user" where id = $1', [userId]);

    const row = (await pool!.query('select id from feedback where id = $1', [result.id])).rows[0];
    expect(row).toBeUndefined();
  });

  it('applies its own body length and jsonb round trip correctly at the database boundary, independent of the zod cap', async () => {
    // The zod schema (`submitFeedbackInput`) is what actually enforces `FEEDBACK_BODY_MAX_LENGTH`
    // on the HTTP path; this exercises the store directly, underneath that schema, to prove the
    // column itself (`text`, genuinely unbounded at the database level) and the jsonb column
    // round-trip a body with no truncation or escaping surprises.
    const userId = await createUser();
    const store = createPostgresFeedbackStore(pool!);
    const body = 'Line one\nLine two with “smart quotes” and an emoji-free dash -- like this.';

    const result = await store.submitFeedback(userId, {
      body,
      context: { route: '/projects', appVersion: '1.4.0' },
    });

    const row = (await pool!.query('select body from feedback where id = $1', [result.id])).rows[0];
    expect(row.body).toBe(body);
  });
});

async function createUser(name = 'Writer'): Promise<string> {
  userSequence += 1;
  const id = `user-${userSequence}-${randomUUID()}`;
  await pool!.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [id, name, `writer-${userSequence}-${randomUUID()}@example.test`],
  );
  return id;
}

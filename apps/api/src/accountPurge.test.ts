import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_PURGE_BATCH_SIZE,
  ACCOUNT_PURGE_GRACE_PERIOD_DAYS,
  createPostgresAccountPurgeStore,
  HYGIENE_PURGE_BATCH_SIZE,
  MEMBERSHIP_INVITATION_RETENTION_DAYS,
  STRIPE_PROCESSED_EVENT_RETENTION_DAYS,
} from './accountPurge.js';

/**
 * Covers `accountPurge.ts`'s own orchestration (which queries run, in which order, dry run versus
 * the real sweep, structured logging) against a fake pool -- the same convention
 * `accountDeletion.test.ts` uses for `accountDeletion.ts`. What a fake pool cannot prove --
 * cascades, real row locks, the project-before-user ordering under a real foreign key, the "must
 * not purge a live account's project" boundary -- is proven against a real migrated database in
 * `accountPurge.integration.test.ts`; see that file's own module comment for why both exist.
 */

function rows(values: Record<string, unknown>[]) {
  return { rowCount: values.length, rows: values };
}

function empty() {
  return rows([]);
}

/** A fake `pg.Pool` whose `query` responses are consumed in call order -- this module's `run`
 * always issues its queries in the same fixed sequence (see `accountPurge.ts`'s `run`), so a
 * simple queue is enough without needing to pattern-match on SQL text. `connect()` is also faked,
 * for the account-sweep path, returning a client whose own `query` responses are a second,
 * independent queue. */
function fakePool(
  poolQueryResults: Array<ReturnType<typeof empty>>,
  clientQueryResults: Array<ReturnType<typeof empty>> = [],
) {
  const poolQueued = [...poolQueryResults];
  const clientQueued = [...clientQueryResults];
  const poolQuery = vi.fn(async () => poolQueued.shift() ?? empty());
  const clientQuery = vi.fn(async () => clientQueued.shift() ?? empty());
  const connect = vi.fn(async () => ({ query: clientQuery, release: vi.fn() }));
  return { query: poolQuery, connect, poolQuery, clientQuery } as never;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('exported constants', () => {
  it('names the grace window and retention windows as the documented values', () => {
    // These are the numbers `progress/account-purge-cron.md` cites; a change to any of them
    // should be a deliberate edit of this test, not a silent drift between the doc and the code.
    expect(ACCOUNT_PURGE_GRACE_PERIOD_DAYS).toBe(30);
    expect(STRIPE_PROCESSED_EVENT_RETENTION_DAYS).toBe(90);
    expect(MEMBERSHIP_INVITATION_RETENTION_DAYS).toBe(90);
    expect(ACCOUNT_PURGE_BATCH_SIZE).toBeGreaterThan(0);
    expect(HYGIENE_PURGE_BATCH_SIZE).toBeGreaterThan(0);
  });
});

describe('run (dry run)', () => {
  it('issues only select queries, opens no transaction, and reports counts without writing', async () => {
    const pool = fakePool([
      // findExpiredAccountIds (unbounded)
      rows([{ id: 'user-1' }, { id: 'user-2' }]),
      // countAccountsAndOwnedProjects's owned-projects filter query
      rows([{ toPurge: '3', skipped: '1' }]),
      // sessions count
      rows([{ count: '5' }]),
      // verifications count
      rows([{ count: '2' }]),
      // stripe processed events count
      rows([{ count: '7' }]),
      // membership invitations count
      rows([{ count: '4' }]),
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = createPostgresAccountPurgeStore(pool);

    const result = await store.run({ dryRun: true, now: new Date('2026-11-14T00:00:00Z') });

    expect(result).toEqual({
      accountsPurged: 2,
      projectsPurged: 3,
      ownedProjectsSkippedNotSoftDeleted: 1,
      sessionsPurged: 5,
      verificationsPurged: 2,
      stripeProcessedEventsPurged: 7,
      membershipInvitationsPurged: 4,
    });
    expect((pool as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
    for (const call of (pool as { query: ReturnType<typeof vi.fn> }).query.mock.calls) {
      const sql = (call[0] as string).trim().toLowerCase();
      expect(sql.startsWith('select')).toBe(true);
    }
    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string) as { event: string };
    expect(logged.event).toBe('account_purge_dry_run');
  });

  it('reports the full backlog, not clipped to the batch bound', async () => {
    const manyAccounts = Array.from({ length: ACCOUNT_PURGE_BATCH_SIZE + 50 }, (_, index) => ({
      id: `user-${index}`,
    }));
    const pool = fakePool([
      rows(manyAccounts),
      rows([{ toPurge: '0', skipped: '0' }]),
      rows([{ count: '0' }]),
      rows([{ count: '0' }]),
      rows([{ count: '0' }]),
      rows([{ count: '0' }]),
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = createPostgresAccountPurgeStore(pool);

    const result = await store.run({ dryRun: true });

    expect(result.accountsPurged).toBe(ACCOUNT_PURGE_BATCH_SIZE + 50);
  });
});

describe('run (real sweep)', () => {
  it('purges one expired account (with no owned projects) and sums it with the hygiene categories', async () => {
    const pool = fakePool(
      [
        // findExpiredAccountIds (bounded)
        rows([{ id: 'user-1' }]),
        // sessions delete
        { rowCount: 3, rows: [] },
        // verifications delete
        { rowCount: 1, rows: [] },
        // stripe events delete
        { rowCount: 0, rows: [] },
        // membership invitations delete
        { rowCount: 2, rows: [] },
      ],
      [
        // purgeOneAccount's client-level statements, in order: 'begin' (ignored), the user select
        // (meaningful), fetchOwnedProjects (empty -- this account owns nothing), 'delete "user"'
        // (ignored), 'commit' (ignored). No 'delete from projects' slot: toPurge is empty.
        empty(),
        { rowCount: 1, rows: [{ deletedAt: new Date('2026-01-01T00:00:00Z') }] },
        empty(),
        empty(),
        empty(),
      ],
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = createPostgresAccountPurgeStore(pool);

    const result = await store.run({ dryRun: false, now: new Date('2026-11-14T00:00:00Z') });

    expect(result.accountsPurged).toBe(1);
    expect(result.projectsPurged).toBe(0);
    expect(result.ownedProjectsSkippedNotSoftDeleted).toBe(0);
    expect(result.sessionsPurged).toBe(3);
    expect(result.verificationsPurged).toBe(1);
    expect(result.stripeProcessedEventsPurged).toBe(0);
    expect(result.membershipInvitationsPurged).toBe(2);
    expect((pool as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalledTimes(1);
  });

  it('never calls connect at all when there is no backlog', async () => {
    const pool = fakePool([
      empty(),
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = createPostgresAccountPurgeStore(pool);

    const result = await store.run({ dryRun: false });

    expect(result.accountsPurged).toBe(0);
    expect((pool as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
  });
});

describe('structured logging', () => {
  it('never logs an email, a title, or any document content -- counts and ids only', async () => {
    const pool = fakePool([
      empty(),
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = createPostgresAccountPurgeStore(pool);

    await store.run({ dryRun: false });

    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    for (const [key, value] of Object.entries(logged)) {
      if (key === 'event') {
        expect(typeof value).toBe('string');
        continue;
      }
      expect(typeof value).toBe('number');
    }
  });
});

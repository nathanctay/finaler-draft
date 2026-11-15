import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPostgresAccountDeletionStore,
  type AccountDeletionStripePort,
} from './accountDeletion.js';
import type { SubscriptionProjection, SubscriptionStore } from './stripeSubscriptions.js';

/**
 * Covers `accountDeletion.ts`'s own orchestration against a fake pool and a fake Stripe client --
 * which queries run, in which order, which outcome each path maps to, and that the transaction
 * always rolls back and releases its client. The same decisions are additionally proven end to
 * end, against a real migrated database, in `accountDeletion.integration.test.ts`.
 *
 * `fakePool`'s `connect()` returns a fresh queue-backed client per call (there is only ever one
 * call per `deleteAccount` invocation in these tests, but matching `sharing.test.ts`'s own
 * `fakeClient` shape keeps the two files reading the same way). `pool.query` itself is a second,
 * independent queue, since `deleteAccount` calls it directly (the unlocked refusal-gate read)
 * before ever calling `connect()`.
 */
const actorId = 'actor-1';

function rows(values: Record<string, unknown>[]) {
  return { rowCount: values.length, rows: values };
}

function empty() {
  return rows([]);
}

function fakeClient(results: Array<ReturnType<typeof empty>>) {
  const queued = [...results];
  return {
    query: vi.fn<(text: string, values?: readonly unknown[]) => Promise<ReturnType<typeof empty>>>(
      async () => queued.shift() ?? empty(),
    ),
    release: vi.fn(),
  };
}

function fakePool(
  poolQueryResults: Array<ReturnType<typeof empty>>,
  client: ReturnType<typeof fakeClient>,
) {
  const poolQueued = [...poolQueryResults];
  return {
    query: vi.fn<(text: string, values?: readonly unknown[]) => Promise<ReturnType<typeof empty>>>(
      async () => poolQueued.shift() ?? empty(),
    ),
    connect: vi.fn(async () => client),
  } as never;
}

function subscriptionRow(overrides?: Partial<SubscriptionProjection>): SubscriptionProjection {
  return {
    userId: actorId,
    stripeCustomerId: 'cus_test_FAKE',
    stripeSubscriptionId: 'sub_test_FAKE',
    stripePriceId: 'price_test_FAKE',
    status: 'active',
    currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    ...overrides,
  };
}

function fakeSubscriptionStore(
  row: SubscriptionProjection | undefined,
): Pick<SubscriptionStore, 'getSubscriptionForUser'> {
  return { getSubscriptionForUser: vi.fn(async () => row) };
}

type SubscriptionsRetrieve = (id: string) => Promise<{ status: string }>;
type SubscriptionsCancel = (id: string) => Promise<{ status: string }>;

function fakeStripe(overrides?: {
  retrieve?: SubscriptionsRetrieve;
  cancel?: SubscriptionsCancel;
}): {
  port: AccountDeletionStripePort;
  retrieve: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const retrieve = vi.fn<SubscriptionsRetrieve>(
    overrides?.retrieve ?? (async () => ({ status: 'active' })),
  );
  const cancel = vi.fn<SubscriptionsCancel>(
    overrides?.cancel ?? (async () => ({ status: 'canceled' })),
  );
  return {
    port: { client: { subscriptions: { retrieve, cancel } } as never },
    retrieve,
    cancel,
  };
}

const OWNED_PROJECT_QUERY_PREFIX = 'select p.id, p.title';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('findOwnedProjectsWithCollaborators', () => {
  it('returns every owned, non-deleted project that has at least one other member', async () => {
    const pool = fakePool(
      [rows([{ id: 'project-1', title: 'Shared screenplay' }])],
      fakeClient([]),
    );
    const store = createPostgresAccountDeletionStore(
      pool,
      fakeStripe().port,
      fakeSubscriptionStore(undefined),
    );

    const result = await store.findOwnedProjectsWithCollaborators(actorId);

    expect(result).toEqual([{ id: 'project-1', title: 'Shared screenplay' }]);
    expect((pool as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledWith(
      expect.stringContaining(OWNED_PROJECT_QUERY_PREFIX),
      [actorId],
    );
  });

  it('returns an empty list for an account that owns no projects with other members', async () => {
    const pool = fakePool([empty()], fakeClient([]));
    const store = createPostgresAccountDeletionStore(
      pool,
      fakeStripe().port,
      fakeSubscriptionStore(undefined),
    );

    const result = await store.findOwnedProjectsWithCollaborators(actorId);

    expect(result).toEqual([]);
  });
});

describe('deleteAccount', () => {
  it('refuses, naming the projects, when an owned project has collaborators and the flag is not set -- before touching Stripe', async () => {
    const pool = fakePool(
      [rows([{ id: 'project-1', title: 'Shared screenplay' }])],
      fakeClient([]),
    );
    const { port: stripePort, retrieve, cancel } = fakeStripe();
    const subscriptions = fakeSubscriptionStore(subscriptionRow());
    const store = createPostgresAccountDeletionStore(pool, stripePort, subscriptions);

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({
      outcome: 'owned-projects-have-collaborators',
      projects: [{ id: 'project-1', title: 'Shared screenplay' }],
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(subscriptions.getSubscriptionForUser as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect((pool as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
  });

  it('proceeds and deletes the collaborator-owned project too when the flag is set', async () => {
    const client = fakeClient([
      empty(), // begin
      rows([{ deletedAt: null }]), // user lock
      rows([{ id: 'project-1', title: 'Shared screenplay' }]), // owned projects
      rows([
        { projectId: 'project-1', userId: actorId },
        { projectId: 'project-1', userId: 'collaborator-1' },
      ]), // members
      empty(), // delete session
      empty(), // update user
      empty(), // update projects
      empty(), // commit
    ]);
    const pool = fakePool([rows([{ id: 'project-1', title: 'Shared screenplay' }])], client);
    const subscriptions = fakeSubscriptionStore(undefined);
    const store = createPostgresAccountDeletionStore(pool, fakeStripe().port, subscriptions);

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: true,
    });

    expect(result).toEqual({ outcome: 'deleted' });
    expect(client.query).toHaveBeenNthCalledWith(5, 'delete from session where user_id = $1', [
      actorId,
    ]);
    expect(client.query).toHaveBeenNthCalledWith(
      6,
      'update "user" set deleted_at = now(), updated_at = now() where id = $1',
      [actorId],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      7,
      'update projects set deleted_at = now() where id = any($1)',
      [['project-1']],
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('deletes a solo-owned project regardless of the flag', async () => {
    const client = fakeClient([
      empty(), // begin
      rows([{ deletedAt: null }]), // user lock
      rows([{ id: 'project-1', title: 'Solo screenplay' }]), // owned projects
      rows([{ projectId: 'project-1', userId: actorId }]), // members: only the owner
      empty(), // delete session
      empty(), // update user
      empty(), // update projects
      empty(), // commit
    ]);
    const pool = fakePool([empty()], client);
    const store = createPostgresAccountDeletionStore(
      pool,
      fakeStripe().port,
      fakeSubscriptionStore(undefined),
    );

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({ outcome: 'deleted' });
    expect(client.query).toHaveBeenNthCalledWith(
      7,
      'update projects set deleted_at = now() where id = any($1)',
      [['project-1']],
    );
  });

  it('re-derives collaborator status fresh under lock rather than trusting the early precheck -- excluding only the project that gained a collaborator in between', async () => {
    // The early, pre-Stripe gate (`pool.query`) sees two solo-owned projects and passes. Between
    // that read and the final transaction's own lock, a collaborator is accepted onto one of
    // them (simulated here by the `project_members` rows the locked, in-transaction query
    // returns). With the flag `false`, that project must be excluded from the sweep while the
    // other, still genuinely solo, project is still deleted -- proving the final decision is
    // read fresh under lock, not copied from the stale early result.
    const client = fakeClient([
      empty(), // begin
      rows([{ deletedAt: null }]), // user lock
      rows([
        { id: 'project-solo', title: 'Still solo' },
        { id: 'project-raced', title: 'Gained a collaborator mid-flight' },
      ]), // owned projects
      rows([
        { projectId: 'project-solo', userId: actorId },
        { projectId: 'project-raced', userId: actorId },
        { projectId: 'project-raced', userId: 'late-collaborator' },
      ]), // members, fresh
      empty(), // delete session
      empty(), // update user
      empty(), // update projects
      empty(), // commit
    ]);
    const pool = fakePool([empty()], client); // early gate: no collaborators seen yet
    const store = createPostgresAccountDeletionStore(
      pool,
      fakeStripe().port,
      fakeSubscriptionStore(undefined),
    );

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({ outcome: 'deleted' });
    expect(client.query).toHaveBeenNthCalledWith(
      7,
      'update projects set deleted_at = now() where id = any($1)',
      [['project-solo']],
    );
  });

  it('skips Stripe entirely when the account has no subscription row', async () => {
    const client = fakeClient([
      empty(),
      rows([{ deletedAt: null }]),
      empty(), // no owned projects
      empty(),
      empty(),
      empty(),
    ]);
    const pool = fakePool([empty()], client);
    const { port: stripePort, retrieve, cancel } = fakeStripe();
    const store = createPostgresAccountDeletionStore(
      pool,
      stripePort,
      fakeSubscriptionStore(undefined),
    );

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({ outcome: 'deleted' });
    expect(retrieve).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('skips Stripe when the local projection already shows the subscription canceled', async () => {
    const client = fakeClient([
      empty(),
      rows([{ deletedAt: null }]),
      empty(),
      empty(),
      empty(),
      empty(),
    ]);
    const pool = fakePool([empty()], client);
    const { port: stripePort, retrieve, cancel } = fakeStripe();
    const subscriptions = fakeSubscriptionStore(subscriptionRow({ status: 'canceled' }));
    const store = createPostgresAccountDeletionStore(pool, stripePort, subscriptions);

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({ outcome: 'deleted' });
    expect(retrieve).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels an active subscription at Stripe before writing anything locally', async () => {
    const client = fakeClient([
      empty(),
      rows([{ deletedAt: null }]),
      empty(),
      empty(),
      empty(),
      empty(),
    ]);
    const pool = fakePool([empty()], client);
    const { port: stripePort, retrieve, cancel } = fakeStripe();
    const subscriptions = fakeSubscriptionStore(subscriptionRow({ status: 'active' }));
    const store = createPostgresAccountDeletionStore(pool, stripePort, subscriptions);

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({ outcome: 'deleted' });
    expect(retrieve).toHaveBeenCalledWith('sub_test_FAKE');
    expect(cancel).toHaveBeenCalledWith('sub_test_FAKE');
  });

  it('reports a retryable failure, logging it, when a subscription row exists but no Stripe client is configured', async () => {
    // `stripe: undefined` is the real shape `server.ts` passes in an environment with no Stripe
    // keys at all -- this proves a leftover `subscriptions` row from before Stripe was
    // de-configured (or a genuine misconfiguration) is reported, not silently skipped as if there
    // were nothing to cancel.
    const pool = fakePool([empty()], fakeClient([]));
    const subscriptions = fakeSubscriptionStore(subscriptionRow({ status: 'active' }));
    const store = createPostgresAccountDeletionStore(pool, undefined, subscriptions);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({ outcome: 'stripe-cancellation-failed' });
    expect((pool as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({
      event: 'account_deletion_stripe_cancellation_failed',
      err: 'StripeNotConfigured',
    });
    errorSpy.mockRestore();
  });

  it('treats an already-canceled subscription at Stripe as success without calling cancel again', async () => {
    const client = fakeClient([
      empty(),
      rows([{ deletedAt: null }]),
      empty(),
      empty(),
      empty(),
      empty(),
    ]);
    const pool = fakePool([empty()], client);
    const {
      port: stripePort,
      retrieve,
      cancel,
    } = fakeStripe({
      retrieve: async () => ({ status: 'canceled' }),
    });
    const subscriptions = fakeSubscriptionStore(subscriptionRow({ status: 'active' }));
    const store = createPostgresAccountDeletionStore(pool, stripePort, subscriptions);

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({ outcome: 'deleted' });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('reports a retryable failure and leaves every local row untouched when Stripe cancellation fails', async () => {
    const client = fakeClient([]);
    const pool = fakePool([empty()], client);
    const { port: stripePort } = fakeStripe({
      retrieve: async () => {
        throw new Error('Stripe is down');
      },
    });
    const subscriptions = fakeSubscriptionStore(subscriptionRow({ status: 'active' }));
    const store = createPostgresAccountDeletionStore(pool, stripePort, subscriptions);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({ outcome: 'stripe-cancellation-failed' });
    expect((pool as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({ event: 'account_deletion_stripe_cancellation_failed', err: 'Error' });
    errorSpy.mockRestore();
  });

  it('is idempotent: replaying against an already-deleted account returns deleted without writing anything further', async () => {
    const client = fakeClient([
      empty(), // begin
      rows([{ deletedAt: '2026-01-01T00:00:00.000Z' }]), // user lock: already deleted
    ]);
    const pool = fakePool([empty()], client);
    const store = createPostgresAccountDeletionStore(
      pool,
      fakeStripe().port,
      fakeSubscriptionStore(undefined),
    );

    const result = await store.deleteAccount(actorId, {
      deleteOwnedProjectsWithCollaborators: false,
    });

    expect(result).toEqual({ outcome: 'deleted' });
    expect(client.query).toHaveBeenCalledTimes(3); // begin, select, rollback
    expect(client.query).toHaveBeenNthCalledWith(3, 'rollback');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the client, then rethrows, when an unexpected error occurs mid-transaction', async () => {
    const client = {
      query: vi
        .fn<(text: string, values?: readonly unknown[]) => Promise<ReturnType<typeof empty>>>()
        .mockResolvedValueOnce(empty()) // begin
        .mockRejectedValueOnce(new Error('connection lost')), // user lock
      release: vi.fn(),
    };
    const pool = fakePool([empty()], client);
    const store = createPostgresAccountDeletionStore(
      pool,
      fakeStripe().port,
      fakeSubscriptionStore(undefined),
    );

    await expect(
      store.deleteAccount(actorId, { deleteOwnedProjectsWithCollaborators: false }),
    ).rejects.toThrow('connection lost');

    expect(client.query).toHaveBeenCalledWith('rollback');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('throws rather than returning a refusal outcome when actorId does not resolve to a user row', async () => {
    const client = fakeClient([
      empty(), // begin
      empty(), // user lock: no row
    ]);
    const pool = fakePool([empty()], client);
    const store = createPostgresAccountDeletionStore(
      pool,
      fakeStripe().port,
      fakeSubscriptionStore(undefined),
    );

    await expect(
      store.deleteAccount(actorId, { deleteOwnedProjectsWithCollaborators: false }),
    ).rejects.toThrow('deleteAccount: actorId did not resolve to an existing user row.');
    expect(client.query).toHaveBeenCalledWith('rollback');
  });
});

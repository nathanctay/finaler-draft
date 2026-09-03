import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';
import { createPostgresSubscriptionStore, type SubscriptionStore } from './stripeSubscriptions.js';

// Follows persistence.integration.test.ts's pattern exactly: a fresh, throwaway database per
// suite run, migrated with the project's own tooling, torn down afterward (see
// integrationTestDatabase.ts). Skips entirely without TEST_DATABASE_URL, which is expected
// outside CI/a developer who has opted in.
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;
let admin: Pool | undefined;
let pool: Pool | undefined;
let store: SubscriptionStore | undefined;
let databaseCreated = false;

describe.skipIf(!databaseUrl)('Stripe subscription projection (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);

    pool = createIntegrationPool({ connectionString: databaseUrl });
    store = createPostgresSubscriptionStore(pool);
    await pool.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, 'Owner A', 'owner-a@example.test', true, now(), now()),
              ($2, 'Owner B', 'owner-b@example.test', true, now(), now())`,
      ['user-a', 'user-b'],
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  it('migrates the two Stripe billing tables with the expected shape', async () => {
    const tables = await pool!.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(['subscriptions', 'stripe_processed_events']),
    );
    const subscriptionColumns = await pool!.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'subscriptions'",
    );
    expect(subscriptionColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'user_id',
        'stripe_customer_id',
        'stripe_subscription_id',
        'stripe_price_id',
        'status',
        'current_period_end',
        'cancel_at_period_end',
        'canceled_at',
        'last_event_created_at',
      ]),
    );
    const uniqueIndexes = await pool!.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public' and tablename = 'subscriptions'",
    );
    expect(uniqueIndexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'subscriptions_stripe_customer_id_unique',
        'subscriptions_stripe_subscription_id_unique',
      ]),
    );
  });

  it('creates a new subscription projection on first application', async () => {
    const outcome = await store!.recordSubscriptionEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'customer.subscription.created',
      eventCreatedAt: new Date('2026-01-01T00:00:00Z'),
      userId: 'user-a',
      stripeCustomerId: 'cus_a',
      stripeSubscriptionId: 'sub_a',
      stripePriceId: 'price_monthly',
      status: 'active',
      currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    expect(outcome).toBe('applied');
    await expect(store!.getSubscriptionForUser('user-a')).resolves.toMatchObject({
      userId: 'user-a',
      stripeCustomerId: 'cus_a',
      stripeSubscriptionId: 'sub_a',
      stripePriceId: 'price_monthly',
      status: 'active',
    });
  });

  it('dedupes a repeated event.id into a single state change', async () => {
    const eventId = `evt_${randomUUID()}`;
    const base = {
      eventId,
      eventType: 'customer.subscription.updated',
      stripeCustomerId: 'cus_dedupe',
      stripeSubscriptionId: 'sub_dedupe',
      stripePriceId: 'price_monthly',
      cancelAtPeriodEnd: false,
      canceledAt: null,
    } as const;
    const first = await store!.recordSubscriptionEvent({
      ...base,
      userId: 'user-a',
      eventCreatedAt: new Date('2026-01-05T00:00:00Z'),
      status: 'active',
      currentPeriodEnd: new Date('2026-02-05T00:00:00Z'),
    });
    // Same event.id again, deliberately with a different status -- proves dedupe trusts only
    // `event.id`, not payload equality, exactly as a genuine Stripe redelivery would arrive.
    const second = await store!.recordSubscriptionEvent({
      ...base,
      userId: 'user-a',
      eventCreatedAt: new Date('2026-01-05T00:00:00Z'),
      status: 'past_due',
      currentPeriodEnd: new Date('2026-02-05T00:00:00Z'),
    });
    expect(first).toBe('applied');
    expect(second).toBe('duplicate');
    await expect(store!.getSubscriptionForUser('user-a')).resolves.toMatchObject({
      stripeSubscriptionId: 'sub_dedupe',
      status: 'active',
    });
  });

  it('does not move state backwards when an older event arrives after a newer one', async () => {
    await store!.recordSubscriptionEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'customer.subscription.updated',
      eventCreatedAt: new Date('2026-03-10T00:00:00Z'),
      userId: 'user-b',
      stripeCustomerId: 'cus_order',
      stripeSubscriptionId: 'sub_order',
      stripePriceId: 'price_monthly',
      status: 'active',
      currentPeriodEnd: new Date('2026-04-10T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    // A different, later-arriving event.id, but describing an earlier point in time -- the
    // out-of-order case plan.md calls out explicitly.
    const staleOutcome = await store!.recordSubscriptionEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'customer.subscription.updated',
      eventCreatedAt: new Date('2026-03-01T00:00:00Z'),
      userId: 'user-b',
      stripeCustomerId: 'cus_order',
      stripeSubscriptionId: 'sub_order',
      stripePriceId: 'price_monthly',
      status: 'past_due',
      currentPeriodEnd: new Date('2026-04-10T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    expect(staleOutcome).toBe('stale');
    await expect(store!.getSubscriptionForUser('user-b')).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('resolves the user from an existing row by customer id when a later event carries no metadata', async () => {
    await store!.recordSubscriptionEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'customer.subscription.created',
      eventCreatedAt: new Date('2026-05-01T00:00:00Z'),
      userId: 'user-a',
      stripeCustomerId: 'cus_fallback',
      stripeSubscriptionId: 'sub_fallback',
      stripePriceId: 'price_monthly',
      status: 'trialing',
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    const outcome = await store!.recordSubscriptionEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'customer.subscription.updated',
      eventCreatedAt: new Date('2026-05-02T00:00:00Z'),
      userId: null,
      stripeCustomerId: 'cus_fallback',
      stripeSubscriptionId: 'sub_fallback',
      stripePriceId: 'price_monthly',
      status: 'active',
      currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    expect(outcome).toBe('applied');
    await expect(store!.getSubscriptionForUser('user-a')).resolves.toMatchObject({
      stripeSubscriptionId: 'sub_fallback',
      status: 'active',
    });
  });

  it('returns unresolved and writes nothing when no user can be resolved at all', async () => {
    const outcome = await store!.recordSubscriptionEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'customer.subscription.created',
      eventCreatedAt: new Date('2026-01-01T00:00:00Z'),
      userId: null,
      stripeCustomerId: 'cus_orphan_never_seen',
      stripeSubscriptionId: 'sub_orphan_never_seen',
      stripePriceId: 'price_monthly',
      status: 'active',
      currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    expect(outcome).toBe('unresolved');
    const row = await pool!.query('select 1 from subscriptions where stripe_customer_id = $1', [
      'cus_orphan_never_seen',
    ]);
    expect(row.rowCount).toBe(0);
  });

  it('applies an invoice.paid event onto an existing subscription, refreshing its billing period', async () => {
    await store!.recordSubscriptionEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'customer.subscription.created',
      eventCreatedAt: new Date('2026-07-01T00:00:00Z'),
      userId: 'user-a',
      stripeCustomerId: 'cus_invoice',
      stripeSubscriptionId: 'sub_invoice',
      stripePriceId: 'price_monthly',
      status: 'past_due',
      currentPeriodEnd: new Date('2026-07-15T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    const outcome = await store!.recordInvoiceEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'invoice.paid',
      eventCreatedAt: new Date('2026-07-02T00:00:00Z'),
      stripeSubscriptionId: 'sub_invoice',
      status: 'active',
      currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
    });
    expect(outcome).toBe('applied');
    await expect(store!.getSubscriptionForUser('user-a')).resolves.toMatchObject({
      status: 'active',
      currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
    });
  });

  it('leaves currentPeriodEnd untouched when an invoice event does not carry one', async () => {
    await store!.recordSubscriptionEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'customer.subscription.created',
      eventCreatedAt: new Date('2026-09-01T00:00:00Z'),
      userId: 'user-b',
      stripeCustomerId: 'cus_no_period',
      stripeSubscriptionId: 'sub_no_period',
      stripePriceId: 'price_monthly',
      status: 'active',
      currentPeriodEnd: new Date('2026-09-15T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    const outcome = await store!.recordInvoiceEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'invoice.payment_failed',
      eventCreatedAt: new Date('2026-09-02T00:00:00Z'),
      stripeSubscriptionId: 'sub_no_period',
      status: 'past_due',
      currentPeriodEnd: null,
    });
    expect(outcome).toBe('applied');
    await expect(store!.getSubscriptionForUser('user-b')).resolves.toMatchObject({
      status: 'past_due',
      currentPeriodEnd: new Date('2026-09-15T00:00:00Z'),
    });
  });

  it('is a safe no-op when an invoice event references a subscription with no projection row yet', async () => {
    const outcome = await store!.recordInvoiceEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'invoice.paid',
      eventCreatedAt: new Date('2026-01-01T00:00:00Z'),
      stripeSubscriptionId: 'sub_never_created',
      status: 'active',
      currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
    });
    expect(outcome).toBe('ignored');
  });

  it('applies the same out-of-order guard to invoice events as to subscription events', async () => {
    await store!.recordSubscriptionEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'customer.subscription.created',
      eventCreatedAt: new Date('2026-10-01T00:00:00Z'),
      userId: 'user-a',
      stripeCustomerId: 'cus_invoice_order',
      stripeSubscriptionId: 'sub_invoice_order',
      stripePriceId: 'price_monthly',
      status: 'incomplete',
      currentPeriodEnd: new Date('2026-10-15T00:00:00Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    });
    await store!.recordInvoiceEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'invoice.paid',
      eventCreatedAt: new Date('2026-10-05T00:00:00Z'),
      stripeSubscriptionId: 'sub_invoice_order',
      status: 'active',
      currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
    });
    const staleOutcome = await store!.recordInvoiceEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: 'invoice.payment_failed',
      eventCreatedAt: new Date('2026-10-03T00:00:00Z'),
      stripeSubscriptionId: 'sub_invoice_order',
      status: 'past_due',
      currentPeriodEnd: null,
    });
    expect(staleOutcome).toBe('ignored');
    await expect(store!.getSubscriptionForUser('user-a')).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('dedupes recordIgnoredEvent independently, for event types this slice does not project', async () => {
    const eventId = `evt_${randomUUID()}`;
    const first = await store!.recordIgnoredEvent(eventId, 'customer.updated');
    const second = await store!.recordIgnoredEvent(eventId, 'customer.updated');
    expect(first).toBe('ignored');
    expect(second).toBe('duplicate');
  });
});

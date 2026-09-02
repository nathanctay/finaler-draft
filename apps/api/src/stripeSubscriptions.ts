import type { Pool, PoolClient } from 'pg';

/**
 * Mirrors the `subscription_status` Postgres enum (packages/database/src/schema.ts), which is
 * itself a reproduction of Stripe's `Subscription.Status` union at API version
 * 2026-07-29.dahlia. Kept in sync by hand rather than imported from the `stripe` package: this
 * store's public contract should not force every caller to depend on the Stripe SDK's types.
 */
export type SubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

export interface SubscriptionProjection {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
}

export interface SubscriptionEventInput {
  eventId: string;
  eventType: string;
  eventCreatedAt: Date;
  /**
   * The Better Auth user this Stripe customer belongs to, or `null` when it could not be
   * resolved from the event (see stripeWebhook.ts's `dispatchStripeEvent` for how this is read
   * from `subscription.metadata.userId`). `recordSubscriptionEvent` falls back to an existing
   * projection row for the same `stripeCustomerId` before giving up -- see its implementation
   * comment for the known limitation this covers.
   */
  userId: string | null;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
}

export interface InvoiceEventInput {
  eventId: string;
  eventType: string;
  eventCreatedAt: Date;
  stripeSubscriptionId: string;
  status: 'active' | 'past_due';
  /** Refreshed from the invoice's line-item billing period when Stripe includes one; `null`
   * leaves the existing `currentPeriodEnd` untouched rather than clobbering it with nothing. */
  currentPeriodEnd: Date | null;
}

/**
 * - `applied`: this event was new and its state change was written.
 * - `duplicate`: this exact `event.id` was already processed; no state change was made.
 * - `unresolved`: the event was new, but no Better Auth user could be resolved for it (only
 *   possible for `recordSubscriptionEvent` -- see its comment); recorded as processed anyway so
 *   Stripe's retries do not loop forever on it.
 * - `stale`: the event was new, but a later event already advanced this row past what this event
 *   would have written (the out-of-order guard); recorded as processed, state left untouched.
 * - `ignored`: the event was new but there was nothing to apply -- an unhandled event type, or
 *   (for invoices) no existing subscription row to update.
 */
export type ProcessOutcome = 'applied' | 'duplicate' | 'unresolved' | 'stale' | 'ignored';

export interface SubscriptionStore {
  recordSubscriptionEvent(input: SubscriptionEventInput): Promise<ProcessOutcome>;
  recordInvoiceEvent(input: InvoiceEventInput): Promise<ProcessOutcome>;
  /** Marks an event processed without applying any state change -- used for Stripe event types
   * this slice does not project (plan.md: "Return 2xx quickly for events you do not handle"). */
  recordIgnoredEvent(eventId: string, eventType: string): Promise<ProcessOutcome>;
  getSubscriptionForUser(userId: string): Promise<SubscriptionProjection | undefined>;
}

// Shared by every `record*` method: atomically claims an event id, returning `true` only for the
// caller that is the first to see it. A unique-violation-shaped `on conflict ... do nothing`
// rather than a separate "have I seen this?" select-then-insert -- the latter has a race between
// two concurrent deliveries of the same event that this single statement does not.
async function markProcessed(
  client: Pick<PoolClient, 'query'>,
  eventId: string,
  eventType: string,
): Promise<boolean> {
  const result = await client.query(
    'insert into stripe_processed_events (id, type) values ($1, $2) on conflict (id) do nothing returning id',
    [eventId, eventType],
  );
  return result.rowCount === 1;
}

function projectionFromRow(row: Record<string, unknown>): SubscriptionProjection {
  return {
    userId: row.userId as string,
    stripeCustomerId: row.stripeCustomerId as string,
    stripeSubscriptionId: row.stripeSubscriptionId as string,
    stripePriceId: row.stripePriceId as string,
    status: row.status as SubscriptionStatus,
    currentPeriodEnd: new Date(row.currentPeriodEnd as Date),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd as boolean,
    canceledAt: row.canceledAt ? new Date(row.canceledAt as Date) : null,
  };
}

export function createPostgresSubscriptionStore(pool: Pool): SubscriptionStore {
  return {
    async recordSubscriptionEvent(input) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const isNew = await markProcessed(client, input.eventId, input.eventType);
        if (!isNew) {
          await client.query('rollback');
          return 'duplicate';
        }
        let resolvedUserId = input.userId;
        if (!resolvedUserId) {
          // The Checkout Session that creates a subscription (a later slice) is what stamps
          // `metadata.userId` onto it in the first place; this webhook can only read metadata
          // that already exists on the event. Falling back to an existing projection row for the
          // same Stripe customer covers the case where a later event on an already-linked
          // customer arrives without that metadata attached (Stripe does not guarantee every
          // subsequent event echoes the original metadata). If neither source resolves a user,
          // this event cannot be projected -- see `ProcessOutcome`'s `unresolved`.
          const existing = await client.query<{ userId: string }>(
            'select user_id as "userId" from subscriptions where stripe_customer_id = $1 for update',
            [input.stripeCustomerId],
          );
          resolvedUserId = existing.rows[0]?.userId ?? null;
        }
        if (!resolvedUserId) {
          await client.query('commit');
          return 'unresolved';
        }
        const result = await client.query(
          `insert into subscriptions (
             user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
             status, current_period_end, cancel_at_period_end, canceled_at,
             last_event_created_at, updated_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           on conflict (user_id) do update set
             stripe_customer_id = excluded.stripe_customer_id,
             stripe_subscription_id = excluded.stripe_subscription_id,
             stripe_price_id = excluded.stripe_price_id,
             status = excluded.status,
             current_period_end = excluded.current_period_end,
             cancel_at_period_end = excluded.cancel_at_period_end,
             canceled_at = excluded.canceled_at,
             last_event_created_at = excluded.last_event_created_at,
             updated_at = now()
           where subscriptions.last_event_created_at < excluded.last_event_created_at
           returning user_id`,
          [
            resolvedUserId,
            input.stripeCustomerId,
            input.stripeSubscriptionId,
            input.stripePriceId,
            input.status,
            input.currentPeriodEnd,
            input.cancelAtPeriodEnd,
            input.canceledAt,
            input.eventCreatedAt,
          ],
        );
        await client.query('commit');
        // The `where` clause above is the out-of-order guard (plan.md: "An out-of-order arrival
        // must not move state backwards"): on a fresh insert there is no conflict to evaluate it
        // against, so it always applies; on a conflict, Postgres evaluates it per-row and simply
        // omits the row from `returning` when it is false, rather than updating it -- so an empty
        // result here means "a later event already won," not an error.
        return result.rowCount === 1 ? 'applied' : 'stale';
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async recordInvoiceEvent(input) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const isNew = await markProcessed(client, input.eventId, input.eventType);
        if (!isNew) {
          await client.query('rollback');
          return 'duplicate';
        }
        // Update-only, deliberately: creating a full projection row needs a resolved userId and
        // a priceId, neither of which an invoice event reliably carries on its own in this API
        // version (see stripeWebhook.ts's module comment for the full reasoning). If no matching
        // subscription row exists yet, the upcoming customer.subscription.created/updated event
        // for the same subscription is what establishes it; this invoice event is a safe no-op.
        const result = await client.query(
          `update subscriptions
              set status = $1,
                  current_period_end = coalesce($2, current_period_end),
                  last_event_created_at = $3,
                  updated_at = now()
            where stripe_subscription_id = $4
              and last_event_created_at < $3
            returning user_id`,
          [input.status, input.currentPeriodEnd, input.eventCreatedAt, input.stripeSubscriptionId],
        );
        await client.query('commit');
        return result.rowCount === 1 ? 'applied' : 'ignored';
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async recordIgnoredEvent(eventId, eventType) {
      const isNew = await markProcessed(pool, eventId, eventType);
      return isNew ? 'ignored' : 'duplicate';
    },
    async getSubscriptionForUser(userId) {
      const result = await pool.query(
        `select user_id as "userId", stripe_customer_id as "stripeCustomerId",
                stripe_subscription_id as "stripeSubscriptionId", stripe_price_id as "stripePriceId",
                status, current_period_end as "currentPeriodEnd",
                cancel_at_period_end as "cancelAtPeriodEnd", canceled_at as "canceledAt"
           from subscriptions
          where user_id = $1`,
        [userId],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? projectionFromRow(row) : undefined;
    },
  };
}

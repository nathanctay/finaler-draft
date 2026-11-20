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
  /**
   * No longer a correctness guard (see `ProcessOutcome` and this file's module comment -- BIL-1
   * retired the `created`-based ordering check entirely). Still threaded through and written to
   * `last_event_created_at`, which stays `not null`, purely because dropping the column is a
   * migration and out of this slice's scope; nothing reads it back to make a decision anymore.
   */
  eventCreatedAt: Date;
  /**
   * The Better Auth user this Stripe customer belongs to, or `null` when it could not be
   * resolved from the event (see stripeWebhook.ts's `dispatchStripeEvent` for how this is read
   * from the *retrieved* subscription's `metadata.userId`, never the webhook payload's). Falls
   * back to an existing projection row for the same `stripeCustomerId` before giving up -- see
   * this function's implementation comment for the known limitation this covers.
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

/**
 * - `applied`: this event was new and its state change was written.
 * - `duplicate`: this exact `event.id` was already processed; no state change was made.
 * - `unresolved`: the event was new, but no Better Auth user could be resolved for it; recorded
 *   as processed anyway so Stripe's retries do not loop forever on it.
 * - `ignored`: the event was new but there was nothing to apply -- an unhandled event type, or a
 *   subscription with no line items (see stripeWebhook.ts).
 *
 * There is deliberately no `stale`/out-of-order outcome anymore (BIL-1): every application now
 * writes whatever the retrieved subscription's own current state is, so there is no "this event's
 * payload is older than what's already stored" question left to ask -- the payload's own age
 * never enters into it.
 */
export type ProcessOutcome = 'applied' | 'duplicate' | 'unresolved' | 'ignored';

export interface SubscriptionStore {
  /**
   * Upserts the full current state of one subscription, keyed by `eventId` for dedup. Used for
   * both `customer.subscription.*` and `invoice.*` events (see stripeWebhook.ts's
   * `dispatchStripeEvent`): both retrieve the subscription from Stripe first, so by the time
   * either calls here, there is exactly one shape of write to make -- an invoice event is no
   * longer a distinct, narrower write than a subscription event is (BIL-2).
   */
  recordSubscriptionEvent(input: SubscriptionEventInput): Promise<ProcessOutcome>;
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
        // No `where` clause gating this on `last_event_created_at` anymore (BIL-1): the caller
        // (stripeWebhook.ts's `dispatchStripeEvent`) already retrieved this subscription from
        // Stripe immediately before calling here, so `input` is Stripe's own current state, not
        // a possibly-out-of-order snapshot from an event payload. There is no "is this older than
        // what's already stored" question left to ask -- whichever retrieval happened most
        // recently is definitionally the one to keep, and that is exactly the row this upsert
        // writes every time.
        // No `where` clause gating this on `last_event_created_at` anymore (BIL-1): the caller
        // (stripeWebhook.ts's `dispatchStripeEvent`) already retrieved this subscription from
        // Stripe immediately before calling here, so `input` is Stripe's own current state, not
        // a possibly-out-of-order snapshot from an event payload. There is no "is this older than
        // what's already stored" question left to ask -- whichever retrieval happened most
        // recently is definitionally the one to keep, and that is exactly the row this upsert
        // writes every time.
        await client.query(
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
             updated_at = now()`,
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
        return 'applied';
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

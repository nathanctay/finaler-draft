import type { Pool, PoolClient } from 'pg';
import type Stripe from 'stripe';
import type { SubscriptionStore } from './stripeSubscriptions.js';

/**
 * Account deletion (progress/account-deletion-backend.md, slice B of the launch-readiness
 * roadmap). Deletion marks the account deleted **immediately** -- sign-in refused, the
 * subscription cancelled, every session row gone -- and the row itself is purged later, after a
 * fixed 30-day grace window, by a Railway cron (slice C) this module does not build and does not
 * schedule. It only produces the state that cron will eventually read: `user.deleted_at` set, and
 * nothing else about the row changed or removed.
 *
 * **Owned projects: informed override, not a hard block.** `findOwnedProjectsWithCollaborators`
 * is the read-only precheck a caller (the eventual slice D UI) uses to show which of this
 * account's owned projects have other members, before ever calling `deleteAccount` --
 * deliberately a separate function, so a confirmation screen can be built without the deletion
 * flag and without side effects. `deleteAccount` re-runs the identical classification itself
 * (never trusts a prior call's result, which could be stale by the time this one runs) and
 * refuses outright, naming the same projects, unless `deleteOwnedProjectsWithCollaborators` is
 * `true`. A solo-owned project -- no member but this account -- is deleted with the account
 * either way; that half of the brief has no flag to set.
 *
 * **Stripe first, deliberately, and why the local writes are still one transaction despite
 * that.** See `cancelStripeSubscription`'s and `deleteAccount`'s own comments for the full
 * argument; the short version is that a failed Stripe cancellation must leave every local row
 * untouched (a `'stripe-cancellation-failed'` outcome is retryable precisely because nothing
 * changed), while Stripe itself cannot be a participant in the Postgres transaction that performs
 * every local write, so it has to run to completion -- success or failure -- before that
 * transaction ever opens.
 *
 * **Lock order.** This transaction is the first thing in the codebase to lock `"user"` or
 * `session` at all (checked by grepping every other store for `from "user"`/`"user" set`/
 * `from session`/`session set` -- nothing else touches either under a lock), so there is no
 * existing cross-table order it could contradict for those two. What it does inherit is the
 * `projects` row **before** `project_members` rows convention every other write in this codebase
 * already follows (`projects.ts`'s `deleteProject`/`renameProject`, `sharing.ts`'s
 * `lockScope`/`fetchProjectRole`, and `transferOwnership`'s own row-lock pair) -- see
 * `deleteAccount`'s own comment for why that specific agreement is what rules out a deadlock
 * against `transferOwnership` even though this function takes no advisory lock of its own.
 */

export interface OwnedProjectWithCollaborators {
  id: string;
  title: string;
}

export type DeleteAccountOutcome =
  | { outcome: 'deleted' }
  /**
   * Refused before anything happened -- no Stripe call, no local write. `projects` is the exact
   * list `findOwnedProjectsWithCollaborators` would also return for this account right now, so
   * the caller never needs a second round trip just to render what it already asked this
   * function to decide on.
   */
  | { outcome: 'owned-projects-have-collaborators'; projects: OwnedProjectWithCollaborators[] }
  /**
   * Stripe rejected (or could not be reached for) the cancellation request. Retryable: nothing
   * local was written, and the account is not deleted. See `cancelStripeSubscription`'s comment
   * for what "the cancellation" means when Stripe already reports the subscription as canceled
   * (not a failure) versus when the call itself errors (this outcome).
   */
  | { outcome: 'stripe-cancellation-failed' };

/**
 * `cancel`/`retrieve` only -- the same narrowing convention every other Stripe-touching port in
 * this codebase uses (`StripeWebhookPort.client: Pick<Stripe, 'webhooks'>`,
 * `BillingPort.client: Pick<Stripe, 'checkout' | 'billingPortal' | 'prices'>`), so a test can
 * supply a bare object with just these two methods stubbed instead of a full, real,
 * API-key-bearing `Stripe` instance -- see `accountDeletion.test.ts`'s `fakeStripeClient`.
 */
export interface AccountDeletionStripePort {
  client: Pick<Stripe, 'subscriptions'>;
}

export interface AccountDeletionStore {
  /**
   * Read-only, and deliberately takes no flag -- see this module's own comment. Returns the
   * project's id and title, the minimum a confirmation screen needs to name what is at stake.
   */
  findOwnedProjectsWithCollaborators(actorId: string): Promise<OwnedProjectWithCollaborators[]>;
  deleteAccount(
    actorId: string,
    options: { deleteOwnedProjectsWithCollaborators: boolean },
  ): Promise<DeleteAccountOutcome>;
}

type Queryable = Pick<PoolClient, 'query'> | Pick<Pool, 'query'>;

async function fetchOwnedProjectsWithCollaborators(
  db: Queryable,
  actorId: string,
): Promise<OwnedProjectWithCollaborators[]> {
  const result = await db.query(
    `select p.id, p.title
       from projects p
       join project_members m on m.project_id = p.id and m.role = 'owner'
      where m.user_id = $1
        and p.deleted_at is null
        and exists (
          select 1 from project_members other
           where other.project_id = p.id and other.user_id <> $1
        )
      order by p.title asc, p.id asc`,
    [actorId],
  );
  return result.rows as OwnedProjectWithCollaborators[];
}

/**
 * Cancels `subscriptionId` at Stripe. `'failed'` covers every way the attempt did not land --
 * Stripe unreachable, the API key rejected, the subscription id no longer resolving -- and is
 * logged the same bounded, name-only way every other Stripe-request failure in this codebase is
 * (`app.ts`'s `logStripeRequestFailure`, `sharing.ts`'s `invite` notification-failure log): never
 * the raw error object, which can carry request content back.
 *
 * **Retrieves before cancelling, rather than calling `cancel` outright.** This makes a retry of
 * `deleteAccount` idempotent against Stripe itself: if a previous attempt already cancelled this
 * subscription but the *local* transaction that should have followed it failed for an unrelated
 * reason (a dropped connection, say) before committing, a second attempt calling `cancel` again on
 * an already-cancelled subscription is a Stripe API error ("This subscription has already been
 * canceled"), not a no-op -- which would turn an already-successful cancellation into a spurious
 * `'stripe-cancellation-failed'` that a caller could never clear by retrying, defeating the whole
 * point of that outcome being retryable. Checking first and treating `status === 'canceled'` as
 * already-done avoids depending on parsing Stripe's error shape to recognize that specific case.
 */
async function cancelStripeSubscription(
  client: Pick<Stripe, 'subscriptions'>,
  subscriptionId: string,
): Promise<'canceled' | 'failed'> {
  try {
    const current = await client.subscriptions.retrieve(subscriptionId);
    if (current.status !== 'canceled') {
      await client.subscriptions.cancel(subscriptionId);
    }
    return 'canceled';
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'account_deletion_stripe_cancellation_failed',
        err: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    return 'failed';
  }
}

export function createPostgresAccountDeletionStore(
  pool: Pool,
  // `undefined` for the same reason every other optional Stripe-touching dependency in this
  // codebase accepts it (`BuildAppOptions.stripe`/`.billing` in app.ts): Stripe is optional in
  // every environment short of production (`requirePersistenceEnvironment`), and a development
  // or test process with persistence but no Stripe keys must still be able to delete an account
  // that was never able to subscribe in the first place. See `deleteAccount`'s own comment on
  // `cancelStripeSubscription`'s call site for the one case this makes a real difference: a
  // `subscriptions` row existing at all despite no Stripe client being configured now, which can
  // only mean a real misconfiguration (Stripe *was* reachable when the row was written), and is
  // reported as the identical retryable failure a real Stripe rejection would be, rather than
  // silently skipped.
  stripe: AccountDeletionStripePort | undefined,
  subscriptions: Pick<SubscriptionStore, 'getSubscriptionForUser'>,
): AccountDeletionStore {
  return {
    async findOwnedProjectsWithCollaborators(actorId) {
      return fetchOwnedProjectsWithCollaborators(pool, actorId);
    },

    /**
     * In order, and every step after the first early return is why the order is load-bearing:
     *
     *  1. **The refusal gate, unlocked, before Stripe is ever touched.** Re-runs the identical
     *     query `findOwnedProjectsWithCollaborators` runs (never trusts a result the caller might
     *     be holding from an earlier call) and refuses outright, with no Stripe call and no local
     *     write, when owned projects with other members exist and the caller did not set
     *     `deleteOwnedProjectsWithCollaborators`. This has to run *before* Stripe specifically
     *     because a refusal must have zero side effects -- cancelling a live subscription and
     *     then refusing the deletion it was meant to precede would leave the account billed for
     *     nothing it could still use to resubscribe cleanly, which is a worse outcome than the
     *     plain refusal this gate exists to produce.
     *
     *     Not re-verified again later, inside the final transaction, once this gate has passed:
     *     see the comment on `projectIdsToDelete` below for why re-checking there would only ever
     *     make things worse, not safer.
     *
     *  2. **Stripe, outside any Postgres transaction.** `cancelStripeSubscription` only runs at
     *     all when this account has a subscription that is not already `'canceled'` -- most
     *     accounts on the free tier have no `subscriptions` row at all, and this step is a no-op
     *     for every one of them. A genuine failure here returns `'stripe-cancellation-failed'`
     *     immediately, before any local row is touched -- nothing to roll back, because nothing
     *     was written.
     *
     *  3. **The one local transaction**, opened only once Stripe has either succeeded or had
     *     nothing to do. Lock order inside it, and why each piece is placed where it is:
     *
     *     a. `"user"`, locked first -- the central resource of "delete this account," the same
     *        role the `projects` row plays as the first lock in `deleteProject`/`renameProject`.
     *        Also what makes two concurrent `deleteAccount` calls for the same account serialize
     *        rather than race: the second blocks here until the first commits, then re-reads
     *        `deleted_at` already set and returns `{ outcome: 'deleted' }` -- an idempotent replay
     *        of a request that already succeeded, not an error.
     *
     *     b. The account's owned, non-deleted `projects` rows, locked next, in a fixed `order by
     *        id` -- deterministic so that if this account ever owned enough projects for this
     *        transaction to lock more than one, a concurrent transaction touching the same set
     *        (there is no such transaction today; see below) could not deadlock by acquiring them
     *        in the opposite order.
     *
     *     c. Every `project_members` row for those projects, locked next, again in a fixed order
     *        -- `projects` before `project_members`, the identical sub-order `deleteProject`,
     *        `lockScope`/`fetchProjectRole`, and `transferOwnership` all already use for the same
     *        two tables. This is what rules out a deadlock against `transferOwnership`
     *        specifically: that function takes its own advisory lock first and then the same two
     *        row locks in the same relative order this does, so the two can never hold
     *        opposite-order claims on the same pair of rows -- whichever reaches a contested
     *        `projects` row first just makes the other wait in a straight line, never a cycle.
     *        Nothing else in this codebase locks `"user"` or `session` at all (confirmed by grep,
     *        not assumed), so there is no existing path this transaction's own two novel locks
     *        could disagree with either.
     *
     *        This lock does **not** block a brand-new `project_members` row from being *inserted*
     *        by a concurrent invitation acceptance (`respondToInvitation` never locks the
     *        `projects` row at all, only the invitation row) -- a known, narrow race, not a new
     *        one this function introduces: `deleteProject` already tolerates the identical gap
     *        for the same reason (a `SELECT ... FOR UPDATE` only locks rows that already exist).
     *        See `progress/account-deletion-backend.md` for the accepted consequence.
     *
     *     d. `session` rows for this account, deleted outright -- immediate, and sufficient on
     *        its own for every session that already exists. `session` is untouched by every other
     *        write path in this codebase, so its place in this ordering is not contended by
     *        anything and could move freely; it sits here, after the lock acquisition above and
     *        before the actual updates below, simply because there is no reason to hold it any
     *        earlier or later.
     *
     *     e. `"user".deleted_at` set.
     *
     *     f. `projects.deleted_at` set for the selected subset -- see `projectIdsToDelete` below
     *        for exactly which ones.
     */
    async deleteAccount(actorId, options) {
      const refusal = await fetchOwnedProjectsWithCollaborators(pool, actorId);
      if (refusal.length > 0 && !options.deleteOwnedProjectsWithCollaborators) {
        return { outcome: 'owned-projects-have-collaborators', projects: refusal };
      }

      const subscription = await subscriptions.getSubscriptionForUser(actorId);
      if (subscription && subscription.status !== 'canceled') {
        if (!stripe) {
          // A `subscriptions` row exists, so this account *was* able to subscribe at some point
          // -- Stripe was configured then. Its absence now is a real operational problem, not
          // the ordinary "this environment has no Stripe keys" case (which never has a
          // subscription row to find in the first place): there is nothing to cancel against, so
          // this is reported the identical way a genuine Stripe rejection would be, rather than
          // silently treated as "nothing to do."
          console.error(
            JSON.stringify({
              event: 'account_deletion_stripe_cancellation_failed',
              err: 'StripeNotConfigured',
            }),
          );
          return { outcome: 'stripe-cancellation-failed' };
        }
        const cancelled = await cancelStripeSubscription(
          stripe.client,
          subscription.stripeSubscriptionId,
        );
        if (cancelled === 'failed') {
          return { outcome: 'stripe-cancellation-failed' };
        }
      }

      const client = await pool.connect();
      try {
        await client.query('begin');
        const userRow = await client.query<{ deletedAt: Date | null }>(
          'select deleted_at as "deletedAt" from "user" where id = $1 for update',
          [actorId],
        );
        if (userRow.rowCount !== 1) {
          // Not a reachable product state: `actorId` always comes from an authenticated
          // session's own resolved identity (app.ts's choke point), which cannot name an account
          // that does not exist. Thrown rather than returned as a `DeleteAccountOutcome` so a
          // caller cannot mistake a programming error reaching this function for a legitimate,
          // user-facing refusal -- left for the `catch` below to roll back, the same as any other
          // unexpected failure in this transaction, rather than rolling back twice.
          throw new Error('deleteAccount: actorId did not resolve to an existing user row.');
        }
        if (userRow.rows[0]!.deletedAt) {
          // A retried request (double submission, or a legitimate retry after the Stripe call
          // above succeeded on this attempt but the local transaction below failed on a *previous*
          // one) landing on an account this function already finished deleting. Idempotent --
          // the end state this call wanted already holds -- not an error.
          await client.query('rollback');
          return { outcome: 'deleted' };
        }

        const ownedProjects = await client.query<{ id: string; title: string }>(
          `select p.id, p.title
             from projects p
             join project_members m on m.project_id = p.id
            where m.user_id = $1 and m.role = 'owner' and p.deleted_at is null
            order by p.id
            for update of p`,
          [actorId],
        );

        const membersByProject = new Map<string, string[]>();
        if (ownedProjects.rowCount) {
          const memberRows = await client.query<{ projectId: string; userId: string }>(
            `select project_id as "projectId", user_id as "userId"
               from project_members
              where project_id = any($1)
              order by project_id, user_id
              for update`,
            [ownedProjects.rows.map((project) => project.id)],
          );
          for (const row of memberRows.rows) {
            const members = membersByProject.get(row.projectId) ?? [];
            members.push(row.userId);
            membersByProject.set(row.projectId, members);
          }
        }

        // Re-derived fresh, under the locks just taken, rather than reusing `refusal` from
        // before the Stripe call above: that result could be stale by now (a membership change,
        // however narrow a window -- see the lock-order comment above), and this is the set that
        // actually governs what gets written in this transaction, not merely the set the early
        // refusal gate decided on. This is deliberately **not** a second refusal check: if a
        // previously-solo project is found here to have gained a collaborator, and the flag is
        // `false`, that one project is simply excluded from the sweep below (left exactly as it
        // was) rather than aborting the whole request -- aborting here, after Stripe has already
        // succeeded, would be strictly worse than the narrow staleness this accepts, since it
        // would leave a cancelled subscription with nothing local to show for it. See
        // `progress/account-deletion-backend.md` for the full argument and the resulting state
        // (an owned project whose owner can never sign in again) named plainly as a known
        // consequence, not something this slice resolves.
        const projectIdsToDelete = ownedProjects.rows
          .filter((project) => {
            const members = membersByProject.get(project.id) ?? [actorId];
            const hasOtherMembers = members.some((userId) => userId !== actorId);
            return options.deleteOwnedProjectsWithCollaborators || !hasOtherMembers;
          })
          .map((project) => project.id);

        await client.query('delete from session where user_id = $1', [actorId]);
        await client.query(
          'update "user" set deleted_at = now(), updated_at = now() where id = $1',
          [actorId],
        );
        if (projectIdsToDelete.length > 0) {
          await client.query('update projects set deleted_at = now() where id = any($1)', [
            projectIdsToDelete,
          ]);
        }

        await client.query('commit');
        return { outcome: 'deleted' };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

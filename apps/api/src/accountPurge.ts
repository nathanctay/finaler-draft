import type { Pool, PoolClient } from 'pg';

/**
 * Account deletion's grace-period purge (progress/account-purge-cron.md, slice C). Account
 * deletion (`accountDeletion.ts`, slice B) marks an account deleted **immediately** -- sign-in
 * refused, every session gone, Stripe cancelled, its solo-owned (and, if the caller chose to,
 * collaborator-owned) projects soft-deleted -- and leaves the physical rows in place for a grace
 * window, so a mistaken or regretted deletion still has something to retrieve from. Nothing in
 * this codebase has removed any of those rows until this module. It is invoked on a schedule by a
 * Railway cron service (`.railway/railway.ts`'s `accountPurge` service, `accountPurgeCli.ts`), not
 * by any HTTP route -- there is no product-facing trigger for "purge now."
 *
 * **The ordering trap this module exists to get right.** `projects` has no owner column of its
 * own -- ownership is recorded only by a `project_members` row with `role = 'owner'`
 * (`schema.ts`), and `project_members.user_id` cascades the moment the `"user"` row it names is
 * deleted. So the instant `"user"` is gone, the one link that identified which projects belonged
 * to that account is gone with it -- not flagged, not orphaned in a way anything will ever find
 * again, just permanently unreachable rows on the volume. `purgeOneAccount` below reads that link
 * and deletes the account's owned, already-soft-deleted projects **before** deleting the `"user"`
 * row, in the same transaction, specifically so the identifying join is still there to run.
 * `accountPurge.integration.test.ts`'s "would orphan every owned project if the order were
 * reversed" proves this by swapping the two statements and watching the project survive
 * ownerless and unreachable, rather than merely asserting the comment is true.
 *
 * **What "the account's projects" means, precisely.** Only projects this account *owns*
 * (`project_members.role = 'owner'`) **and** that are already soft-deleted (`projects.deleted_at`
 * is not null) -- which, in the ordinary case, is every project slice B's own sweep already
 * touched at deletion time (every owned project if the collaborator flag was set; only the
 * solo-owned ones otherwise), plus any project the account had soft-deleted itself, independently,
 * before ever deleting the account. Hard-deleting one cascades (`schema.ts`'s own `onDelete:
 * 'cascade'` chain) to its `screenplays`, and from there to every `document_yjs_updates`,
 * `document_yjs_checkpoints`, `document_yjs_quarantined_updates`, and `document_revisions` row
 * those screenplays ever had -- **including retired-epoch rows**. That is deliberate, not an
 * oversight of the "retired epochs are load-bearing" rule the audit's DB-6 named: that rule
 * protects a *live* screenplay's history so a restore can still be replayed. A screenplay whose
 * owning account has been erased is not live by any definition this product uses -- it ceases to
 * exist, history included, which is what an erasure request actually asks for. See this module's
 * own "What this deliberately does not purge" section below for the screenplays this reasoning
 * does *not* reach.
 *
 * **The one accepted, pre-existing anomaly this module defends against rather than fixes.**
 * `accountDeletion.ts`'s own comment documents a narrow race: a collaborator accepted an
 * invitation in the gap between that transaction's membership read and its commit is not
 * reflected in the sweep, so that one project is left live and un-soft-deleted even though its
 * owner's account goes on to be deleted. This module never hard-deletes such a project -- it is
 * still in active use by other members who never asked for it to be removed, and this slice's own
 * "what NOT to purge" list is explicit that a live collaborator's access is never a casualty of
 * someone else's account deletion. `purgeOneAccount` finds these (an owned project with `deleted_
 * at is null`), logs a count and their ids so an operator can go look (there should be none; see
 * the progress doc for why this is defensive rather than expected), and leaves them untouched.
 * Once the owning `"user"` row is deleted, that project's `'owner'` `project_members` row cascades
 * away like everything else, leaving the project ownerless -- a strictly smaller problem than the
 * zombie-owner state `accountDeletion.ts` already accepted, and not one this slice attempts to
 * repair.
 *
 * **What this deliberately does not purge, and why.**
 *
 *  - **A live account's own soft-deleted projects and screenplays.** plan.md is explicit:
 *    "There is no retention window and nothing is purged... Introducing automatic purging later
 *    is a separate product decision." This module's every query is scoped through a soft-deleted
 *    *account* -- it never reads `projects.deleted_at`/`screenplays.deleted_at` for a project
 *    whose owner is not itself being purged. A live account's six-month-old deleted screenplay is
 *    untouched by anything in this file, proven directly in
 *    `accountPurge.integration.test.ts`'s "never touches a live account's own deleted project."
 *  - **Retired-epoch Yjs updates/checkpoints belonging to a live screenplay.** Covered above: the
 *    cascade this module triggers only ever starts from a purged account's own owned, soft-deleted
 *    project. No query here ever targets `document_yjs_updates`/`document_yjs_checkpoints`
 *    directly, by age or by epoch, for any other reason.
 *  - **Current-epoch checkpoint growth** (audit COL-2) is real but is not this module's problem to
 *    solve: a daily sweep is the wrong mechanism for it (plan.md's reconstruction path wants the
 *    latest checkpoint kept, not aged out), and the fix belongs inside `createCheckpoint` itself
 *    (`updateLog.ts`), not here. Named so its absence from this file reads as a decision, not an
 *    oversight.
 *  - **An account still inside its grace window.** `ACCOUNT_PURGE_GRACE_PERIOD_DAYS` below is the
 *    one place that boundary is written down, enforced by a single `<=` comparison in
 *    `findExpiredAccountIds`'s SQL, and tested at the boundary itself (`accountPurge.integration
 *    .test.ts`'s "just inside"/"just outside" pair) rather than only through a mock.
 *
 * **Dry run.** `run({ dryRun: true })` issues only `select count(*)` queries mirroring the exact
 * predicates the real deletes use, never opens a transaction, and never takes a lock -- an
 * operator can run it against production at any time with no risk and no write-lock contention.
 * Unlike the real run, dry run reports the **full** backlog for each category, not clipped to the
 * batch bound below -- the point of a dry run is to see the whole picture, including how large a
 * backlog has accumulated, not just what the next scheduled run would touch.
 *
 * **Bounded work per run, and why re-entering it on the next run is safe.** A first run against
 * an accumulated backlog must not open one unbounded transaction over the whole `"user"` table --
 * `ACCOUNT_PURGE_BATCH_SIZE` caps how many accounts a single run processes, each in its *own*
 * short transaction (see `purgeOneAccount`), and `HYGIENE_PURGE_BATCH_SIZE` caps each hygiene
 * category's single `delete` statement the same way. Re-entry is safe because the predicate that
 * selects work (`deleted_at <= cutoff`, `expires_at < now()`, and so on) only ever **shrinks** the
 * remaining backlog as rows are purged -- nothing un-deletes an account or un-expires a session,
 * so a capped run today simply leaves the oldest remainder for tomorrow's run to pick up, in the
 * same order (`order by deleted_at, id`), never growing unboundedly faster than real deletions
 * and expirations occur.
 *
 * **Idempotent.** Running this twice in immediate succession is safe and the second run is a
 * no-op: every query here is a plain predicate-based `select`/`delete`, not keyed on a request id
 * that could double-apply -- a row the first run already removed simply does not match the second
 * run's predicate. `accountPurge.integration.test.ts`'s "running twice in a row purges nothing the
 * second time" proves this for every category, not just argues it.
 *
 * **Lock ordering.** `purgeOneAccount` takes exactly one explicit row lock: `"user"`, with `for
 * update skip locked` (not a plain `for update`) as its first statement after `begin`. `skip
 * locked` -- not an advisory lock, and not a blocking wait -- is what keeps two purge runs that
 * happen to overlap (an operator running a dry run or a manual pass while the schedule also
 * fires; Railway's own cron contract otherwise prevents true overlap by skipping a trigger while
 * the previous run has not exited) from ever forming a lock-wait cycle with each other: the second
 * simply finds zero rows and moves on, rather than blocking on the first. No second account-level
 * lock is ever contended between two purge runs for *different* accounts either, because
 * `project_single_owner_unique` guarantees a project has exactly one owner -- two different
 * accounts' owned-project sets can never overlap, so there is no row either run's `delete from
 * projects` could be racing the other for. Beyond that one lock, `projects` and then `"user"` are
 * only ever *written* (`delete`), never separately locked with `for update` first -- the `delete`
 * statement itself takes whatever lock it needs, in the same order those two statements run,
 * which is "projects before user," agreeing with every other writer in this codebase
 * (`projects.ts`'s `deleteProject`/`renameProject`, `sharing.ts`'s `lockScope`/`fetchProjectRole`/
 * `transferOwnership`, and `accountDeletion.ts`'s own sweep) that already locks `projects` before
 * `project_members`. No advisory lock is taken: nothing else in this codebase can be concurrently
 * holding the `"user"` lock and waiting on a `projects` row this transaction wants (the deleted
 * account cannot itself be the actor behind any live request -- sign-in is refused and the
 * `isAccountDeleted` choke point re-checks it), so there is no existing cross-table order this
 * transaction's two writes could contradict.
 */

/** The grace window itself -- the single source of truth every reader of this module (code,
 * tests, the progress doc) should cite rather than restating "30 days" independently. */
export const ACCOUNT_PURGE_GRACE_PERIOD_DAYS = 30;

/** How long a processed Stripe webhook event id (`stripe_processed_events`, the dedupe ledger
 * `stripeWebhook.ts` consults on every delivery) is kept before this module purges it. Stripe
 * itself only ever redelivers a webhook for a bounded period after the original attempt, so
 * nothing in this product reads a row this old for its actual purpose (recognizing a retry); 90
 * days is kept anyway, well past any plausible redelivery or billing-dispute window, purely so an
 * operator debugging a billing issue has real history to read in the interim. */
export const STRIPE_PROCESSED_EVENT_RETENTION_DAYS = 90;

/** How long a `membership_invitations` row that has already resolved (`'accepted'` or
 * `'declined'`) is kept before this module purges it. `'pending'` rows are never touched by this
 * constant -- see `countOrPurgeStaleMembershipInvitations`'s own predicate -- because a pending
 * invitation is live state, not history. 90 days mirrors the Stripe retention window above for the
 * same reason: comfortably past the window anyone would plausibly need to look back at who was
 * invited to what and how they answered. */
export const MEMBERSHIP_INVITATION_RETENTION_DAYS = 90;

/** How many expired accounts a single run processes, each in its own transaction. See this
 * module's own doc comment, "Bounded work per run," for why a capped, re-entrant sweep is safe. */
export const ACCOUNT_PURGE_BATCH_SIZE = 200;

/** How many rows a single hygiene-category `delete` statement removes per run (`session`,
 * `verification`, `stripe_processed_events`, `membership_invitations`). Deliberately far larger
 * than `ACCOUNT_PURGE_BATCH_SIZE`: these are single-table, non-cascading deletes with no row locks
 * to hold across other work, so a larger bound costs one longer (but still bounded) statement
 * rather than many short transactions each paying their own round-trip and lock-acquisition cost. */
export const HYGIENE_PURGE_BATCH_SIZE = 5_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

export interface AccountPurgeCounts {
  accountsPurged: number;
  projectsPurged: number;
  /** Owned by a purged account but never hard-deleted because it was never soft-deleted in the
   * first place -- the narrow, documented race this module's own doc comment names. Expected to
   * be zero; logged and counted rather than silently absorbed into `projectsPurged` so a nonzero
   * value is visible without reading logs line by line. */
  ownedProjectsSkippedNotSoftDeleted: number;
  sessionsPurged: number;
  verificationsPurged: number;
  stripeProcessedEventsPurged: number;
  membershipInvitationsPurged: number;
}

export interface AccountPurgeOptions {
  /** `true` reports what would be purged and writes nothing -- see this module's own "Dry run"
   * doc comment. */
  dryRun: boolean;
  /** Injectable for tests that need to drive the grace-window boundary deterministically; a real
   * run always omits this and gets the wall clock. */
  now?: Date;
}

export interface AccountPurgeStore {
  run(options: AccountPurgeOptions): Promise<AccountPurgeCounts>;
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/**
 * Every account whose `deleted_at` is set and has elapsed `cutoff`, oldest first. `limit`
 * undefined means "every one of them" -- the dry-run shape, which reports the whole backlog
 * rather than one run's bounded slice of it (see this module's "Dry run" doc comment).
 */
async function findExpiredAccountIds(
  pool: Queryable,
  cutoff: Date,
  limit: number | undefined,
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    limit === undefined
      ? `select id from "user" where deleted_at is not null and deleted_at <= $1 order by deleted_at, id`
      : `select id from "user" where deleted_at is not null and deleted_at <= $1 order by deleted_at, id limit $2`,
    limit === undefined ? [cutoff] : [cutoff, limit],
  );
  return result.rows.map((row) => row.id);
}

interface OwnedProjectRow {
  id: string;
  deletedAt: Date | null;
}

/** Every project `userId` owns, soft-deleted or not -- the partition into "purge" versus "the
 * documented anomaly, skip" happens in `purgeOneAccount`, not here, so this helper stays a plain
 * read with no decision embedded in it. */
async function fetchOwnedProjects(db: Queryable, userId: string): Promise<OwnedProjectRow[]> {
  const result = await db.query<OwnedProjectRow>(
    `select p.id, p.deleted_at as "deletedAt"
       from projects p
       join project_members m on m.project_id = p.id
      where m.user_id = $1 and m.role = 'owner'
      order by p.id`,
    [userId],
  );
  return result.rows;
}

interface PurgeOneAccountResult {
  projectsPurged: number;
  ownedProjectsSkipped: number;
}

/**
 * Purges exactly one expired account: its owned, soft-deleted projects (cascading to every
 * screenplay and history row under them), then the `"user"` row itself (cascading to `session`,
 * `account`, `subscriptions`, `feedback`, `editable_slots`, remaining `project_members`/
 * `screenplay_members` rows on projects it does not own, and nulling the `set null` foreign keys
 * `document_yjs_updates.authenticated_actor_id`/`document_revisions.authored_by`/
 * `membership_invitations.invited_by_user_id`) -- in that order, in one transaction. See this
 * module's own top-of-file doc comment for the ordering trap this order avoids, and "Lock
 * ordering" for why no row lock beyond the initial `"user"` select is taken.
 *
 * Returns `undefined` when there was nothing for this call to do: the row was removed or locked
 * by a concurrently running purge (`for update skip locked` surfaces both as zero rows, which is
 * exactly the "another run already has this, move on" signal this function wants).
 */
async function purgeOneAccount(
  pool: Pool,
  userId: string,
): Promise<PurgeOneAccountResult | undefined> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const user = await client.query<{ deletedAt: Date | null }>(
      'select deleted_at as "deletedAt" from "user" where id = $1 for update skip locked',
      [userId],
    );
    if (user.rowCount !== 1) {
      await client.query('rollback');
      return undefined;
    }
    if (!user.rows[0]!.deletedAt) {
      // Not a reachable product state: `findExpiredAccountIds`'s own query only ever selects a
      // row with `deleted_at` already set, and nothing in this codebase clears it once set (there
      // is no "undelete an account" feature). Thrown, not silently skipped -- the identical reason
      // `accountDeletion.ts`'s "actorId did not resolve to an existing user row" guard throws
      // rather than returning a normal outcome a caller could mistake for "nothing to do."
      throw new Error(`accountPurge: user ${userId} was selected without deleted_at set.`);
    }

    const ownedProjects = await fetchOwnedProjects(client, userId);
    const toPurge = ownedProjects.filter((row) => row.deletedAt !== null).map((row) => row.id);
    const skipped = ownedProjects.filter((row) => row.deletedAt === null);

    if (skipped.length > 0) {
      // The one documented, accepted anomaly this module defends against -- see the top-of-file
      // doc comment's "one accepted, pre-existing anomaly" section. Logged at `warn`, with ids
      // (never titles or any other content), so an operator can find these without reading every
      // run's full output; expected to be zero in practice.
      console.warn(
        JSON.stringify({
          event: 'account_purge_owned_project_not_soft_deleted',
          userId,
          projectIds: skipped.map((row) => row.id),
        }),
      );
    }

    if (toPurge.length > 0) {
      // `and deleted_at is not null` repeats a predicate already true of every id in `toPurge` at
      // the moment `fetchOwnedProjects` read it, moments ago, inside this same transaction, under
      // no lock that could have let it change -- there is no code path that clears a project's
      // `deleted_at` once purge has already decided to delete it. Kept anyway as a direct,
      // statement-level guarantee rather than one resting entirely on that argument: deleting a
      // project this transaction never actually confirmed was soft-deleted would be exactly the
      // class of bug this slice's "what NOT to purge" rules exist to prevent.
      await client.query('delete from projects where id = any($1) and deleted_at is not null', [
        toPurge,
      ]);
    }
    await client.query('delete from "user" where id = $1', [userId]);

    await client.query('commit');
    return { projectsPurged: toPurge.length, ownedProjectsSkipped: skipped.length };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

interface AccountAndProjectCounts {
  accountsPurged: number;
  projectsPurged: number;
  ownedProjectsSkippedNotSoftDeleted: number;
}

/** The real run: processes up to `ACCOUNT_PURGE_BATCH_SIZE` expired accounts, each in its own
 * transaction via `purgeOneAccount`. */
async function purgeExpiredAccounts(pool: Pool, cutoff: Date): Promise<AccountAndProjectCounts> {
  const ids = await findExpiredAccountIds(pool, cutoff, ACCOUNT_PURGE_BATCH_SIZE);
  let accountsPurged = 0;
  let projectsPurged = 0;
  let ownedProjectsSkippedNotSoftDeleted = 0;
  for (const id of ids) {
    const result = await purgeOneAccount(pool, id);
    if (result === undefined) continue;
    accountsPurged += 1;
    projectsPurged += result.projectsPurged;
    ownedProjectsSkippedNotSoftDeleted += result.ownedProjectsSkipped;
  }
  return { accountsPurged, projectsPurged, ownedProjectsSkippedNotSoftDeleted };
}

/** The dry-run counterpart: the full backlog (unbounded by `ACCOUNT_PURGE_BATCH_SIZE`), counted
 * with plain `select count(*)` queries and no lock of any kind -- see this module's "Dry run" doc
 * comment for why dry run deliberately does not clip to the batch bound. */
async function countAccountsAndOwnedProjects(
  pool: Pool,
  cutoff: Date,
): Promise<AccountAndProjectCounts> {
  const accountIds = await findExpiredAccountIds(pool, cutoff, undefined);
  const result = await pool.query<{ toPurge: string; skipped: string }>(
    `select
        count(*) filter (where p.deleted_at is not null) as "toPurge",
        count(*) filter (where p.deleted_at is null) as "skipped"
       from projects p
       join project_members m on m.project_id = p.id and m.role = 'owner'
       join "user" u on u.id = m.user_id
      where u.deleted_at is not null and u.deleted_at <= $1`,
    [cutoff],
  );
  return {
    accountsPurged: accountIds.length,
    projectsPurged: Number(result.rows[0]?.toPurge ?? 0),
    ownedProjectsSkippedNotSoftDeleted: Number(result.rows[0]?.skipped ?? 0),
  };
}

async function countOrPurgeExpiredSessions(
  pool: Pool,
  now: Date,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    const result = await pool.query<{ count: string }>(
      'select count(*)::int as count from session where expires_at < $1',
      [now],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  const result = await pool.query(
    `delete from session
       where id in (
         select id from session where expires_at < $1 order by id limit $2
       )`,
    [now, HYGIENE_PURGE_BATCH_SIZE],
  );
  return result.rowCount ?? 0;
}

async function countOrPurgeExpiredVerifications(
  pool: Pool,
  now: Date,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    const result = await pool.query<{ count: string }>(
      'select count(*)::int as count from verification where expires_at < $1',
      [now],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  const result = await pool.query(
    `delete from verification
       where id in (
         select id from verification where expires_at < $1 order by id limit $2
       )`,
    [now, HYGIENE_PURGE_BATCH_SIZE],
  );
  return result.rowCount ?? 0;
}

async function countOrPurgeStaleStripeProcessedEvents(
  pool: Pool,
  cutoff: Date,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    const result = await pool.query<{ count: string }>(
      'select count(*)::int as count from stripe_processed_events where processed_at < $1',
      [cutoff],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  const result = await pool.query(
    `delete from stripe_processed_events
       where id in (
         select id from stripe_processed_events where processed_at < $1 order by id limit $2
       )`,
    [cutoff, HYGIENE_PURGE_BATCH_SIZE],
  );
  return result.rowCount ?? 0;
}

async function countOrPurgeStaleMembershipInvitations(
  pool: Pool,
  cutoff: Date,
  dryRun: boolean,
): Promise<number> {
  // `status in ('accepted', 'declined')` on both the counting and the purging query, never
  // `'pending'`: a pending invitation is live state a prospective member has not yet answered,
  // not history, and must never age out on its own. `membership_invitations_resolved_updated_at
  // _index` (schema.ts) is the partial index this predicate drives.
  if (dryRun) {
    const result = await pool.query<{ count: string }>(
      `select count(*)::int as count
         from membership_invitations
        where status in ('accepted', 'declined') and updated_at < $1`,
      [cutoff],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  const result = await pool.query(
    `delete from membership_invitations
       where id in (
         select id from membership_invitations
          where status in ('accepted', 'declined') and updated_at < $1
          order by id limit $2
       )`,
    [cutoff, HYGIENE_PURGE_BATCH_SIZE],
  );
  return result.rowCount ?? 0;
}

export function createPostgresAccountPurgeStore(pool: Pool): AccountPurgeStore {
  return {
    async run(options) {
      const now = options.now ?? new Date();
      const accountCutoff = daysBefore(now, ACCOUNT_PURGE_GRACE_PERIOD_DAYS);
      const stripeEventCutoff = daysBefore(now, STRIPE_PROCESSED_EVENT_RETENTION_DAYS);
      const invitationCutoff = daysBefore(now, MEMBERSHIP_INVITATION_RETENTION_DAYS);

      const accountCounts = options.dryRun
        ? await countAccountsAndOwnedProjects(pool, accountCutoff)
        : await purgeExpiredAccounts(pool, accountCutoff);

      const counts: AccountPurgeCounts = {
        ...accountCounts,
        sessionsPurged: await countOrPurgeExpiredSessions(pool, now, options.dryRun),
        verificationsPurged: await countOrPurgeExpiredVerifications(pool, now, options.dryRun),
        stripeProcessedEventsPurged: await countOrPurgeStaleStripeProcessedEvents(
          pool,
          stripeEventCutoff,
          options.dryRun,
        ),
        membershipInvitationsPurged: await countOrPurgeStaleMembershipInvitations(
          pool,
          invitationCutoff,
          options.dryRun,
        ),
      };

      // Structured, `{"event": "..."}`-shaped, matching every other log line this codebase
      // already writes (`accountDeletion.ts`'s own `console.error` calls, `app.ts`'s
      // `logStripeRequestFailure`). Counts and ids only -- never an email, a project title, or any
      // document content; every count above is a number, and the one place this module logs an id
      // (`purgeOneAccount`'s anomaly warning) logs opaque row ids, never anything a person wrote.
      console.log(
        JSON.stringify({
          event: options.dryRun ? 'account_purge_dry_run' : 'account_purge_completed',
          ...counts,
        }),
      );
      return counts;
    },
  };
}

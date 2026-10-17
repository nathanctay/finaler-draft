import type { Pool, PoolClient } from 'pg';
import { checkEntitlement, type EntitlementSnapshot } from '@finaler-draft/entitlements';
import type { SubscriptionStore } from './stripeSubscriptions.js';

export type SwitchEditableScreenplayResult =
  | { outcome: 'applied'; screenplayId: string; updatedAt: Date }
  | { outcome: 'cooldown' }
  | { outcome: 'not-a-candidate' };

export interface EntitlementStore {
  /** The full snapshot `checkEntitlement` needs to decide any action for this actor, as of `now`. */
  getSnapshot(actorId: string, now: Date): Promise<EntitlementSnapshot>;
  /**
   * Unconditionally claims the editable slot for `screenplayId`. Reserved for the one call site
   * where establishing the slot is not a "switch": `entitlementProjectStore.ts`'s `createScreenplay`
   * wrapper, immediately after a restricted account's `create-screenplay` action was allowed --
   * which `checkEntitlement` only allows when the account held zero candidates beforehand. There
   * is nothing to switch away from, so this bypasses the cooldown by construction rather than by
   * special-casing the cooldown check itself.
   */
  claimEmptySlot(actorId: string, screenplayId: string, now: Date): Promise<void>;
  /**
   * The user-facing "make this screenplay my editable one" action. Rejects a `screenplayId` that
   * is not a live owner/editor candidate for this actor (`'not-a-candidate'`, deliberately not
   * distinguished from "does not exist" -- the same information-hiding convention
   * `getScreenplay`/`updateScreenplay` in projects.ts already use for a non-member's request), and
   * enforces the cooldown via `checkEntitlement`'s `'switch-slot'` decision (`'cooldown'`).
   * Idempotent: re-choosing the screenplay already occupying the slot always succeeds without
   * touching the cooldown timer, since nothing is actually changing.
   */
  switchEditableScreenplay(
    actorId: string,
    screenplayId: string,
    now: Date,
  ): Promise<SwitchEditableScreenplayResult>;
}

// Structurally compatible with both `Pool` and `PoolClient` for the one method used here -- the
// same convention stripeSubscriptions.ts's `markProcessed` uses, so a caller inside an existing
// transaction can pass its `client` and a caller with no transaction of its own can pass the bare
// `pool`.
type Queryable = Pick<PoolClient, 'query'>;

// The universe the single editable slot is drawn from: every screenplay where the actor holds an
// editing-capable role (owner or editor -- a reviewer cannot write regardless of billing state,
// so a reviewer-role screenplay can never occupy or contend for the slot), on a live screenplay
// under a live project. Ordered by creation so results are deterministic for tests and logs, not
// because order is policy-relevant.
//
// The screenplay-invitations slice adds the second branch: a screenplay-scoped editor's screenplay
// is a candidate too. That is plan.md's entitlement design read literally -- "A free account
// **invited** to a screenplay may edit it by making it the one screenplay it holds editable" --
// and without it an invited free account could accept an invitation and then find the screenplay
// permanently read-only, because `checkEntitlement` can only put a *candidate* in the slot.
//
// A `union` of two index-driven queries rather than a `cross join lateral` over `screenplays`:
// unlike every single-screenplay lookup in this slice, this query has no screenplay id to start
// from, so a lateral would have nothing to drive it but a full scan of every screenplay in the
// installation. Each branch here is driven by its own membership index
// (`project_members_user_id_index`, `screenplay_members_user_id_index`), exactly as the single
// query it replaces was. `union`, not `union all`, so a screenplay reachable both ways appears
// once.
//
// Most-privileged-wins (`screenplayRoleLateral`'s rule) is preserved rather than re-implemented: a
// project editor who also holds a screenplay-scoped `reviewer` row is still a candidate via the
// first branch, and a project reviewer who holds a screenplay-scoped `editor` row is a candidate
// via the second. There is no combination this admits that the lateral would deny, or vice versa.
async function fetchCandidateScreenplayIds(
  queryable: Queryable,
  actorId: string,
): Promise<string[]> {
  const result = await queryable.query(
    `select id
       from (
         select s.id, s.created_at
           from screenplays s
           join project_members m on m.project_id = s.project_id
           join projects p on p.id = s.project_id
          where m.user_id = $1
            and m.role in ('owner', 'editor')
            and s.deleted_at is null
            and p.deleted_at is null
         union
         select s.id, s.created_at
           from screenplays s
           join screenplay_members sm on sm.screenplay_id = s.id
           join projects p on p.id = s.project_id
          where sm.user_id = $1
            and sm.role = 'editor'
            and s.deleted_at is null
            and p.deleted_at is null
       ) candidates
      order by created_at asc`,
    [actorId],
  );
  return (result.rows as Array<{ id: string }>).map((row) => row.id);
}

async function fetchSlot(
  queryable: Queryable,
  actorId: string,
): Promise<{ screenplayId: string; updatedAt: Date } | null> {
  const result = await queryable.query(
    'select screenplay_id as "screenplayId", updated_at as "updatedAt" from editable_slots where user_id = $1',
    [actorId],
  );
  const row = result.rows[0] as { screenplayId: string; updatedAt: Date } | undefined;
  return row ? { screenplayId: row.screenplayId, updatedAt: new Date(row.updatedAt) } : null;
}

async function upsertSlot(
  queryable: Queryable,
  actorId: string,
  screenplayId: string,
  now: Date,
): Promise<void> {
  await queryable.query(
    `insert into editable_slots (user_id, screenplay_id, updated_at)
     values ($1, $2, $3)
     on conflict (user_id) do update set
       screenplay_id = excluded.screenplay_id,
       updated_at = excluded.updated_at`,
    [actorId, screenplayId, now],
  );
}

export function createPostgresEntitlementStore(
  pool: Pool,
  subscriptions: Pick<SubscriptionStore, 'getSubscriptionForUser'>,
): EntitlementStore {
  return {
    async getSnapshot(actorId, now) {
      // Three independent reads against the shared pool -- not a transaction, matching the
      // non-transactional read style the rest of this layer already uses for listings
      // (projects.ts's listProjects/listScreenplays). A momentary skew between them under
      // concurrent modification is the same tolerated imprecision those reads already accept.
      const [subscription, candidateScreenplayIds, slot] = await Promise.all([
        subscriptions.getSubscriptionForUser(actorId),
        fetchCandidateScreenplayIds(pool, actorId),
        fetchSlot(pool, actorId),
      ]);
      return {
        subscriptionStatus: subscription?.status,
        candidateScreenplayIds,
        slot,
        now,
      };
    },
    async claimEmptySlot(actorId, screenplayId, now) {
      await upsertSlot(pool, actorId, screenplayId, now);
    },
    async switchEditableScreenplay(actorId, screenplayId, now) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Locks this actor's slot row (if any) for the duration of the decision, so two
        // concurrent switch requests for the same account cannot both read the same
        // pre-switch `updatedAt` and both believe the cooldown has elapsed.
        const slotRows = await client.query(
          'select screenplay_id as "screenplayId", updated_at as "updatedAt" from editable_slots where user_id = $1 for update',
          [actorId],
        );
        const slotRow = slotRows.rows[0] as { screenplayId: string; updatedAt: Date } | undefined;
        const slot = slotRow
          ? { screenplayId: slotRow.screenplayId, updatedAt: new Date(slotRow.updatedAt) }
          : null;
        const candidateScreenplayIds = await fetchCandidateScreenplayIds(client, actorId);
        if (!candidateScreenplayIds.includes(screenplayId)) {
          await client.query('rollback');
          return { outcome: 'not-a-candidate' };
        }
        if (slot?.screenplayId === screenplayId) {
          // Idempotent: re-choosing the current slot changes nothing, so it always succeeds and
          // never touches the cooldown timer -- the reported `updatedAt` is the existing one,
          // not `now`, since nothing was actually written.
          await client.query('commit');
          return { outcome: 'applied', screenplayId, updatedAt: slot.updatedAt };
        }
        const subscription = await subscriptions.getSubscriptionForUser(actorId);
        const decision = checkEntitlement(
          { subscriptionStatus: subscription?.status, candidateScreenplayIds, slot, now },
          { type: 'switch-slot', screenplayId },
        );
        if (!decision.allowed) {
          await client.query('rollback');
          return { outcome: 'cooldown' };
        }
        await upsertSlot(client, actorId, screenplayId, now);
        await client.query('commit');
        return { outcome: 'applied', screenplayId, updatedAt: now };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

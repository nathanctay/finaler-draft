import type { SubscriptionStatus } from './stripeSubscriptions.js';

/**
 * plan.md's "The free tier" / "What happens when a subscription lapses": an account is either
 * fully entitled (`'paid'`, an active or trialing Stripe subscription) or restricted to a single
 * editable screenplay (`'restricted'`) -- and a *missing* subscription row is deliberately
 * indistinguishable from a lapsed one here. Both the never-subscribed free account and the
 * cancelled-or-past-due lapsed account are "restricted" by the identical rule set; plan.md is
 * explicit that a lapse "drops the account to the free tier," not to some third state.
 */
export type EntitlementTier = 'paid' | 'restricted';

const PAID_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(['active', 'trialing']);

/** `undefined` means no subscription row exists for this user -- the common case, and by design
 * not an error (see stripeSubscriptions.ts's `getSubscriptionForUser`). */
export function tierForSubscriptionStatus(status: SubscriptionStatus | undefined): EntitlementTier {
  return status !== undefined && PAID_STATUSES.has(status) ? 'paid' : 'restricted';
}

/**
 * Switching the editable slot is rate-limited by a cooldown, not a quota of switches -- the
 * owner's explicit instruction is that both the mechanic (a cooldown) and this interval are
 * estimates until real writers meet them, so changing 24 hours to 72 must be a one-line edit.
 * This constant, and `checkEntitlement`'s single `'switch-slot'` branch below, are the one place
 * that edit needs to happen.
 */
export const EDITABLE_SLOT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Everything `checkEntitlement` needs to decide one request. Deliberately plain data -- no
 * database handle, no clock read inside the function -- so every state in the policy's test
 * matrix (free with none, free with one, a share beyond the slot, an active subscription, a
 * lapse with one screenplay, a lapse with several and no choice made, a lapse after choosing, the
 * cooldown inside and outside its window) is just a literal object, not a fixture that has to be
 * arranged against a fake database.
 */
export interface EntitlementSnapshot {
  subscriptionStatus: SubscriptionStatus | undefined;
  /**
   * The screenplays this account could edit *if* entitled to: every screenplay where the actor
   * holds the `owner` or `editor` project role, on a live (non-soft-deleted) screenplay under a
   * live project. This is the exact universe the single editable slot is drawn from -- a
   * `reviewer`-role screenplay is never a candidate, because a reviewer cannot write to it
   * regardless of billing state, so it can never occupy or contend for the slot.
   */
  candidateScreenplayIds: readonly string[];
  /** The explicit choice on record, or `null` if this account has never needed to make one. */
  slot: { screenplayId: string; updatedAt: Date } | null;
  now: Date;
}

export type EntitlementAction =
  | { type: 'create-screenplay' }
  | { type: 'edit-screenplay'; screenplayId: string }
  | { type: 'switch-slot'; screenplayId: string };

export type EntitlementDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: // create-screenplay: already holds a screenplay counting against the one-editable-slot limit.
      | 'free-tier-limit'
        // edit-screenplay: this screenplay exists and is a candidate, but it is not the one
        // occupying the slot -- plan.md's "readable, not writable," never an error or a blank wall.
        | 'not-in-slot'
        // edit-screenplay: several candidates exist and none has been chosen yet -- plan.md: "the
        // system must never choose on the user's behalf ... until the user chooses ... none is
        // editable."
        | 'no-slot-chosen'
        // switch-slot: the 24-hour cooldown since the last change has not elapsed.
        | 'cooldown';
    };

/**
 * The one function this entitlement layer's authorization decisions all pass through. plan.md
 * requires entitlement to be "a server-side authorization check, evaluated in the same layer as
 * project and screenplay authorization" -- never a client-side flag, a route guard, or a query
 * cache -- and the owner separately asked for the switch-slot cooldown to live in exactly one
 * function so its interval is a one-line change. Both are satisfied by having a single function
 * own every entitlement decision this slice makes, rather than scattering the free-tier count
 * check, the slot-membership check, and the cooldown check across three call sites that could
 * drift out of sync with each other.
 *
 * A paid subscription (`'active'` or `'trialing'`) short-circuits to `{ allowed: true }` for
 * every action before any of the slot logic below runs -- the editable slot exists only to
 * arbitrate a *restricted* account's single edit right, and has no meaning for a paid one.
 */
export function checkEntitlement(
  snapshot: EntitlementSnapshot,
  action: EntitlementAction,
): EntitlementDecision {
  const tier = tierForSubscriptionStatus(snapshot.subscriptionStatus);
  if (tier === 'paid') return { allowed: true };

  switch (action.type) {
    case 'create-screenplay':
      // "A free account cannot create a second screenplay, and cannot hold more than one
      // editable at a time" -- creation is gated purely on whether the slot's universe is
      // already occupied by *any* candidate, owned or shared in. A brand-new account with zero
      // candidates may create its first (and only) screenplay.
      return snapshot.candidateScreenplayIds.length === 0
        ? { allowed: true }
        : { allowed: false, reason: 'free-tier-limit' };

    case 'edit-screenplay': {
      const editableId = resolveEditableScreenplayId(snapshot);
      if (editableId === null) return { allowed: false, reason: 'no-slot-chosen' };
      return editableId === action.screenplayId
        ? { allowed: true }
        : { allowed: false, reason: 'not-in-slot' };
    }

    case 'switch-slot':
      // Cooldown only, deliberately: whether `action.screenplayId` is actually a legitimate
      // candidate (owned or shared in) is a membership question the caller resolves before ever
      // reaching this policy, the same way every other authorization check in this codebase
      // resolves membership ahead of the decision it gates. "No exception for newly shared
      // screenplays": a `null` `snapshot.slot` (nothing chosen yet) is the only case that bypasses
      // the cooldown, and that is establishment, not a switch -- there is nothing to switch away
      // from.
      if (
        snapshot.slot &&
        snapshot.now.getTime() - snapshot.slot.updatedAt.getTime() < EDITABLE_SLOT_COOLDOWN_MS
      ) {
        return { allowed: false, reason: 'cooldown' };
      }
      return { allowed: true };
  }
}

/**
 * The screenplay a restricted account may currently edit, or `null` when none is (plan.md:
 * "Until the user chooses, all screenplays are readable and exportable and none is editable").
 * Exported alongside `checkEntitlement` because the read-side API (reporting entitlement state to
 * a future UI) needs the same resolution `checkEntitlement`'s `'edit-screenplay'` branch uses
 * internally, without needing to know which specific screenplay id to ask about.
 *
 * An explicit `slot` wins whenever it still names a live candidate. Otherwise, resolution is
 * unambiguous only when there is exactly one candidate -- not because a row was written, but
 * because there was never a choice to make: "must be asked which one stays editable" only applies
 * when there is more than one candidate and nothing chosen among them.
 */
export function resolveEditableScreenplayId(snapshot: EntitlementSnapshot): string | null {
  if (snapshot.slot && snapshot.candidateScreenplayIds.includes(snapshot.slot.screenplayId)) {
    return snapshot.slot.screenplayId;
  }
  return snapshot.candidateScreenplayIds.length === 1 ? snapshot.candidateScreenplayIds[0]! : null;
}

/** Thrown by the entitlement-enforcing `ProjectStore` decorator (entitlementProjectStore.ts) when
 * `checkEntitlement` refuses a `create-screenplay` action -- a distinct type from `ForbiddenError`
 * (projects.ts) so app.ts can tell a billing-driven refusal apart from a plain membership one and
 * report each with its own, accurate message. */
export class EntitlementLimitError extends Error {}

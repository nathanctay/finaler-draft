import {
  EntitlementLimitError,
  checkEntitlement,
  tierForSubscriptionStatus,
} from './entitlements.js';
import type { EntitlementStore } from './entitlementStore.js';
import type { ProjectStore } from './projects.js';

/**
 * Wraps a `ProjectStore` so every screenplay-content write passes through the entitlement policy
 * before it reaches the underlying store -- plan.md: entitlement is "evaluated in the same layer
 * as project and screenplay authorization," and this is that layer's composition point. A
 * decorator, not a rewrite of `createPostgresProjectStore`'s own methods, deliberately: every
 * other `ProjectStore` method (listing, renaming, deleting, restoring, reading) is untouched, both
 * in behaviour and in the exact SQL its existing unit tests assert against, because plan.md scopes
 * the restriction to "creating new screenplays beyond that one, and editing the others" -- content
 * creation and content edits, not the library-management operations around them. A screenplay
 * outside the slot can still be renamed, deleted, or restored by an owner/editor; it just cannot
 * be written to.
 *
 * Gates exactly two operations:
 * - `createScreenplay`: refused outright (before the underlying store is ever called) once a
 *   restricted account already holds a candidate screenplay. On success, if the account is
 *   restricted, the newly created screenplay unconditionally claims the (necessarily empty) slot --
 *   see entitlementStore.ts's `claimEmptySlot` for why that is an establishment, not a switch, and
 *   does not touch the cooldown.
 * - `updateScreenplay`: refused with the store's own existing `'forbidden'` outcome when the
 *   target is a live candidate for this actor but is not the one occupying the slot. A target the
 *   actor is not an owner/editor candidate for at all is passed straight through to the underlying
 *   store instead, so a non-member's or a reviewer's request gets exactly the same `'missing'` /
 *   `'forbidden'` response it always has -- this layer never turns a membership question into a
 *   billing one, and never lets billing state leak whether a screenplay exists to someone who
 *   cannot already see it.
 */
export function createEntitlementEnforcedProjectStore(
  base: ProjectStore,
  entitlements: Pick<EntitlementStore, 'getSnapshot' | 'claimEmptySlot'>,
  // Injectable purely for deterministic tests; defaults to the real clock everywhere else.
  now: () => Date = () => new Date(),
): ProjectStore {
  return {
    ...base,
    async createScreenplay(actorId, projectId, input) {
      const at = now();
      const snapshot = await entitlements.getSnapshot(actorId, at);
      const decision = checkEntitlement(snapshot, { type: 'create-screenplay' });
      if (!decision.allowed) {
        throw new EntitlementLimitError(
          'Free tier limit reached: only one editable screenplay is allowed. Choose an existing one to keep editing, or upgrade to create another.',
        );
      }
      const created = await base.createScreenplay(actorId, projectId, input);
      if (tierForSubscriptionStatus(snapshot.subscriptionStatus) === 'restricted') {
        await entitlements.claimEmptySlot(actorId, created.id, at);
      }
      return created;
    },
    async updateScreenplay(actorId, screenplayId, input) {
      const at = now();
      const snapshot = await entitlements.getSnapshot(actorId, at);
      if (snapshot.candidateScreenplayIds.includes(screenplayId)) {
        const decision = checkEntitlement(snapshot, { type: 'edit-screenplay', screenplayId });
        if (!decision.allowed) return 'forbidden';
      }
      return base.updateScreenplay(actorId, screenplayId, input);
    },
  };
}

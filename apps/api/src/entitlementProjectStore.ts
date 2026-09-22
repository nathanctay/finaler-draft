import {
  EntitlementLimitError,
  checkEntitlement,
  tierForSubscriptionStatus,
} from '@finaler-draft/entitlements';
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
 * Gates exactly one operation now: `createScreenplay`, refused outright (before the underlying
 * store is ever called) once a restricted account already holds a candidate screenplay. On
 * success, if the account is restricted, the newly created screenplay unconditionally claims the
 * (necessarily empty) slot -- see entitlementStore.ts's `claimEmptySlot` for why that is an
 * establishment, not a switch, and does not touch the cooldown.
 *
 * `updateScreenplay` used to be gated here too, refusing a REST write to a screenplay outside the
 * account's editable slot. That REST write no longer exists (collaboration slice 1: the canonical
 * screenplay is a projection of the Yjs document `apps/collab` maintains, not a client `PUT` --
 * see `progress/collaboration-slice-1.md`), and the identical entitlement check now happens on
 * the one write path that remains, the WebSocket connection itself
 * (`apps/collab/src/authenticate.ts`'s `resolveConnectionAuthorization`, reusing this same
 * `checkEntitlement` policy). A screenplay outside the slot can still be renamed, deleted, or
 * restored by an owner/editor over REST; it just cannot be edited.
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
  };
}

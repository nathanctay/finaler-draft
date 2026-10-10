import type { Pool } from 'pg';
import { z } from 'zod';
import { checkEntitlement } from '@finaler-draft/entitlements';
import {
  computeRevisionPreviewMetadata,
  screenplaySchema,
  screenplayToPlainText,
} from '@finaler-draft/screenplay';
import {
  getRevisionById,
  restoreRevisionAsCurrent,
  type DeriveRevisionFields,
  type RestoreRevisionAsCurrentResult,
} from '@finaler-draft/database';
import { canEdit, resolveMembership } from './revisions.js';
import type { EntitlementStore } from './entitlementStore.js';

/**
 * Collaboration slice 5: the authorized, confirmed half of restore-as-current (plan.md's "Restore as
 * current", steps 1 and 3). The transaction itself lives in `@finaler-draft/database`'s
 * `restoreRevisionAsCurrent` -- see that module's own comment for the cutover's exact contents and
 * why no Yjs state is written there. This file is the policy around it:
 *
 *  - **Authorization.** Owner or editor only, the same bar `createRevision`'s `named` kind,
 *    `renameScreenplay`, and `deleteScreenplay` already set. A reviewer gets 403 and a non-member
 *    gets 404, matching the information-hiding convention the rest of this API uses.
 *  - **Confirmation.** Step 1's "an authorized owner/editor previews a screenplay-aware diff and
 *    confirms the target revision" is a two-part requirement, and only the second part is server
 *    side: this endpoint is reached exclusively from an explicit confirmation (`apps/web`'s
 *    `restoreRevisionDialog.tsx`), and it requires a client-generated `restoreRequestId` plus the
 *    `expectedEpoch` the client was looking at. There is no way to trigger a cutover with a bare
 *    `POST` carrying no evidence of which document state was confirmed. The diff preview itself
 *    lives on an unmerged branch (`feature/screenplay-diff`) and is deliberately not depended on
 *    here; `restoreRevisionDialog.tsx` carries the one wiring point for its link.
 *  - **Entitlement.** A restore writes the live document, so it is gated by the identical
 *    `edit-screenplay` decision `apps/collab/src/authenticate.ts` resolves for a WebSocket
 *    connection: a restricted-tier account whose one editable slot is some *other* screenplay cannot
 *    restore this one, and gets the same 402 the free-tier limit already produces elsewhere. Without
 *    this, restore would be a way to write a screenplay the collaboration server would refuse every
 *    keystroke for.
 *  - **Readability of the target.** The source revision's canonical projection is parsed against
 *    `screenplaySchema` *before* the transaction runs, so a revision this editor could not represent
 *    is refused outright instead of being installed as the live document and discovered later by
 *    whoever opens it.
 */

export const restoreRevisionInput = z
  .object({
    /** The epoch the confirming client believed was current. See
     * `RestoreRevisionAsCurrentParams.expectedEpoch`. */
    expectedEpoch: z.number().int().min(0),
    /** The idempotency key. Generated once by the client when the confirmation dialog opens, so a
     * retried or double-submitted confirmation carries the identical value -- see
     * `documentRevisions.restoreRequestId`'s schema comment for why the key has to come from the
     * client rather than being inferred server-side. */
    restoreRequestId: z.string().uuid(),
  })
  .strict();
export type RestoreRevisionInput = z.infer<typeof restoreRevisionInput>;

export interface RestoreSuccess {
  epoch: number;
  previousEpoch: number;
  restoreRevisionId: string;
  canonicalHash: string;
  previousHeadRevisionId: string | null;
  /** `false` for the idempotent replay of an already-committed restore. */
  created: boolean;
}

export type RestoreResult =
  | RestoreSuccess
  | 'missing'
  | 'forbidden'
  /** Membership and role are fine, but this account's entitlement does not permit editing this
   * screenplay -- the same decision that makes its collaboration connection read-only. */
  | 'entitlement-required'
  | 'unreadable-revision'
  /** The screenplay's epoch is not the one the confirming client believed was current -- another
   * restore landed in between. See `restoreRevisionInput.expectedEpoch`. */
  | 'stale-epoch'
  | 'request-id-conflict';

export interface RestoreStore {
  restoreRevision(
    actorId: string,
    screenplayId: string,
    revisionId: string,
    input: RestoreRevisionInput,
  ): Promise<RestoreResult>;
}

/**
 * The `derive` callback `restoreRevisionAsCurrent` needs for the prior-head capture -- the two
 * revision columns (`rendered_text`, `preview_metadata`) that `packages/database` cannot compute
 * without depending on `@finaler-draft/screenplay`. Returns `undefined` when the live canonical
 * projection does not parse, which the transaction treats as "cannot capture the prior head as its
 * own revision" rather than a reason to refuse the restore: the retired epoch's update log still
 * holds that content, and refusing to restore *because the live document is unreadable* would block
 * the one operation most likely to fix it.
 */
function deriveRevisionFields(screenplayId: string): DeriveRevisionFields {
  return (canonicalScreenplay) => {
    const parsed = screenplaySchema.safeParse(canonicalScreenplay);
    if (!parsed.success) {
      console.error(JSON.stringify({ event: 'restore_pre_restore_capture_skipped', screenplayId }));
      return undefined;
    }
    return {
      renderedText: screenplayToPlainText(parsed.data),
      previewMetadata: computeRevisionPreviewMetadata(parsed.data),
    };
  };
}

function toResult(outcome: RestoreRevisionAsCurrentResult): RestoreResult {
  switch (outcome.outcome) {
    case 'restored':
      return {
        canonicalHash: outcome.canonicalHash,
        created: outcome.created,
        epoch: outcome.epoch,
        previousEpoch: outcome.previousEpoch,
        previousHeadRevisionId: outcome.previousHeadRevisionId,
        restoreRevisionId: outcome.restoreRevisionId,
      };
    case 'screenplay-missing':
    case 'revision-missing':
      return 'missing';
    case 'epoch-conflict':
      return 'stale-epoch';
    case 'request-id-conflict':
      return 'request-id-conflict';
  }
}

export function createPostgresRestoreStore(
  pool: Pool,
  entitlements: Pick<EntitlementStore, 'getSnapshot'>,
  // Injectable purely for deterministic tests, matching `createEntitlementEnforcedProjectStore`'s
  // own convention; defaults to the real clock everywhere else.
  now: () => Date = () => new Date(),
): RestoreStore {
  return {
    async restoreRevision(actorId, screenplayId, revisionId, input) {
      const membership = await resolveMembership(pool, screenplayId, actorId);
      if (membership === 'missing') return 'missing';
      if (!canEdit(membership.role)) return 'forbidden';

      const at = now();
      const decision = checkEntitlement(await entitlements.getSnapshot(actorId, at), {
        screenplayId,
        type: 'edit-screenplay',
      });
      if (!decision.allowed) return 'entitlement-required';

      const source = await getRevisionById(pool, screenplayId, revisionId);
      if (!source) return 'missing';
      // Checked before the transaction opens, never inside it: a revision whose canonical projection
      // cannot be parsed must not become the live document, and finding that out after the epoch has
      // already moved would mean a cutover to a screenplay nobody can open.
      if (!screenplaySchema.safeParse(source.canonicalScreenplay).success) {
        return 'unreadable-revision';
      }

      return toResult(
        await restoreRevisionAsCurrent(pool, {
          actorId,
          derive: deriveRevisionFields(screenplayId),
          expectedEpoch: input.expectedEpoch,
          restoreRequestId: input.restoreRequestId,
          screenplayId,
          sourceRevisionId: revisionId,
        }),
      );
    },
  };
}

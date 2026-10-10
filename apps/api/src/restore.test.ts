import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computeRevisionPreviewMetadata, screenplayToPlainText } from '@finaler-draft/screenplay';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { EntitlementSnapshot } from '@finaler-draft/entitlements';

/**
 * Collaboration slice 5 (plan.md's "Restore as current"), at the layer that owns the *policy*:
 * authorization, confirmation, entitlement, and refusing a target this editor could not open. The
 * cutover transaction itself is `@finaler-draft/database`'s and is proven against a real database in
 * `packages/database/src/restore.integration.test.ts`; mocking it here is the same
 * separation-of-concerns convention `revisions.test.ts` already uses, and it is what makes each
 * assertion below about exactly one decision.
 *
 * The question this file answers that no other suite does: for each refusal, was the transaction
 * even reached? A policy that returned the right string *after* performing the cutover would pass a
 * status-code test and be a catastrophe, so every refusal below also asserts that
 * `restoreRevisionAsCurrent` was never called.
 */
vi.mock('@finaler-draft/database', () => ({
  getRevisionById: vi.fn(),
  restoreRevisionAsCurrent: vi.fn(),
}));

import { getRevisionById, restoreRevisionAsCurrent } from '@finaler-draft/database';
import { createPostgresRestoreStore, restoreRevisionInput } from './restore.js';

const mockGetRevisionById = getRevisionById as ReturnType<typeof vi.fn>;
const mockRestore = restoreRevisionAsCurrent as ReturnType<typeof vi.fn>;

const actorId = 'actor-1';
const screenplayId = 'ecf1118c-3a2e-4656-84e6-fce75c461710';
const revisionId = '2f3b4a0e-1111-4111-8111-111111111111';
const now = new Date('2026-09-04T12:00:00Z');
const input = { expectedEpoch: 0, restoreRequestId: '9d2f1c1a-2222-4222-8222-222222222222' };

function rows(values: Record<string, unknown>[]) {
  return { rowCount: values.length, rows: values };
}

/** One `query` call per `resolveMembership`; nothing else in `restore.ts` touches the pool. */
function fakePool(membership: Record<string, unknown>[]) {
  return { query: vi.fn(async () => rows(membership)) } as never;
}

/** `EntitlementStore['getSnapshot']`'s shape, answering whatever `checkEntitlement` should see.
 * A paid subscription is `{allowed: true}` unconditionally; the restricted-tier cases below vary
 * `candidateScreenplayIds`/`slot` instead, exactly as `entitlementStore.ts` would. */
function entitlements(snapshot: Partial<EntitlementSnapshot>) {
  return {
    getSnapshot: vi.fn(
      async (_actorId: string, at: Date): Promise<EntitlementSnapshot> => ({
        candidateScreenplayIds: [screenplayId],
        slot: null,
        subscriptionStatus: 'active',
        now: at,
        ...snapshot,
      }),
    ),
  };
}

const restored = {
  outcome: 'restored' as const,
  created: true,
  epoch: 1,
  previousEpoch: 0,
  restoreRevisionId: 'a1b2c3d4-3333-4333-8333-333333333333',
  canonicalHash: 'c'.repeat(64),
  previousHeadRevisionId: 'b1b2c3d4-4444-4444-8444-444444444444',
};

beforeEach(() => {
  mockGetRevisionById.mockReset();
  mockRestore.mockReset();
});

describe('restoreRevisionInput', () => {
  it('accepts an epoch and a uuid request id', () => {
    expect(restoreRevisionInput.parse(input)).toEqual(input);
  });

  /**
   * `restoreRequestId` is the idempotency key, and the whole mechanism depends on it being a value
   * the client can reproduce on a retry. A non-uuid is rejected at the edge rather than stored as the
   * unique key for a cutover.
   */
  it('rejects a missing, non-uuid, or non-integer field, and any extra field', () => {
    for (const payload of [
      {},
      { expectedEpoch: 0 },
      { restoreRequestId: input.restoreRequestId },
      { expectedEpoch: -1, restoreRequestId: input.restoreRequestId },
      { expectedEpoch: 1.5, restoreRequestId: input.restoreRequestId },
      { expectedEpoch: '0', restoreRequestId: input.restoreRequestId },
      { expectedEpoch: 0, restoreRequestId: 'not-a-uuid' },
      { ...input, kind: 'named' },
    ]) {
      expect(() => restoreRevisionInput.parse(payload)).toThrow();
    }
  });
});

describe('restoreRevision authorization', () => {
  /** plan.md step 1: "an authorized owner/editor ... confirms the target revision." */
  it.each(['owner', 'editor'])(
    'lets a %s restore, and reports the cutover it performed',
    async (role) => {
      mockGetRevisionById.mockResolvedValue({ canonicalScreenplay: screenplayFixture });
      mockRestore.mockResolvedValue(restored);
      const store = createPostgresRestoreStore(fakePool([{ role }]), entitlements({}), () => now);

      await expect(
        store.restoreRevision(actorId, screenplayId, revisionId, input),
      ).resolves.toEqual({
        canonicalHash: restored.canonicalHash,
        created: true,
        epoch: 1,
        previousEpoch: 0,
        previousHeadRevisionId: restored.previousHeadRevisionId,
        restoreRevisionId: restored.restoreRevisionId,
      });
      // The client's claim about which epoch it confirmed against is passed through to the transaction
      // as a claim to be checked, never used as the value to write.
      expect(mockRestore).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorId,
          expectedEpoch: 0,
          restoreRequestId: input.restoreRequestId,
          screenplayId,
          sourceRevisionId: revisionId,
        }),
      );
    },
  );

  /**
   * A reviewer is the case this slice must get right: they can read every revision in history and
   * open any of them in the preview, so "may see it" must not be mistaken for "may make it current".
   * 403, not 404 -- they are a member, and pretending the screenplay does not exist for an account
   * that can plainly see it would be a worse answer, matching the convention the rest of this API
   * uses.
   */
  it('refuses a reviewer without reaching the transaction', async () => {
    const store = createPostgresRestoreStore(
      fakePool([{ role: 'reviewer' }]),
      entitlements({}),
      () => now,
    );
    await expect(store.restoreRevision(actorId, screenplayId, revisionId, input)).resolves.toBe(
      'forbidden',
    );
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockGetRevisionById).not.toHaveBeenCalled();
  });

  it('reports a non-member, a soft-deleted screenplay, and a deleted parent project identically as missing', async () => {
    const store = createPostgresRestoreStore(fakePool([]), entitlements({}), () => now);
    await expect(store.restoreRevision(actorId, screenplayId, revisionId, input)).resolves.toBe(
      'missing',
    );
    expect(mockRestore).not.toHaveBeenCalled();
  });

  /**
   * A restore writes the live document, so it is gated by the identical `edit-screenplay` decision
   * `apps/collab/src/authenticate.ts` resolves for a WebSocket connection. Without this, restore
   * would be a way to write a screenplay the collaboration server would refuse every keystroke for.
   */
  it('refuses a restricted-tier editor whose one editable slot is a different screenplay', async () => {
    const otherScreenplayId = '7a7a7a7a-5555-4555-8555-555555555555';
    const store = createPostgresRestoreStore(
      fakePool([{ role: 'editor' }]),
      entitlements({
        subscriptionStatus: undefined,
        candidateScreenplayIds: [screenplayId, otherScreenplayId],
        slot: { screenplayId: otherScreenplayId, updatedAt: now },
      }),
      () => now,
    );

    await expect(store.restoreRevision(actorId, screenplayId, revisionId, input)).resolves.toBe(
      'entitlement-required',
    );
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockGetRevisionById).not.toHaveBeenCalled();
  });

  it('reads the entitlement snapshot at the injected clock, so a cooldown decision is deterministic', async () => {
    mockGetRevisionById.mockResolvedValue({ canonicalScreenplay: screenplayFixture });
    mockRestore.mockResolvedValue(restored);
    const store = entitlements({});
    await createPostgresRestoreStore(
      fakePool([{ role: 'owner' }]),
      store,
      () => now,
    ).restoreRevision(actorId, screenplayId, revisionId, input);
    expect(store.getSnapshot).toHaveBeenCalledWith(actorId, now);
  });
});

describe('restoreRevision and the target revision', () => {
  it('reports a revision that does not resolve under this screenplay as missing', async () => {
    mockGetRevisionById.mockResolvedValue(undefined);
    const store = createPostgresRestoreStore(
      fakePool([{ role: 'owner' }]),
      entitlements({}),
      () => now,
    );
    await expect(store.restoreRevision(actorId, screenplayId, revisionId, input)).resolves.toBe(
      'missing',
    );
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockGetRevisionById).toHaveBeenCalledWith(expect.anything(), screenplayId, revisionId);
  });

  /**
   * Checked *before* the transaction opens, never inside it: a revision whose canonical projection
   * cannot be parsed must not become the live document, and finding that out after the epoch had
   * already moved would mean a cutover to a screenplay nobody can open.
   */
  it('refuses a revision whose canonical projection does not parse, without opening the transaction', async () => {
    mockGetRevisionById.mockResolvedValue({ canonicalScreenplay: { schemaVersion: 1 } });
    const store = createPostgresRestoreStore(
      fakePool([{ role: 'owner' }]),
      entitlements({}),
      () => now,
    );
    await expect(store.restoreRevision(actorId, screenplayId, revisionId, input)).resolves.toBe(
      'unreadable-revision',
    );
    expect(mockRestore).not.toHaveBeenCalled();
  });
});

describe('restoreRevision outcome mapping', () => {
  async function restoreWith(outcome: unknown) {
    mockGetRevisionById.mockResolvedValue({ canonicalScreenplay: screenplayFixture });
    mockRestore.mockResolvedValue(outcome);
    const store = createPostgresRestoreStore(
      fakePool([{ role: 'owner' }]),
      entitlements({}),
      () => now,
    );
    return await store.restoreRevision(actorId, screenplayId, revisionId, input);
  }

  /** The idempotent replay of an already-committed restore is a success carrying the original
   * restore's identity -- never a second cutover, and never an error. */
  it('passes a replay through as a success with created: false', async () => {
    await expect(restoreWith({ ...restored, created: false })).resolves.toEqual(
      expect.objectContaining({
        created: false,
        epoch: 1,
        restoreRevisionId: restored.restoreRevisionId,
      }),
    );
  });

  /** plan.md step 4's stale-epoch rejection, on the HTTP path: the document moved on between the
   * client reading the epoch and confirming, so its confirmation was about a state that no longer
   * exists. */
  it('maps an epoch conflict to stale-epoch', async () => {
    await expect(restoreWith({ outcome: 'epoch-conflict', currentEpoch: 3 })).resolves.toBe(
      'stale-epoch',
    );
  });

  it('maps both kinds of vanished row to missing, and a foreign request id to its own answer', async () => {
    await expect(restoreWith({ outcome: 'screenplay-missing' })).resolves.toBe('missing');
    await expect(restoreWith({ outcome: 'revision-missing' })).resolves.toBe('missing');
    await expect(restoreWith({ outcome: 'request-id-conflict' })).resolves.toBe(
      'request-id-conflict',
    );
  });
});

describe('the derive callback handed to the transaction', () => {
  type Derive = (
    canonical: unknown,
  ) => { renderedText: string; previewMetadata: object | null } | undefined;

  async function capturedDerive(): Promise<Derive> {
    mockGetRevisionById.mockResolvedValue({ canonicalScreenplay: screenplayFixture });
    mockRestore.mockResolvedValue(restored);
    const store = createPostgresRestoreStore(
      fakePool([{ role: 'owner' }]),
      entitlements({}),
      () => now,
    );
    await store.restoreRevision(actorId, screenplayId, revisionId, input);
    return (mockRestore.mock.calls[0]![1] as { derive: Derive }).derive;
  }

  /** The two revision columns `packages/database` cannot compute without depending on
   * `@finaler-draft/screenplay`, supplied for the `pre_restore` capture of what was live. */
  it('derives rendered text and preview metadata from the live canonical projection', async () => {
    const derive = await capturedDerive();
    const derived = derive(screenplayFixture);
    // Compared against the two functions themselves rather than against hand-written numbers: what
    // this callback owes the transaction is exactly `screenplayToPlainText` and
    // `computeRevisionPreviewMetadata` over the projection it was handed, and a test carrying its own
    // copies of their output would drift from them silently.
    expect(derived?.renderedText).toBe(screenplayToPlainText(screenplayFixture));
    expect(derived?.previewMetadata).toEqual(computeRevisionPreviewMetadata(screenplayFixture));
    // Narrowed because not every block type in the union carries `text` (`page_break` has none).
    const firstFixtureBlock = screenplayFixture.blocks[0]!;
    if (!('text' in firstFixtureBlock)) throw new Error('Expected a first block carrying text.');
    expect(derived?.renderedText).toContain(firstFixtureBlock.text);
  });

  /**
   * An unreadable *live* projection is not a reason to refuse the restore -- the retired epoch's log
   * still holds that content, and refusing to restore because the live document is broken would
   * block the one operation most likely to fix it. It only means the prior head cannot be captured as
   * its own revision.
   */
  it('returns undefined for a live projection that does not parse, and logs it without throwing', async () => {
    const derive = await capturedDerive();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(derive({ nothing: 'valid here' })).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('restore_pre_restore_capture_skipped'),
    );
    errorSpy.mockRestore();
  });
});

describe('the restore request id', () => {
  /**
   * Not generated here, and that is the point: the key has to come from the client so a retried or
   * double-submitted confirmation carries the identical value. A server-side key would make every
   * retry a fresh identity and defeat the idempotency the unique index exists to provide.
   */
  it('is passed through from the client untouched, never regenerated per attempt', async () => {
    mockGetRevisionById.mockResolvedValue({ canonicalScreenplay: screenplayFixture });
    mockRestore.mockResolvedValue(restored);
    const store = createPostgresRestoreStore(
      fakePool([{ role: 'owner' }]),
      entitlements({}),
      () => now,
    );
    const clientKey = randomUUID();
    await store.restoreRevision(actorId, screenplayId, revisionId, {
      ...input,
      restoreRequestId: clientKey,
    });
    expect(mockRestore.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ restoreRequestId: clientKey }),
    );
  });
});

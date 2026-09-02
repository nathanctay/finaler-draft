import { minimalScreenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createEntitlementEnforcedProjectStore } from './entitlementProjectStore.js';
import { EntitlementLimitError, type EntitlementSnapshot } from './entitlements.js';
import type { EntitlementStore } from './entitlementStore.js';
import { ForbiddenError, type ProjectStore } from './projects.js';

const actorId = 'actor-1';
const projectId = '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f';
const screenplayA = 'ecf1118c-3a2e-4656-84e6-fce75c461710';
const screenplayB = '0f1e2d3c-4b5a-6978-8695-a1b2c3d4e5f6';
const now = new Date('2026-09-01T12:00:00Z');
const createInput = { title: 'Draft', screenplay: minimalScreenplayFixture };
const updateInput = {
  expectedVersion: 1,
  screenplay: { ...minimalScreenplayFixture, id: screenplayA },
};

function snapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    subscriptionStatus: undefined,
    candidateScreenplayIds: [],
    slot: null,
    now,
    ...overrides,
  };
}

// A minimal ProjectStore double. Every method throws unless a test overrides it -- so a test that
// forgets to stub a method it didn't mean to exercise fails loudly instead of silently returning
// `undefined`.
function unusedProjectStore(): ProjectStore {
  const fail = (name: string) => () => {
    throw new Error(`unexpected call to ProjectStore.${name}`);
  };
  return {
    listProjects: fail('listProjects'),
    createProject: fail('createProject'),
    renameProject: fail('renameProject'),
    deleteProject: fail('deleteProject'),
    restoreProject: fail('restoreProject'),
    listScreenplays: fail('listScreenplays'),
    createScreenplay: fail('createScreenplay'),
    getScreenplay: fail('getScreenplay'),
    renameScreenplay: fail('renameScreenplay'),
    deleteScreenplay: fail('deleteScreenplay'),
    restoreScreenplay: fail('restoreScreenplay'),
    listDeleted: fail('listDeleted'),
    updateScreenplay: fail('updateScreenplay'),
  };
}

function entitlementsFixture(
  snap: EntitlementSnapshot,
): Pick<EntitlementStore, 'getSnapshot' | 'claimEmptySlot'> {
  return {
    getSnapshot: vi.fn(async () => snap),
    claimEmptySlot: vi.fn(async () => undefined),
  };
}

describe('createEntitlementEnforcedProjectStore: createScreenplay', () => {
  it('free with none: delegates to the base store and claims the empty slot for the new screenplay', async () => {
    const base = unusedProjectStore();
    base.createScreenplay = vi.fn(async () => ({ id: screenplayA, version: 1 }));
    const entitlements = entitlementsFixture(snapshot({ candidateScreenplayIds: [] }));
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    const result = await store.createScreenplay(actorId, projectId, createInput);

    expect(result).toEqual({ id: screenplayA, version: 1 });
    expect(base.createScreenplay).toHaveBeenCalledWith(actorId, projectId, createInput);
    expect(entitlements.claimEmptySlot).toHaveBeenCalledWith(actorId, screenplayA, now);
  });

  it('free with one: refuses a second screenplay without ever calling the base store', async () => {
    const base = unusedProjectStore();
    const entitlements = entitlementsFixture(snapshot({ candidateScreenplayIds: [screenplayA] }));
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    await expect(store.createScreenplay(actorId, projectId, createInput)).rejects.toBeInstanceOf(
      EntitlementLimitError,
    );
    expect(entitlements.claimEmptySlot).not.toHaveBeenCalled();
  });

  it('lapsed with several: refuses creation the same way free-with-one does', async () => {
    const base = unusedProjectStore();
    const entitlements = entitlementsFixture(
      snapshot({
        subscriptionStatus: 'canceled',
        candidateScreenplayIds: [screenplayA, screenplayB],
      }),
    );
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    await expect(store.createScreenplay(actorId, projectId, createInput)).rejects.toBeInstanceOf(
      EntitlementLimitError,
    );
  });

  it('active subscription: creates freely even with existing candidates, and never claims a slot', async () => {
    const base = unusedProjectStore();
    base.createScreenplay = vi.fn(async () => ({ id: screenplayB, version: 1 }));
    const entitlements = entitlementsFixture(
      snapshot({ subscriptionStatus: 'active', candidateScreenplayIds: [screenplayA] }),
    );
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    const result = await store.createScreenplay(actorId, projectId, createInput);

    expect(result).toEqual({ id: screenplayB, version: 1 });
    expect(entitlements.claimEmptySlot).not.toHaveBeenCalled();
  });

  it('still surfaces the base store’s own ForbiddenError when entitlement allows but membership does not', async () => {
    // Entitlement and role-membership are independent checks -- passing one does not bypass the
    // other. The base store's own authorization (owner/editor role on the project) still applies.
    const base = unusedProjectStore();
    base.createScreenplay = vi.fn(async () => {
      throw new ForbiddenError();
    });
    const entitlements = entitlementsFixture(snapshot({ candidateScreenplayIds: [] }));
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    await expect(store.createScreenplay(actorId, projectId, createInput)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('createEntitlementEnforcedProjectStore: updateScreenplay', () => {
  it('free with one: the sole candidate may be edited, and the call reaches the base store', async () => {
    const base = unusedProjectStore();
    base.updateScreenplay = vi.fn(async () => ({ version: 2 }));
    const entitlements = entitlementsFixture(snapshot({ candidateScreenplayIds: [screenplayA] }));
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    const result = await store.updateScreenplay(actorId, screenplayA, updateInput);

    expect(result).toEqual({ version: 2 });
    expect(base.updateScreenplay).toHaveBeenCalledWith(actorId, screenplayA, updateInput);
  });

  it('a screenplay outside the slot cannot be edited: refused without reaching the base store', async () => {
    const base = unusedProjectStore();
    const entitlements = entitlementsFixture(
      snapshot({
        candidateScreenplayIds: [screenplayA, screenplayB],
        slot: { screenplayId: screenplayA, updatedAt: now },
      }),
    );
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    await expect(store.updateScreenplay(actorId, screenplayB, updateInput)).resolves.toBe(
      'forbidden',
    );
  });

  it('lapsed with several and no choice made: cannot edit anything, including a plausible-looking candidate', async () => {
    const base = unusedProjectStore();
    const entitlements = entitlementsFixture(
      snapshot({
        subscriptionStatus: 'canceled',
        candidateScreenplayIds: [screenplayA, screenplayB],
      }),
    );
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    await expect(store.updateScreenplay(actorId, screenplayA, updateInput)).resolves.toBe(
      'forbidden',
    );
    await expect(store.updateScreenplay(actorId, screenplayB, updateInput)).resolves.toBe(
      'forbidden',
    );
  });

  it('lapsed after choosing: the chosen screenplay may be edited, the other may not', async () => {
    const base = unusedProjectStore();
    base.updateScreenplay = vi.fn(async () => ({ version: 5 }));
    const entitlements = entitlementsFixture(
      snapshot({
        subscriptionStatus: 'past_due',
        candidateScreenplayIds: [screenplayA, screenplayB],
        slot: { screenplayId: screenplayB, updatedAt: now },
      }),
    );
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    await expect(store.updateScreenplay(actorId, screenplayA, updateInput)).resolves.toBe(
      'forbidden',
    );
    await expect(store.updateScreenplay(actorId, screenplayB, updateInput)).resolves.toEqual({
      version: 5,
    });
    expect(base.updateScreenplay).toHaveBeenCalledTimes(1);
  });

  it('a non-candidate target is left entirely to the base store, never turned into a billing decision', async () => {
    // Not a member at all, or a reviewer -- either way, this layer must not manufacture a
    // 'forbidden' of its own for a screenplay outside the actor's owner/editor candidate set: the
    // underlying store's own 'missing'/'forbidden' response, and only that response, must reach
    // the caller, or a non-member could learn whether a screenplay exists from the difference.
    const base = unusedProjectStore();
    base.updateScreenplay = vi.fn(async () => 'missing' as const);
    const entitlements = entitlementsFixture(snapshot({ candidateScreenplayIds: [screenplayA] }));
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    await expect(store.updateScreenplay(actorId, screenplayB, updateInput)).resolves.toBe(
      'missing',
    );
    expect(base.updateScreenplay).toHaveBeenCalledWith(actorId, screenplayB, updateInput);
  });

  it('active subscription: every candidate may be edited, no slot required', async () => {
    const base = unusedProjectStore();
    base.updateScreenplay = vi.fn(async () => ({ version: 3 }));
    const entitlements = entitlementsFixture(
      snapshot({
        subscriptionStatus: 'active',
        candidateScreenplayIds: [screenplayA, screenplayB],
      }),
    );
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    await expect(store.updateScreenplay(actorId, screenplayB, updateInput)).resolves.toEqual({
      version: 3,
    });
  });
});

describe('createEntitlementEnforcedProjectStore: untouched methods', () => {
  it('passes every other ProjectStore method straight through, unmodified', async () => {
    const base = unusedProjectStore();
    base.listProjects = vi.fn(async () => [
      { id: projectId, title: 'Project', updatedAt: '2026-08-06T00:00:00Z', role: 'owner' },
    ]);
    base.deleteScreenplay = vi.fn(async () => ({ id: screenplayA }));
    base.renameScreenplay = vi.fn(async () => ({ id: screenplayA, title: 'Renamed' }));
    const entitlements = entitlementsFixture(snapshot());
    const store = createEntitlementEnforcedProjectStore(base, entitlements, () => now);

    await expect(store.listProjects(actorId)).resolves.toEqual([
      { id: projectId, title: 'Project', updatedAt: '2026-08-06T00:00:00Z', role: 'owner' },
    ]);
    await expect(store.deleteScreenplay(actorId, screenplayA)).resolves.toEqual({
      id: screenplayA,
    });
    await expect(store.renameScreenplay(actorId, screenplayA, 'Renamed')).resolves.toEqual({
      id: screenplayA,
      title: 'Renamed',
    });
    // None of these touch the entitlement layer at all -- a screenplay outside the slot can still
    // be renamed, deleted, or restored.
    expect(entitlements.getSnapshot).not.toHaveBeenCalled();
  });
});

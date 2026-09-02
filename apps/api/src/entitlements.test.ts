import { describe, expect, it } from 'vitest';
import {
  EDITABLE_SLOT_COOLDOWN_MS,
  checkEntitlement,
  resolveEditableScreenplayId,
  tierForSubscriptionStatus,
  type EntitlementSnapshot,
} from './entitlements.js';

const now = new Date('2026-09-01T12:00:00Z');
const screenplayA = 'aaaaaaaa-0000-0000-0000-000000000001';
const screenplayB = 'bbbbbbbb-0000-0000-0000-000000000002';
const screenplayC = 'cccccccc-0000-0000-0000-000000000003';

function snapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    subscriptionStatus: undefined,
    candidateScreenplayIds: [],
    slot: null,
    now,
    ...overrides,
  };
}

describe('tierForSubscriptionStatus', () => {
  it('treats a missing subscription row as the free/restricted tier, not an error', () => {
    expect(tierForSubscriptionStatus(undefined)).toBe('restricted');
  });

  it('treats active and trialing as paid', () => {
    expect(tierForSubscriptionStatus('active')).toBe('paid');
    expect(tierForSubscriptionStatus('trialing')).toBe('paid');
  });

  it('treats every lapsed-shaped status as restricted, identically to no subscription at all', () => {
    for (const status of [
      'incomplete',
      'incomplete_expired',
      'past_due',
      'canceled',
      'unpaid',
      'paused',
    ] as const) {
      expect(tierForSubscriptionStatus(status)).toBe('restricted');
    }
  });
});

describe('checkEntitlement: create-screenplay', () => {
  it('free with none: allows creating the first screenplay', () => {
    const decision = checkEntitlement(snapshot({ candidateScreenplayIds: [] }), {
      type: 'create-screenplay',
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('free with one: refuses a second screenplay', () => {
    const decision = checkEntitlement(snapshot({ candidateScreenplayIds: [screenplayA] }), {
      type: 'create-screenplay',
    });
    expect(decision).toEqual({ allowed: false, reason: 'free-tier-limit' });
  });

  it('free with a share beyond the slot: still refuses creation once any candidate exists, owned or shared', () => {
    // A candidate the account did not create itself (shared in) still counts -- collaboration is
    // not a paid feature, and a shared screenplay occupies the slot exactly like an owned one.
    const decision = checkEntitlement(
      snapshot({
        candidateScreenplayIds: [screenplayA],
        slot: { screenplayId: screenplayA, updatedAt: now },
      }),
      { type: 'create-screenplay' },
    );
    expect(decision).toEqual({ allowed: false, reason: 'free-tier-limit' });
  });

  it('active subscription: always allows creation regardless of existing candidates', () => {
    const decision = checkEntitlement(
      snapshot({
        subscriptionStatus: 'active',
        candidateScreenplayIds: [screenplayA, screenplayB, screenplayC],
      }),
      { type: 'create-screenplay' },
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('lapsed with several and no choice made: still refuses creation (candidates > 0)', () => {
    const decision = checkEntitlement(
      snapshot({
        subscriptionStatus: 'canceled',
        candidateScreenplayIds: [screenplayA, screenplayB],
      }),
      { type: 'create-screenplay' },
    );
    expect(decision).toEqual({ allowed: false, reason: 'free-tier-limit' });
  });
});

describe('checkEntitlement: edit-screenplay', () => {
  it('free with one: the sole candidate is editable without any explicit slot row', () => {
    const decision = checkEntitlement(snapshot({ candidateScreenplayIds: [screenplayA] }), {
      type: 'edit-screenplay',
      screenplayId: screenplayA,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('free with a share beyond the slot: the slot holder may edit, the shared-in extra may not', () => {
    const state = snapshot({
      candidateScreenplayIds: [screenplayA, screenplayB],
      slot: { screenplayId: screenplayA, updatedAt: now },
    });
    expect(checkEntitlement(state, { type: 'edit-screenplay', screenplayId: screenplayA })).toEqual(
      { allowed: true },
    );
    expect(checkEntitlement(state, { type: 'edit-screenplay', screenplayId: screenplayB })).toEqual(
      { allowed: false, reason: 'not-in-slot' },
    );
  });

  it('active subscription: every candidate is editable, no slot required', () => {
    const decision = checkEntitlement(
      snapshot({
        subscriptionStatus: 'active',
        candidateScreenplayIds: [screenplayA, screenplayB],
      }),
      { type: 'edit-screenplay', screenplayId: screenplayB },
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('lapsed with one screenplay: the sole remaining screenplay is editable without asking', () => {
    const decision = checkEntitlement(
      snapshot({ subscriptionStatus: 'past_due', candidateScreenplayIds: [screenplayA] }),
      { type: 'edit-screenplay', screenplayId: screenplayA },
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('lapsed with several and no choice made: nothing is editable, not even by picking one', () => {
    const state = snapshot({
      subscriptionStatus: 'canceled',
      candidateScreenplayIds: [screenplayA, screenplayB, screenplayC],
    });
    for (const id of [screenplayA, screenplayB, screenplayC]) {
      expect(checkEntitlement(state, { type: 'edit-screenplay', screenplayId: id })).toEqual({
        allowed: false,
        reason: 'no-slot-chosen',
      });
    }
  });

  it('lapsed after choosing: the chosen screenplay is editable, the others are not', () => {
    const state = snapshot({
      subscriptionStatus: 'canceled',
      candidateScreenplayIds: [screenplayA, screenplayB, screenplayC],
      slot: { screenplayId: screenplayB, updatedAt: now },
    });
    expect(checkEntitlement(state, { type: 'edit-screenplay', screenplayId: screenplayB })).toEqual(
      { allowed: true },
    );
    expect(checkEntitlement(state, { type: 'edit-screenplay', screenplayId: screenplayA })).toEqual(
      { allowed: false, reason: 'not-in-slot' },
    );
    expect(checkEntitlement(state, { type: 'edit-screenplay', screenplayId: screenplayC })).toEqual(
      { allowed: false, reason: 'not-in-slot' },
    );
  });

  it('a slot pointing at a screenplay no longer a candidate falls back to the unambiguous case', () => {
    // The recorded slot names a screenplay this account no longer has owner/editor access to
    // (e.g. it was un-shared or soft-deleted). With exactly one live candidate remaining,
    // resolution is still unambiguous.
    const decision = checkEntitlement(
      snapshot({
        subscriptionStatus: 'canceled',
        candidateScreenplayIds: [screenplayA],
        slot: { screenplayId: screenplayB, updatedAt: now },
      }),
      { type: 'edit-screenplay', screenplayId: screenplayA },
    );
    expect(decision).toEqual({ allowed: true });
  });
});

describe('checkEntitlement: switch-slot (the cooldown)', () => {
  it('establishing a first choice (no prior slot) is never subject to the cooldown', () => {
    const decision = checkEntitlement(
      snapshot({
        subscriptionStatus: 'canceled',
        candidateScreenplayIds: [screenplayA, screenplayB],
      }),
      { type: 'switch-slot', screenplayId: screenplayA },
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('inside the cooldown window: refuses the switch', () => {
    const decision = checkEntitlement(
      snapshot({
        subscriptionStatus: 'canceled',
        candidateScreenplayIds: [screenplayA, screenplayB],
        slot: { screenplayId: screenplayA, updatedAt: new Date(now.getTime() - 1000) },
      }),
      { type: 'switch-slot', screenplayId: screenplayB },
    );
    expect(decision).toEqual({ allowed: false, reason: 'cooldown' });
  });

  it('exactly at the cooldown boundary: still refuses (the window has not strictly elapsed)', () => {
    const decision = checkEntitlement(
      snapshot({
        subscriptionStatus: 'canceled',
        candidateScreenplayIds: [screenplayA, screenplayB],
        slot: {
          screenplayId: screenplayA,
          updatedAt: new Date(now.getTime() - EDITABLE_SLOT_COOLDOWN_MS),
        },
      }),
      { type: 'switch-slot', screenplayId: screenplayB },
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('outside the cooldown window: allows the switch', () => {
    const decision = checkEntitlement(
      snapshot({
        subscriptionStatus: 'canceled',
        candidateScreenplayIds: [screenplayA, screenplayB],
        slot: {
          screenplayId: screenplayA,
          updatedAt: new Date(now.getTime() - EDITABLE_SLOT_COOLDOWN_MS - 1),
        },
      }),
      { type: 'switch-slot', screenplayId: screenplayB },
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('a newly shared screenplay gets no exception from the cooldown', () => {
    // The screenplay being switched *to* was, hypothetically, only just shared -- that carries no
    // special exemption. Only the time since the *slot itself* last changed matters.
    const decision = checkEntitlement(
      snapshot({
        subscriptionStatus: 'canceled',
        candidateScreenplayIds: [screenplayA, screenplayB],
        slot: { screenplayId: screenplayA, updatedAt: now },
      }),
      { type: 'switch-slot', screenplayId: screenplayB },
    );
    expect(decision).toEqual({ allowed: false, reason: 'cooldown' });
  });

  it('active subscription: switching is always allowed, cooldown or not', () => {
    const decision = checkEntitlement(
      snapshot({
        subscriptionStatus: 'active',
        candidateScreenplayIds: [screenplayA, screenplayB],
        slot: { screenplayId: screenplayA, updatedAt: now },
      }),
      { type: 'switch-slot', screenplayId: screenplayB },
    );
    expect(decision).toEqual({ allowed: true });
  });
});

describe('resolveEditableScreenplayId', () => {
  it('returns null for zero candidates', () => {
    expect(resolveEditableScreenplayId(snapshot({ candidateScreenplayIds: [] }))).toBeNull();
  });

  it('returns the sole candidate when there is exactly one, with no slot on record', () => {
    expect(resolveEditableScreenplayId(snapshot({ candidateScreenplayIds: [screenplayA] }))).toBe(
      screenplayA,
    );
  });

  it('returns null for several candidates with no slot chosen', () => {
    expect(
      resolveEditableScreenplayId(snapshot({ candidateScreenplayIds: [screenplayA, screenplayB] })),
    ).toBeNull();
  });

  it('returns the explicit slot when it still names a live candidate', () => {
    expect(
      resolveEditableScreenplayId(
        snapshot({
          candidateScreenplayIds: [screenplayA, screenplayB],
          slot: { screenplayId: screenplayB, updatedAt: now },
        }),
      ),
    ).toBe(screenplayB);
  });
});

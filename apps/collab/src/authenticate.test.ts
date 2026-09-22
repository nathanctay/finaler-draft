import { describe, expect, it } from 'vitest';
import { TRANSIENT_SYNC_AUTH_FAILURE_REASON } from '@finaler-draft/config';
import {
  authenticateConnection,
  resolveConnectionAuthorization,
  TransientAuthenticationError,
  type Queryable,
} from './authenticate.js';

const now = new Date('2026-09-04T12:00:00Z');
const documentId = '11111111-1111-4111-8111-111111111111';
const actorId = 'actor-1';

/**
 * A fake `Queryable` keyed on a recognisable fragment of each query's own SQL text, mirroring the
 * shape `authenticate.ts`'s four queries actually issue -- `fetchRole`
 * ("from screenplays"), `fetchCandidateScreenplayIds` ("m.role in"),
 * `fetchSlot` ("editable_slots"), `fetchSubscriptionStatus` ("from subscriptions"). Table-driven
 * rather than a hand-rolled mock per test: every test below only needs to say what each query
 * should answer, not re-implement the dispatch.
 */
function fakeQueryable(responses: {
  role?: 'owner' | 'editor' | 'reviewer';
  candidateScreenplayIds?: string[];
  slot?: { screenplayId: string; updatedAt: Date } | null;
  subscriptionStatus?: string;
}): Queryable {
  return {
    async query(text: string) {
      // Checked before the plain "from screenplays" branch below: `fetchCandidateScreenplayIds`'s
      // own query text also contains "from screenplays s", so the more specific condition must
      // win or every candidate-ids call would be misrouted to the role-lookup response instead.
      if (text.includes('m.role in')) {
        return { rows: (responses.candidateScreenplayIds ?? []).map((id) => ({ id })) };
      }
      if (text.includes('from screenplays')) {
        return { rows: responses.role ? [{ role: responses.role }] : [] };
      }
      if (text.includes('editable_slots')) {
        return {
          rows: responses.slot
            ? [{ screenplayId: responses.slot.screenplayId, updatedAt: responses.slot.updatedAt }]
            : [],
        };
      }
      if (text.includes('from subscriptions')) {
        return {
          rows: responses.subscriptionStatus ? [{ status: responses.subscriptionStatus }] : [],
        };
      }
      throw new Error(`Unexpected query in test double: ${text}`);
    },
  };
}

describe('resolveConnectionAuthorization', () => {
  it('rejects a connection for an actor with no role on the document at all', async () => {
    const queryable = fakeQueryable({});
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: false });
  });

  it('allows a reviewer to connect but marks the connection read-only, before ever checking entitlement', async () => {
    const queryable = fakeQueryable({ role: 'reviewer' });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, readOnly: true });
  });

  it('allows a reviewer to write nothing even on a paid account -- role, not billing, is the reason', async () => {
    const queryable = fakeQueryable({ role: 'reviewer', subscriptionStatus: 'active' });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, readOnly: true });
  });

  it('allows a paid owner to write regardless of the editable-slot mechanics', async () => {
    const queryable = fakeQueryable({
      role: 'owner',
      subscriptionStatus: 'active',
      candidateScreenplayIds: [documentId, 'other-screenplay'],
      slot: { screenplayId: 'other-screenplay', updatedAt: now },
    });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, readOnly: false });
  });

  it('allows a restricted-tier owner to write the one screenplay in their editable slot', async () => {
    const queryable = fakeQueryable({
      role: 'owner',
      candidateScreenplayIds: [documentId],
      slot: null,
    });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, readOnly: false });
  });

  it('marks a restricted-tier editor read-only when this screenplay is not the one occupying their slot', async () => {
    const queryable = fakeQueryable({
      role: 'editor',
      candidateScreenplayIds: [documentId, 'other-screenplay'],
      slot: { screenplayId: 'other-screenplay', updatedAt: now },
    });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, readOnly: true });
  });

  it('marks a restricted-tier owner read-only when several candidates exist and none has been chosen', async () => {
    const queryable = fakeQueryable({
      role: 'owner',
      candidateScreenplayIds: [documentId, 'other-screenplay'],
      slot: null,
    });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, readOnly: true });
  });
});

/**
 * `resolveConnectionAuthorization` above never sees an `Origin` header or a missing session --
 * those are `authenticateConnection`'s own composition, and a mutation test (deleting the origin
 * check with no test anywhere failing) found neither had ever been exercised directly. These close
 * that gap; see `originGuard.test.ts` for the underlying predicate's own tests.
 */
describe('authenticateConnection', () => {
  const trustedOrigins = ['http://127.0.0.1:4000'];
  const headersWithOrigin = (origin: string | undefined) =>
    new Headers(origin === undefined ? {} : { origin });

  it('rejects a connection whose Origin is not on the trusted allowlist', async () => {
    const queryable = fakeQueryable({ role: 'owner', subscriptionStatus: 'active' });
    await expect(
      authenticateConnection(
        {
          queryable,
          trustedOrigins,
          getActorId: async () => actorId,
        },
        {
          documentName: documentId,
          requestHeaders: headersWithOrigin('https://evil.example.test'),
          now,
        },
      ),
    ).rejects.toThrow('Cross-origin connection rejected');
  });

  it('rejects a connection with no Origin header at all, before ever checking the session', async () => {
    let sessionChecked = false;
    const queryable = fakeQueryable({ role: 'owner', subscriptionStatus: 'active' });
    await expect(
      authenticateConnection(
        {
          queryable,
          trustedOrigins,
          getActorId: async () => {
            sessionChecked = true;
            return actorId;
          },
        },
        { documentName: documentId, requestHeaders: headersWithOrigin(undefined), now },
      ),
    ).rejects.toThrow('Cross-origin connection rejected');
    expect(sessionChecked).toBe(false);
  });

  it('rejects a connection with a trusted Origin but no valid session', async () => {
    const queryable = fakeQueryable({ role: 'owner', subscriptionStatus: 'active' });
    await expect(
      authenticateConnection(
        {
          queryable,
          trustedOrigins,
          getActorId: async () => null,
        },
        { documentName: documentId, requestHeaders: headersWithOrigin(trustedOrigins[0]), now },
      ),
    ).rejects.toThrow('Authentication required');
  });

  it('rejects a connection to a document this actor has no role on, with a trusted origin and a valid session', async () => {
    const queryable = fakeQueryable({});
    await expect(
      authenticateConnection(
        {
          queryable,
          trustedOrigins,
          getActorId: async () => actorId,
        },
        { documentName: documentId, requestHeaders: headersWithOrigin(trustedOrigins[0]), now },
      ),
    ).rejects.toThrow('This document is not visible to this account');
  });

  it('resolves to the actor id and read-only flag once origin, session, and role/entitlement all clear, delegating the actual decision to resolveConnectionAuthorization', async () => {
    const queryable = fakeQueryable({ role: 'reviewer' });
    const result = await authenticateConnection(
      {
        queryable,
        trustedOrigins,
        getActorId: async () => actorId,
      },
      { documentName: documentId, requestHeaders: headersWithOrigin(trustedOrigins[0]), now },
    );
    expect(result).toEqual({ actorId, readOnly: true });
  });

  // The classification the sync-gate fix depends on (progress/collaboration-slice-1.md): a
  // thrown, unexpected error and a resolved, deliberate denial must produce differently-shaped
  // rejections, because `apps/web`'s `App.tsx` -- and `apps/collab`'s own `onAuthenticate` in
  // server.ts, via Hocuspocus's `error.reason` forwarding -- tells them apart by exactly this.
  // Every `rejects.toThrow('...')` test above already proves the three deliberate denials stay
  // plain `Error`s with their existing messages, unchanged by this class existing at all; these
  // two prove the other half.
  it('wraps a thrown error from the session lookup as transient, tagging it for the client to retry rather than treat as a denial', async () => {
    const queryable = fakeQueryable({ role: 'owner', subscriptionStatus: 'active' });
    const sessionLookupFailure = new Error('connection terminated unexpectedly');
    let rejection: unknown;
    try {
      await authenticateConnection(
        {
          queryable,
          trustedOrigins,
          getActorId: async () => {
            throw sessionLookupFailure;
          },
        },
        { documentName: documentId, requestHeaders: headersWithOrigin(trustedOrigins[0]), now },
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(TransientAuthenticationError);
    expect((rejection as TransientAuthenticationError).reason).toBe(
      TRANSIENT_SYNC_AUTH_FAILURE_REASON,
    );
    expect((rejection as TransientAuthenticationError).cause).toBe(sessionLookupFailure);
    expect((rejection as TransientAuthenticationError).stage).toBe('session-lookup');
  });

  it('wraps a thrown error from the role/entitlement lookup as transient, not as "not visible to this account"', async () => {
    const databaseFailure = new Error('Connection terminated unexpectedly');
    const brokenQueryable: Queryable = {
      async query() {
        throw databaseFailure;
      },
    };
    let rejection: unknown;
    try {
      await authenticateConnection(
        {
          queryable: brokenQueryable,
          trustedOrigins,
          getActorId: async () => actorId,
        },
        { documentName: documentId, requestHeaders: headersWithOrigin(trustedOrigins[0]), now },
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(TransientAuthenticationError);
    expect((rejection as TransientAuthenticationError).reason).toBe(
      TRANSIENT_SYNC_AUTH_FAILURE_REASON,
    );
    expect((rejection as TransientAuthenticationError).cause).toBe(databaseFailure);
    expect((rejection as TransientAuthenticationError).stage).toBe('role-or-entitlement-lookup');
    // Must not be misclassified as the deliberate denial that shares this function's next
    // condition -- a database outage during the role lookup is not "no role found".
    expect(rejection).not.toEqual(new Error('This document is not visible to this account'));
  });
});

import { describe, expect, it } from 'vitest';
import {
  formatCollabDocumentName,
  TRANSIENT_SYNC_AUTH_FAILURE_REASON,
  UNKNOWN_DOCUMENT_EPOCH_FAILURE_REASON,
} from '@finaler-draft/config';
import type { ConnectionTokenVerification } from '@finaler-draft/collab-token';
import {
  authenticateConnection,
  ExpiredConnectionTokenError,
  readAuthenticatedConnectionContext,
  resolveConnectionAuthorization,
  TransientAuthenticationError,
  UnknownDocumentEpochError,
  type Queryable,
} from './authenticate.js';

const now = new Date('2026-09-04T12:00:00Z');
const documentId = '11111111-1111-4111-8111-111111111111';
const actorId = 'actor-1';
// Since collaboration slice 5 a Hocuspocus document name is `<screenplayId>:<epoch>`, never a bare
// screenplay id -- every `authenticateConnection` call below therefore names an epoch, and the epoch
// cases get their own suite at the bottom of this file.
const documentName = formatCollabDocumentName(documentId, 0);

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
  /** The screenplay's `current_epoch`, answered alongside the role by the same query since
   * collaboration slice 5. Defaults to `0`, the epoch every screenplay starts at. */
  currentEpoch?: number;
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
        return {
          rows: responses.role
            ? [{ role: responses.role, currentEpoch: responses.currentEpoch ?? 0 }]
            : [],
        };
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
    expect(result).toEqual({ allowed: true, actorId, currentEpoch: 0, readOnly: true });
  });

  it('allows a reviewer to write nothing even on a paid account -- role, not billing, is the reason', async () => {
    const queryable = fakeQueryable({ role: 'reviewer', subscriptionStatus: 'active' });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, currentEpoch: 0, readOnly: true });
  });

  it('allows a paid owner to write regardless of the editable-slot mechanics', async () => {
    const queryable = fakeQueryable({
      role: 'owner',
      subscriptionStatus: 'active',
      candidateScreenplayIds: [documentId, 'other-screenplay'],
      slot: { screenplayId: 'other-screenplay', updatedAt: now },
    });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, currentEpoch: 0, readOnly: false });
  });

  it('allows a restricted-tier owner to write the one screenplay in their editable slot', async () => {
    const queryable = fakeQueryable({
      role: 'owner',
      candidateScreenplayIds: [documentId],
      slot: null,
    });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, currentEpoch: 0, readOnly: false });
  });

  it('marks a restricted-tier editor read-only when this screenplay is not the one occupying their slot', async () => {
    const queryable = fakeQueryable({
      role: 'editor',
      candidateScreenplayIds: [documentId, 'other-screenplay'],
      slot: { screenplayId: 'other-screenplay', updatedAt: now },
    });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, currentEpoch: 0, readOnly: true });
  });

  it('marks a restricted-tier owner read-only when several candidates exist and none has been chosen', async () => {
    const queryable = fakeQueryable({
      role: 'owner',
      candidateScreenplayIds: [documentId, 'other-screenplay'],
      slot: null,
    });
    const result = await resolveConnectionAuthorization(queryable, documentId, actorId, now);
    expect(result).toEqual({ allowed: true, actorId, currentEpoch: 0, readOnly: true });
  });
});

/**
 * `resolveConnectionAuthorization` above never sees an `Origin` header, a missing/expired/invalid
 * token, or the token-verification wiring -- those are `authenticateConnection`'s own composition,
 * and a mutation test (deleting the origin check with no test anywhere failing) found neither had
 * ever been exercised directly. These close that gap; see `originGuard.test.ts` for the underlying
 * predicate's own tests and `@finaler-draft/collab-token`'s own `index.test.ts` for
 * `verifyConnectionToken` itself (mint/verify round trips, expiry, wrong key, malformed, absent).
 * These tests use a fake `verifyToken` rather than the real `verifyConnectionToken`: the real
 * function's own behaviour is that package's responsibility to prove; this file's job is proving
 * `authenticateConnection` reacts correctly to each of the three outcomes it can return.
 */
describe('authenticateConnection', () => {
  const trustedOrigins = ['http://127.0.0.1:4000'];
  const headersWithOrigin = (origin: string | undefined) =>
    new Headers(origin === undefined ? {} : { origin });
  const validToken = (): Promise<ConnectionTokenVerification> =>
    Promise.resolve({ outcome: 'valid', actorId });

  it('rejects a connection whose Origin is not on the trusted allowlist', async () => {
    const queryable = fakeQueryable({ role: 'owner', subscriptionStatus: 'active' });
    await expect(
      authenticateConnection(
        {
          queryable,
          trustedOrigins,
          verifyToken: validToken,
        },
        {
          documentName,
          requestHeaders: headersWithOrigin('https://evil.example.test'),
          token: 'irrelevant',
          now,
        },
      ),
    ).rejects.toThrow('Cross-origin connection rejected');
  });

  it('rejects a connection with no Origin header at all, before ever verifying the token', async () => {
    let tokenChecked = false;
    const queryable = fakeQueryable({ role: 'owner', subscriptionStatus: 'active' });
    await expect(
      authenticateConnection(
        {
          queryable,
          trustedOrigins,
          verifyToken: async () => {
            tokenChecked = true;
            return { outcome: 'valid', actorId };
          },
        },
        {
          documentName,
          requestHeaders: headersWithOrigin(undefined),
          token: 'irrelevant',
          now,
        },
      ),
    ).rejects.toThrow('Cross-origin connection rejected');
    expect(tokenChecked).toBe(false);
  });

  it('rejects a connection with a trusted Origin but an invalid token', async () => {
    const queryable = fakeQueryable({ role: 'owner', subscriptionStatus: 'active' });
    await expect(
      authenticateConnection(
        {
          queryable,
          trustedOrigins,
          verifyToken: async () => ({ outcome: 'invalid' }),
        },
        {
          documentName,
          requestHeaders: headersWithOrigin(trustedOrigins[0]),
          token: 'not-a-real-token',
          now,
        },
      ),
    ).rejects.toThrow('Authentication required');
  });

  it('rejects a connection with a trusted Origin but an absent token, the same denial as an invalid one', async () => {
    const queryable = fakeQueryable({ role: 'owner', subscriptionStatus: 'active' });
    await expect(
      authenticateConnection(
        {
          queryable,
          trustedOrigins,
          verifyToken: async (token) =>
            token ? { outcome: 'valid', actorId } : { outcome: 'invalid' },
        },
        {
          documentName,
          requestHeaders: headersWithOrigin(trustedOrigins[0]),
          token: '',
          now,
        },
      ),
    ).rejects.toThrow('Authentication required');
  });

  // Risk #1 from the brief, at the unit level: an expired token must produce
  // `ExpiredConnectionTokenError` -- a distinct class from every permanent denial above, but one
  // that shares `TRANSIENT_SYNC_AUTH_FAILURE_REASON` with `TransientAuthenticationError`, which is
  // the one thing `apps/web/src/App.tsx`'s retry logic actually reads. See
  // `collaboration.integration.test.ts` for the same property proven over a real socket, with a
  // real reconnect actually recovering.
  it('rejects an expired token with ExpiredConnectionTokenError, tagged transient, never as a permanent denial', async () => {
    const queryable = fakeQueryable({ role: 'owner', subscriptionStatus: 'active' });
    let rejection: unknown;
    try {
      await authenticateConnection(
        {
          queryable,
          trustedOrigins,
          verifyToken: async () => ({ outcome: 'expired' }),
        },
        {
          documentName,
          requestHeaders: headersWithOrigin(trustedOrigins[0]),
          token: 'an-expired-token',
          now,
        },
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ExpiredConnectionTokenError);
    expect((rejection as ExpiredConnectionTokenError).reason).toBe(
      TRANSIENT_SYNC_AUTH_FAILURE_REASON,
    );
    // Must never be confused with the unexpected-failure class -- an expired token is not a
    // database blip, and `server.ts`'s own rejection log tells the two apart by exactly this.
    expect(rejection).not.toBeInstanceOf(TransientAuthenticationError);
  });

  it('rejects a connection to a document this actor has no role on, with a trusted origin and a valid token', async () => {
    const queryable = fakeQueryable({});
    await expect(
      authenticateConnection(
        {
          queryable,
          trustedOrigins,
          verifyToken: validToken,
        },
        {
          documentName,
          requestHeaders: headersWithOrigin(trustedOrigins[0]),
          token: 'a-valid-token',
          now,
        },
      ),
    ).rejects.toThrow('This document is not visible to this account');
  });

  it('resolves to the actor id and read-only flag once origin, token, and role/entitlement all clear, delegating the actual decision to resolveConnectionAuthorization', async () => {
    const queryable = fakeQueryable({ role: 'reviewer' });
    const result = await authenticateConnection(
      {
        queryable,
        trustedOrigins,
        verifyToken: validToken,
      },
      {
        documentName,
        requestHeaders: headersWithOrigin(trustedOrigins[0]),
        token: 'a-valid-token',
        now,
      },
    );
    expect(result).toEqual({
      actorId,
      currentEpoch: 0,
      epoch: 0,
      readOnly: true,
      screenplayId: documentId,
      staleEpoch: false,
    });
  });

  // The classification the sync-gate fix depends on (progress/collaboration-slice-1.md): a
  // thrown, unexpected error and a resolved, deliberate denial must produce differently-shaped
  // rejections, because `apps/web`'s `App.tsx` -- and `apps/collab`'s own `onAuthenticate` in
  // server.ts, via Hocuspocus's `error.reason` forwarding -- tells them apart by exactly this.
  // Every `rejects.toThrow('...')` test above already proves the deliberate denials stay plain
  // `Error`s with their existing messages, unchanged by this class existing at all; these two
  // prove the other half.
  it('wraps a thrown error from token verification as transient, tagging it for the client to retry rather than treat as a denial', async () => {
    const queryable = fakeQueryable({ role: 'owner', subscriptionStatus: 'active' });
    const tokenVerificationFailure = new Error('connection terminated unexpectedly');
    let rejection: unknown;
    try {
      await authenticateConnection(
        {
          queryable,
          trustedOrigins,
          verifyToken: async () => {
            throw tokenVerificationFailure;
          },
        },
        {
          documentName,
          requestHeaders: headersWithOrigin(trustedOrigins[0]),
          token: 'a-token',
          now,
        },
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(TransientAuthenticationError);
    expect((rejection as TransientAuthenticationError).reason).toBe(
      TRANSIENT_SYNC_AUTH_FAILURE_REASON,
    );
    expect((rejection as TransientAuthenticationError).cause).toBe(tokenVerificationFailure);
    expect((rejection as TransientAuthenticationError).stage).toBe('token-verification');
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
          verifyToken: validToken,
        },
        {
          documentName,
          requestHeaders: headersWithOrigin(trustedOrigins[0]),
          token: 'a-valid-token',
          now,
        },
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

/**
 * Collaboration slice 5 (restore-as-current). The epoch half of the handshake, which is where
 * plan.md step 4's "the server rejects writes to the old epoch" lands on the WebSocket path and
 * where step 5's "never auto-merged" begins. Three outcomes, and the difference between them is the
 * whole design:
 *
 *  - An epoch *older* than current is admitted, read-only. Not denied: there may be unsynced work on
 *    that client that only a connection can deliver, and refusing the connection is the one outcome
 *    that loses it.
 *  - An epoch *newer* than current is denied outright (`UnknownDocumentEpochError`) -- there is
 *    nothing to retain for a document that never existed, and no reconnect that would make it exist.
 *  - A name with no epoch at all -- every client built before this slice -- is refused as malformed
 *    rather than assumed to mean epoch 0.
 *
 * `apps/collab/src/collaboration.integration.test.ts` proves the consequences of the first case over
 * a real socket (quarantine, the restore message, the frozen retired log); these are the decision
 * itself, in isolation, including for an actor whose role and billing would otherwise permit writing.
 */
describe('authenticateConnection and the collaboration epoch', () => {
  const trustedOrigins = ['http://127.0.0.1:4000'];
  const headersWithOrigin = (origin: string | undefined) =>
    new Headers(origin === undefined ? {} : { origin });
  const validToken = (): Promise<ConnectionTokenVerification> =>
    Promise.resolve({ outcome: 'valid', actorId });
  const connect = (requestedEpoch: number, currentEpoch: number) =>
    authenticateConnection(
      {
        queryable: fakeQueryable({ role: 'owner', subscriptionStatus: 'active', currentEpoch }),
        trustedOrigins,
        verifyToken: validToken,
      },
      {
        documentName: formatCollabDocumentName(documentId, requestedEpoch),
        requestHeaders: headersWithOrigin(trustedOrigins[0]),
        token: 'a-valid-token',
        now,
      },
    );

  it('admits a connection at the current epoch as a writer, with staleEpoch false', async () => {
    await expect(connect(2, 2)).resolves.toEqual({
      actorId,
      currentEpoch: 2,
      epoch: 2,
      readOnly: false,
      screenplayId: documentId,
      staleEpoch: false,
    });
  });

  /**
   * The single most important assertion in this slice, and the one mutation #2 of this slice's
   * brief targets: a *paid owner* -- the account with every right this product grants -- is forced
   * read-only purely because the epoch it holds has been retired. Role and billing are both
   * deliberately set to their most permissive values here, so the only thing that can produce
   * `readOnly: true` is the epoch comparison itself.
   */
  it('forces a stale-epoch connection read-only even for a paid owner, and marks it stale', async () => {
    await expect(connect(0, 1)).resolves.toEqual({
      actorId,
      currentEpoch: 1,
      epoch: 0,
      readOnly: true,
      screenplayId: documentId,
      staleEpoch: true,
    });
  });

  it('denies an epoch the screenplay has never reached, with its own reason rather than a permission denial', async () => {
    let rejection: unknown;
    try {
      await connect(5, 1);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(UnknownDocumentEpochError);
    expect((rejection as UnknownDocumentEpochError).reason).toBe(
      UNKNOWN_DOCUMENT_EPOCH_FAILURE_REASON,
    );
    // Distinct from the transient bucket: there is no retry that makes an epoch exist, so a client
    // must not treat this as "try again".
    expect((rejection as UnknownDocumentEpochError).reason).not.toBe(
      TRANSIENT_SYNC_AUTH_FAILURE_REASON,
    );
  });

  /**
   * What every client built before this slice sends. Refused as malformed, and -- the part worth
   * asserting rather than assuming -- refused *before* the token is ever verified or any role query
   * runs, because a name this server cannot resolve to a (screenplay, epoch) pair is not a question
   * about access that a token or a role could answer.
   */
  it('refuses a bare screenplay id with no epoch, without verifying a token or querying a role', async () => {
    let verifyCalls = 0;
    let queryCalls = 0;
    await expect(
      authenticateConnection(
        {
          queryable: {
            async query() {
              queryCalls += 1;
              return { rows: [] };
            },
          },
          trustedOrigins,
          verifyToken: async () => {
            verifyCalls += 1;
            return { outcome: 'valid', actorId };
          },
        },
        {
          documentName: documentId,
          requestHeaders: headersWithOrigin(trustedOrigins[0]),
          token: 'a-valid-token',
          now,
        },
      ),
    ).rejects.toThrow('Malformed collaboration document name');
    expect(verifyCalls).toBe(0);
    expect(queryCalls).toBe(0);
  });
});

/**
 * The context `server.ts`'s `onAuthenticate` caches on the connection and every later hook reads
 * back. Validated rather than cast, and that validation is load-bearing since collaboration slice 5:
 * `onChange` appends an update under the epoch it finds here, so a partially-shaped context that
 * passed this check would be how an update written against a retired epoch got filed under the
 * current one.
 */
describe('readAuthenticatedConnectionContext', () => {
  const complete = {
    actorId,
    currentEpoch: 1,
    epoch: 0,
    readOnly: true,
    screenplayId: documentId,
    staleEpoch: true,
  };

  it('returns exactly the six fields, ignoring anything else the context carries', () => {
    expect(
      readAuthenticatedConnectionContext({ ...complete, presence: { name: 'A', color: '#fff' } }),
    ).toEqual(complete);
  });

  it('returns undefined for a context that is absent, not an object, or missing any single field', () => {
    expect(readAuthenticatedConnectionContext(undefined)).toBeUndefined();
    expect(readAuthenticatedConnectionContext(null)).toBeUndefined();
    expect(readAuthenticatedConnectionContext('a string')).toBeUndefined();
    for (const key of Object.keys(complete)) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[key];
      expect(readAuthenticatedConnectionContext(partial)).toBeUndefined();
    }
  });

  it('returns undefined when a field is present but of the wrong type', () => {
    expect(readAuthenticatedConnectionContext({ ...complete, epoch: '0' })).toBeUndefined();
    expect(readAuthenticatedConnectionContext({ ...complete, staleEpoch: 'yes' })).toBeUndefined();
  });
});

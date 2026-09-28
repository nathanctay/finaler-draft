import { errors, jwtVerify, SignJWT } from 'jose';

/**
 * The replacement for cookie-based WebSocket authentication (see the "Inserted slice" this
 * package implements). The first real, two-host deployment proved the Better Auth session
 * cookie cannot cross from `app`'s origin to `collab`'s: it is `httpOnly`, `secure`,
 * `sameSite: 'lax'`, host-only (no `Domain`, no `crossSubDomainCookies`), and `up.railway.app` is
 * a public suffix a `Domain` attribute cannot legally widen to. A signed, short-lived,
 * collab-scoped token that `apps/api` mints (over the same-origin session cookie it already has)
 * and the browser hands to Hocuspocus over the WebSocket's own `AuthenticationMessage` closes
 * that gap without ever exposing the real session token to JavaScript.
 *
 * **Signed JWT, not an opaque server-stored token.** An opaque token needs a database row to
 * validate against -- a table to write on every mint, a query on every connect (on top of the
 * role/entitlement queries `resolveConnectionAuthorization` already runs), and a cleanup job for
 * every token that expires unused. A self-contained signed token needs none of that: `apps/api`
 * and `apps/collab` already share the ability to agree on a secret (the same relationship
 * `BETTER_AUTH_SECRET` already has between them), and verification is a pure, local, stateless
 * computation. The one thing an opaque token would buy -- the ability to revoke a specific token
 * before it expires -- is not a property this slice needs: the token's own short lifetime already
 * bounds a leak's value, and revoking a *session* (signing out) is already handled by Better
 * Auth's own session store, unaffected by anything here.
 *
 * **Five minutes.** Long enough that an ordinary mint-then-connect round trip -- one HTTP request
 * to `apps/api`, then the WebSocket handshake to `apps/collab`, both on Railway's internal network
 * -- never races its own expiry even under real-world latency or a moment of clock skew between
 * the two service containers. Short enough that a token copied out of a browser's network panel,
 * a proxy log, or a crash dump is worthless within minutes, not hours. It is deliberately *not*
 * sized around a long user session: `configuration.token` accepting an async function
 * (`@hocuspocus/provider` 4.6.0's `getToken()`, called from `sendToken()` on every `onOpen`) means
 * every reconnection already fetches a fresh token on its own -- the lifetime only has to survive
 * one handshake, never a whole editing session.
 *
 * **Identifies the actor only.** The signed payload carries `sub` (the actor's user id) and
 * nothing about role or entitlement. This is the property the brief calls the single most
 * important one in this slice: if a reviewer's token carried `role: 'editor'`, or if role were
 * inferred from anything the client controls, a reviewer could forge editor access simply by
 * editing the token before it is even sent -- a signature proves the *claims* were not tampered
 * with, not that the claims describe the truth about a fast-changing, per-document fact like role
 * or entitlement. `apps/collab/src/authenticate.ts`'s `resolveConnectionAuthorization` keeps
 * resolving both, from the database, at connection time, exactly as it did before this slice --
 * this token only ever answers "who is asking," never "what may they do."
 */
const CONNECTION_TOKEN_PURPOSE = 'collab-connect';

/**
 * See this module's own top-of-file comment for the reasoning: long enough to absorb a real
 * mint-then-connect round trip and ordinary clock skew, short enough that a leaked token is
 * worthless within minutes.
 */
export const CONNECTION_TOKEN_TTL_MS = 5 * 60 * 1000;

const textEncoder = new TextEncoder();

/**
 * Signs a connection token for `actorId`, good for `CONNECTION_TOKEN_TTL_MS` from `now`. `now` is
 * a parameter, not `new Date()` read internally, so a test can mint a token that is already
 * expired (or about to be) without waiting on a real clock -- see `index.test.ts`'s expiry cases
 * and `verifyConnectionToken`'s own `now` parameter for the matching half of this.
 *
 * `secret` is `COLLAB_TOKEN_SECRET` -- deliberately not `BETTER_AUTH_SECRET`. Reusing the session
 * secret would work cryptographically, but a leak of this token-signing secret would then also
 * compromise Better Auth's own session tokens (and vice versa), and the two credentials protect
 * different things: a session cookie is a general-purpose REST credential, this token is scoped
 * to one purpose only. A dedicated secret keeps that scoping real rather than nominal.
 */
export async function mintConnectionToken(
  secret: string,
  actorId: string,
  now: Date,
): Promise<string> {
  return await new SignJWT({ purpose: CONNECTION_TOKEN_PURPOSE })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(actorId)
    .setIssuedAt(now)
    .setExpirationTime(new Date(now.getTime() + CONNECTION_TOKEN_TTL_MS))
    .sign(textEncoder.encode(secret));
}

/**
 * The three buckets `apps/collab/src/authenticate.ts` needs, and no finer-grained than that on
 * purpose: this module's only job is "does this token identify a real, currently-valid actor,"
 * never a role or entitlement decision. `'expired'` is split out from `'invalid'` because the two
 * must be treated completely differently one layer up -- an expired token is an ordinary,
 * expected event a reconnect resolves on its own (a fresh token, minted fresh); every other
 * failure (wrong signature, malformed, wrong purpose, absent) is not self-correcting and must be
 * a terminal denial. See `authenticate.ts`'s `ExpiredConnectionTokenError` for exactly where that
 * split gets used.
 */
export type ConnectionTokenVerification =
  | { outcome: 'valid'; actorId: string }
  | { outcome: 'expired' }
  | { outcome: 'invalid' };

/**
 * Verifies `token` against `secret`, as of `now` (see `mintConnectionToken`'s own comment on why
 * `now` is threaded through rather than read from the real clock).
 *
 * Every failure this function can distinguish collapses into exactly one of the two non-`'valid'`
 * outcomes above: `errors.JWTExpired` (jose's own dedicated error class for exactly this case,
 * confirmed by reading the installed 6.2.8 source -- `validateClaimsSet` throws it specifically
 * when `exp <= now`) becomes `'expired'`; a bad signature (`JWSSignatureVerificationFailed`, from
 * a token signed with a different secret), a malformed token (`JWTInvalid`, including an empty
 * string -- an absent token, since `@hocuspocus/server`'s own `AuthenticationMessage` reads an
 * empty `token` when the client configured none), and a syntactically valid, correctly-signed
 * token that is not actually a connection token (missing/wrong `purpose`, or a missing `sub`,
 * both checked explicitly after cryptographic verification succeeds -- a real, un-forgeable JWT
 * signed with this exact secret but issued for some other purpose must not be silently accepted
 * as one) all become `'invalid'`.
 */
export async function verifyConnectionToken(
  secret: string,
  token: string,
  now: Date,
): Promise<ConnectionTokenVerification> {
  if (!token) return { outcome: 'invalid' };
  try {
    const { payload } = await jwtVerify(token, textEncoder.encode(secret), {
      algorithms: ['HS256'],
      currentDate: now,
    });
    if (payload.purpose !== CONNECTION_TOKEN_PURPOSE) return { outcome: 'invalid' };
    if (typeof payload.sub !== 'string' || payload.sub === '') return { outcome: 'invalid' };
    return { outcome: 'valid', actorId: payload.sub };
  } catch (error) {
    if (error instanceof errors.JWTExpired) return { outcome: 'expired' };
    return { outcome: 'invalid' };
  }
}

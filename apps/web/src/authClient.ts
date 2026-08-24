import { createAuthClient } from 'better-auth/client';

/**
 * Better Auth's own client, used only for the password-reset and email-verification calls
 * (`requestPasswordReset`, `resetPassword`, `sendVerificationEmail`) -- sign-in/sign-up/sign-out
 * stay on the hand-rolled `request()`/`json()` helpers in api.ts, unchanged. Deliberately not a
 * wholesale switch: those three endpoints carry token/expiry handling this library already gets
 * right, and letting the SDK own that narrow, security-sensitive surface is worth one small
 * inconsistency in how a handful of requests are built.
 *
 * A fresh client per call, not a module-level singleton -- `createAuthClient` binds `fetch` once,
 * at construction, into its internal request layer (see the installed `better-auth/client`
 * config source, `customFetchImpl: fetch`) rather than reading `globalThis.fetch` per call. A
 * singleton built at import time would capture whatever `fetch` was global before a test ever
 * gets to stub it, silently reaching the real network. Constructing on demand costs nothing
 * measurable (it wraps a plain object; no connection is opened) and keeps every call bound to the
 * `fetch` in effect when it actually runs. No `baseURL` is passed: the installed client falls
 * back to `/api/auth` when unset in a browser context, which already matches where `createAuth`
 * (apps/api/src/auth.ts) mounts Better Auth -- the same default `credentials: 'include'` behavior
 * api.ts's own `request()` sets explicitly.
 */
export function authClient() {
  return createAuthClient();
}

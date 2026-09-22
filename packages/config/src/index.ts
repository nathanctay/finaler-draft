/**
 * Shared policy the browser legitimately needs. Server-only environment parsing lives in
 * `@finaler-draft/server-config` instead, so the browser bundle has no import path to the shape
 * of the server's environment, even by accident.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_REQUIREMENTS_MESSAGE = `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`;

/**
 * The port `apps/collab` (the Hocuspocus collaboration server) binds to in a real local
 * `pnpm dev` run, absent an explicit `COLLAB_PORT` override (`apps/collab/src/environment.ts`'s
 * `resolveCollabPort`) -- and the port `apps/web`'s dev server points its own default
 * `VITE_COLLAB_WS_URL` fallback at (`collabConfig.ts`), so the two halves of `pnpm dev` find each
 * other with no configuration. A single exported number, not two independently-maintained
 * literals, because this is exactly the shape `@finaler-draft/config` exists for: a plain,
 * secret-free constant two otherwise-unrelated processes (one server, one browser bundle) both
 * need to agree on, not the shape of either one's environment.
 *
 * Picked clear of the API's default port (3001), Vite's (5173), the landing app's (4321), and the
 * Playwright harnesses' (4173-4175). Not Hocuspocus's own conventional default of 1234: that port
 * is a well-known, often-squatted one -- frequently already bound by unrelated local tooling, and
 * close enough to the privileged range to invite exactly the kind of collision this exists to
 * remove.
 */
export const DEFAULT_COLLAB_DEV_PORT = 4400;

/**
 * The `authenticationFailed` `reason` string `apps/collab`'s `onAuthenticate` hook
 * (`authenticate.ts`) tags an *unexpected* error with -- a thrown database/session-lookup
 * failure during the handshake (a Postgres blip, a dropped pool connection), as distinct from a
 * resolved, deliberate denial (wrong Origin, no session, or a role lookup that genuinely resolved
 * to "not visible to this account"). `@hocuspocus/server`'s own `onAuthenticate` contract already
 * forwards a thrown error's `.reason` property verbatim to the client's `authenticationFailed`
 * event (confirmed by reading the installed 4.6.0 source: `error.reason ?? "permission-denied"`)
 * -- this constant is the one value both sides need to agree on to use that existing channel
 * instead of inventing a second one. Shared here, not duplicated as two string literals in
 * `apps/collab` and `apps/web`, because a typo in either copy would silently misclassify every
 * transient failure as permanent (or vice versa) with no type error to catch it -- exactly the
 * failure mode `DEFAULT_COLLAB_DEV_PORT` above already exists to prevent for a different pair of
 * literals.
 */
export const TRANSIENT_SYNC_AUTH_FAILURE_REASON = 'transient-authentication-error';

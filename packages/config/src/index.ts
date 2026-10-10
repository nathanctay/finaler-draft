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

/**
 * The `authenticationFailed` `reason` string `apps/collab` tags a connection request for an epoch
 * this screenplay has never reached (`authenticate.ts`'s `UnknownDocumentEpochError`). Shared for
 * the identical reason `TRANSIENT_SYNC_AUTH_FAILURE_REASON` above is: both sides must agree on the
 * literal, and a typo in either copy would silently reclassify the denial.
 *
 * Note which direction this covers. A connection asking for an epoch *older* than the screenplay's
 * current one is not denied at all -- it is admitted read-only so its unsynced work can be
 * retained (see `apps/collab/src/authenticate.ts`), and is told via the restore stateless message
 * below. This reason is only for the impossible direction: an epoch the server has never issued.
 */
export const UNKNOWN_DOCUMENT_EPOCH_FAILURE_REASON = 'unknown-document-epoch';

/**
 * The separator between a screenplay id and its collaboration epoch in a Hocuspocus document name
 * (`<screenplayId>:<epoch>`). Collaboration slice 5 (restore-as-current, plan.md's "Restore as
 * current") makes the epoch part of the document's *identity* rather than a parameter alongside it:
 * a restore is a cutover to a new collaboration document, and naming that document after the epoch
 * it belongs to is what makes "the server rejects writes to the old epoch" structural rather than a
 * check that could be forgotten. It is also what keeps a browser's own `y-indexeddb` database for
 * the pre-restore document separate from the restored one, so an offline client's unsynced work can
 * never merge into the restored screenplay by simply reconnecting (plan.md step 5: "never
 * auto-merged").
 *
 * A UUID contains no `:`, so this parses unambiguously from the right.
 */
export const COLLAB_DOCUMENT_NAME_SEPARATOR = ':';

/** The Hocuspocus document name for one screenplay at one epoch. The single source of this format
 * for every process that needs it: `apps/web` (the provider's `name` and its IndexedDB database
 * key), and `apps/collab` (which parses it back). */
export function formatCollabDocumentName(screenplayId: string, epoch: number): string {
  return `${screenplayId}${COLLAB_DOCUMENT_NAME_SEPARATOR}${epoch}`;
}

/**
 * The inverse of `formatCollabDocumentName`. `undefined` for anything that is not exactly
 * `<non-empty id>:<non-negative integer>` -- including a bare screenplay id with no epoch at all,
 * which is what every client built before this slice sent. That is deliberate: such a connection is
 * rejected rather than silently treated as epoch 0, because a client that cannot name an epoch also
 * cannot be told when the one it holds stops being current.
 */
export function parseCollabDocumentName(
  name: string,
): { screenplayId: string; epoch: number } | undefined {
  const separatorIndex = name.lastIndexOf(COLLAB_DOCUMENT_NAME_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === name.length - 1) return undefined;
  const screenplayId = name.slice(0, separatorIndex);
  const epochText = name.slice(separatorIndex + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(epochText)) return undefined;
  const epoch = Number(epochText);
  if (!Number.isSafeInteger(epoch)) return undefined;
  return { screenplayId, epoch };
}

/**
 * The `type` of the stateless message `apps/collab` broadcasts to every connection still attached
 * to a superseded epoch's document after a restore commits (plan.md step 4: "Connected clients
 * receive a restore event and reload the new epoch"). Hocuspocus's own stateless channel is used
 * rather than a new transport: it already reaches exactly the connections for one document name,
 * and `@hocuspocus/provider` already surfaces it as a `stateless` event.
 */
export const COLLAB_RESTORED_MESSAGE_TYPE = 'screenplay-restored';

/** The payload shape of `COLLAB_RESTORED_MESSAGE_TYPE`. `epoch` is the *new* current epoch, so a
 * client can reconnect to the restored document without a second round trip to the API. */
export interface CollabRestoredMessage {
  type: typeof COLLAB_RESTORED_MESSAGE_TYPE;
  epoch: number;
}

export function encodeCollabRestoredMessage(epoch: number): string {
  return JSON.stringify({ type: COLLAB_RESTORED_MESSAGE_TYPE, epoch });
}

/** Parses a stateless payload, returning the restore message only when the payload really is one.
 * Every other stateless payload (there are none today, but a stateless channel is shared by
 * definition) returns `undefined` rather than being coerced. */
export function parseCollabRestoredMessage(payload: string): CollabRestoredMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const candidate = parsed as { type?: unknown; epoch?: unknown };
    if (candidate.type !== COLLAB_RESTORED_MESSAGE_TYPE) return undefined;
    if (typeof candidate.epoch !== 'number' || !Number.isSafeInteger(candidate.epoch))
      return undefined;
    if (candidate.epoch < 0) return undefined;
    return { type: COLLAB_RESTORED_MESSAGE_TYPE, epoch: candidate.epoch };
  } catch {
    return undefined;
  }
}

import type { MailPort } from '@finaler-draft/auth-server/mail';

/**
 * `createAuth` (`@finaler-draft/auth-server`) requires a `MailPort` unconditionally, because it
 * wires `sendResetPassword`/`sendVerificationEmail` regardless of caller. This service never
 * mounts Better Auth's HTTP handler -- it only ever calls `auth.api.getSession(...)` to verify an
 * existing session on a WebSocket handshake (`authenticate.ts` and `server.ts`) -- so those two
 * callbacks can never actually fire. Throwing rather than silently logging (`createLoggingMailPort`,
 * the choice a real server process makes when mail is genuinely unconfigured) is deliberate: if
 * this ever *does* fire, that means this service started handling a password-reset or
 * verification flow it was never meant to, and a loud failure is more honest than a mail message
 * this service has no way to have actually sent.
 */
export const unreachableMailPort: MailPort = {
  send() {
    throw new Error(
      'apps/collab never sends mail -- it only verifies existing sessions. Reaching this means ' +
        "something started routing an auth flow through this service that shouldn't be here.",
    );
  },
};

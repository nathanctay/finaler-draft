/**
 * The WebSocket-handshake equivalent of `apps/api/src/app.ts`'s `isTrustedOrigin`. plan.md's
 * deployment-topology section states the reason plainly: "The Hocuspocus WebSocket handshake is
 * cross-origin but same-site. CORS does not apply to WebSockets and browsers perform no
 * preflight, so the server must validate the `Origin` header itself. Because Hocuspocus
 * authenticates from a cookie the browser attaches automatically, an unvalidated `Origin` is a
 * cross-site WebSocket hijacking vulnerability."
 *
 * Unlike `isTrustedOrigin`, there is no safe-method carve-out here: every WebSocket connection
 * this server accepts can eventually try to write (write rejection is enforced separately, in
 * `authenticate.ts`, by role/entitlement), so an absent or untrusted `Origin` is refused
 * unconditionally rather than only for "unsafe methods." A real browser always attaches `Origin`
 * to a cross-origin WebSocket handshake; an absent header here means the connecting client is not
 * a browser honouring the fetch/WebSocket spec, which this server has no reason to trust either.
 */
export function isTrustedConnectionOrigin(
  originHeader: string | null | undefined,
  trustedOrigins: readonly string[],
): boolean {
  if (!originHeader) return false;
  try {
    return trustedOrigins.includes(new URL(originHeader).origin);
  } catch {
    return false;
  }
}

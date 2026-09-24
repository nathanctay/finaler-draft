/**
 * Awareness sanitization: the server-side half of what `packages/screenplay-editor/src/
 * presence.ts` (that module's own top-of-file comment has the full design) reads on every other
 * connected client. Wired into `server.ts`'s `beforeHandleAwareness` hook.
 *
 * The trust boundary this module exists for is the identical one slice 1 established for writes
 * (`authenticate.ts`'s own module comment: "a collaboration server that trusts its clients is a
 * data-integrity problem, not merely a permissions gap") applied to *identity* instead of content:
 * a connected browser can claim to be anyone in its own local awareness state, and every other
 * connected client would otherwise render that claim verbatim. `sanitizeAwarenessStates` rewrites
 * every inbound awareness update to carry only the fields this application defines, with `name`/
 * `color` always replaced by the value this server derives from the *authenticated* connection's
 * own actor id -- never by what the client sent.
 */
import type { Queryable } from './authenticate.js';

/** A small, fixed, accessible palette -- not derived from CSS custom properties, since this file
 * never touches a browser: chosen for reasonable contrast against both this app's light and dark
 * manuscript backgrounds (`apps/web/src/styles.css`'s `--surface-*`/`--text-*` tokens), the same
 * bar `packages/screenplay-editor`'s remote-cursor label already has to clear. Order matters only
 * in that it must never change once shipped -- reordering would reassign every existing writer's
 * colour on the next deploy, precisely the confusion the owner's "stable per user, not session"
 * decision (presence.ts's own comment) exists to avoid. */
const PARTICIPANT_COLOR_PALETTE = [
  '#e11d48', // rose
  '#ea580c', // orange
  '#ca8a04', // amber (darkened from the usual yellow for contrast)
  '#16a34a', // green
  '#0d9488', // teal
  '#2563eb', // blue
  '#7c3aed', // violet
  '#db2777', // pink
] as const;

/**
 * A deterministic hash of `actorId` into `PARTICIPANT_COLOR_PALETTE`. Stable per user across
 * reconnects and across devices (the same account always lands on the same slot), at the
 * documented cost of two accounts occasionally colliding on the same colour -- see presence.ts's
 * own comment on why that tradeoff was chosen deliberately over a per-session assignment.
 *
 * A plain string hash (FNV-1a), not a cryptographic one: this only ever needs to be a stable,
 * well-distributed index into an 8-slot palette, never a security property -- an id is never
 * recovered from a colour, but nothing here relies on that being infeasible either.
 */
export function deriveParticipantColor(actorId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < actorId.length; i += 1) {
    hash ^= actorId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const index = (hash >>> 0) % PARTICIPANT_COLOR_PALETTE.length;
  return PARTICIPANT_COLOR_PALETTE[index]!;
}

/** The one query this module needs: the display name Better Auth's signup form already requires
 * (`packages/database/src/schema.ts`'s `user.name`, `not null`) for the actor a connection has
 * already been authenticated as. Resolved once, in `onAuthenticate` (server.ts), and cached on the
 * connection's own context for the life of the connection -- not re-queried on every awareness
 * update, which can fire as often as every keystroke's caret move. */
export async function fetchDisplayName(queryable: Queryable, actorId: string): Promise<string> {
  const result = await queryable.query('select name from "user" where id = $1', [actorId]);
  const row = result.rows[0] as { name?: string } | undefined;
  // Falls back rather than throwing: a race where the account row disappeared between
  // authentication and this lookup is not this connection's fault to fail loudly over, and a
  // generic label is a strictly better failure mode than dropping the connection.
  return row?.name && row.name.trim() !== '' ? row.name : 'A collaborator';
}

/** The identity this server attaches to every awareness update a given connection sends -- see
 * this module's own top-of-file comment on why the client never computes either field itself. */
export type ServerPresenceIdentity = { readonly name: string; readonly color: string };

export async function resolvePresenceIdentity(
  queryable: Queryable,
  actorId: string,
): Promise<ServerPresenceIdentity> {
  return {
    name: await fetchDisplayName(queryable, actorId),
    color: deriveParticipantColor(actorId),
  };
}

/** Structural validation only -- this module never decodes a Yjs relative position (that is
 * `y-prosemirror`'s job, entirely client-side); it only confirms the shape is plausible enough
 * that a downstream `Y.createRelativePositionFromJSON` will not throw on garbage. Anything else is
 * dropped rather than causing this update -- or the whole connection -- to fail: a client sending
 * a cursor while unfocused, or a peer running a slightly different client, both need this to fail
 * quietly into "no cursor shown", the natural default. */
function sanitizeCursor(value: unknown): { anchor: unknown; head: unknown } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { anchor?: unknown; head?: unknown };
  if (typeof candidate.anchor !== 'object' || candidate.anchor === null) return undefined;
  if (typeof candidate.head !== 'object' || candidate.head === null) return undefined;
  return { anchor: candidate.anchor, head: candidate.head };
}

/** Never re-stamped from the server's own clock (see this module's top-of-file comment and
 * `packages/screenplay-editor/src/presence.ts`'s own comment on why only the client can tell a
 * real keystroke apart from the periodic awareness heartbeat) -- only clamped so a client cannot
 * claim to have been active arbitrarily far in the future, which would otherwise keep it looking
 * "present" indefinitely regardless of `PRESENCE_ACTIVE_WINDOW_MS`. A missing or malformed value
 * becomes `0` -- as old as a timestamp can be -- rather than "now": absence must never read as
 * activity. */
function clampLastActiveAt(value: unknown, now: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(value, now) : 0;
}

/**
 * Rewrites `states` in place to exactly the shape `packages/screenplay-editor/src/presence.ts`
 * expects, attributing identity to the *connection*, never to what the client claimed.
 *
 * `states` is *not* reliably one entry per message -- confirmed directly against a real
 * `HocuspocusProvider`/`Awareness` pair (`collaboration.integration.test.ts`'s identity test),
 * not assumed: `y-protocols/awareness`'s own batching (`HocuspocusProviderWebsocket
 * .awarenessUpdateHandler`, which coalesces `added`/`updated`/`removed` client ids arriving within
 * one flush window into a single outbound message) can legitimately bundle more than one client id
 * from a single browser tab, e.g. a stale prior client id being cleared alongside the current one
 * being set. An earlier version of this function rejected (cleared) any message naming more than
 * one client id, on the theory that a single connection's `Awareness` only ever reports its own
 * state -- that theory was correct in spirit but wrong about the cardinality, and the stricter
 * check silently dropped this exact legitimate case, which is how the gap was found.
 *
 * The identity guarantee does not depend on that cardinality assumption, and still holds without
 * it: *every* entry in `states` -- however many -- gets its `user` field replaced with the
 * *connection's own authenticated identity*, never with anything the client claimed. A connection
 * cannot make an entry carry another peer's real identity (the server only ever knows one identity
 * per authenticated connection), so the spoofing this hook exists to close stays closed; what
 * changes is only that a single connection's own multi-client-id housekeeping message is no longer
 * mistaken for that attack and dropped.
 */
export function sanitizeAwarenessStates(
  states: Map<number, Record<string, unknown>>,
  identity: ServerPresenceIdentity,
  now: number = Date.now(),
): void {
  for (const [clientId, state] of states) {
    const rawUser = (state as { user?: { lastActiveAt?: unknown } }).user;
    const sanitizedUser = {
      name: identity.name,
      color: identity.color,
      lastActiveAt: clampLastActiveAt(rawUser?.lastActiveAt, now),
    };
    const cursor = sanitizeCursor((state as { cursor?: unknown }).cursor);
    states.set(clientId, cursor ? { user: sanitizedUser, cursor } : { user: sanitizedUser });
  }
}

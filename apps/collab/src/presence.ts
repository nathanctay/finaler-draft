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

/**
 * A small, fixed palette -- not derived from CSS custom properties, since this file never touches a
 * browser. Order matters only in that it must never change once shipped: reordering would reassign
 * every existing writer's colour on the next deploy, precisely the confusion the owner's "stable
 * per user, not session" decision (`packages/screenplay-editor/src/presence.ts`'s own comment)
 * exists to avoid.
 *
 * Every entry is held to four measured properties, all of them computed rather than eyeballed by
 * `participantPalette.test.ts` (that file carries the before/after numbers, and
 * `progress/contrast-and-participant-palette.md` the argument):
 *
 *  1. **The caret clears 3:1 against the white manuscript sheet** (WCAG 1.4.11; the caret is a 2px
 *     painted stripe, so it is non-text). The palette this replaced put amber at 2.94:1 -- a cursor
 *     that was hard for *everyone* to see, independent of any colour-vision question.
 *  2. **The name label's text clears APCA Lc 60 against the colour itself** (the set below measures
 *     63.3 at its worst), with the text painted in whichever of paper-white or manuscript ink reads
 *     better by that metric (`@finaler-draft/screenplay-editor`'s `participantLabelTextColor`). It
 *     is every entry here that is dark enough for paper-white, so every label reads white. Per-
 *     colour choice alone does not rescue an arbitrary palette -- against the previous one, orange,
 *     green and teal failed with *either* choice -- so this constraint is on the colours, not only
 *     on the painter.
 *
 *     This row was WCAG 1.4.3's 4.5:1 when the palette was chosen, and the switch to APCA is why
 *     the colours below are no longer the ones that rule would pick: orange, teal and violet
 *     measure 3.11-3.16:1 with the white they are now painted in, so those three labels do not meet
 *     1.4.3 at normal text size. Deliberate, and the reasoning is in `contrast.ts`: WCAG's ratio
 *     mis-ranks paper against ink on exactly this kind of mid-toned saturated colour, and the dark
 *     ink it chose for those three was visibly the less legible of the two options.
 *  3. **Each colour stays dE2000 >= 25 from the manuscript's own ink** under normal vision (the set
 *     below measures 30.1 at its closest). This is the constraint that rules out the obvious way to
 *     satisfy (1) and (2) together, which is to make all eight colours very dark: a near-black caret
 *     is legible but unreadable as *someone else's*, indistinguishable from the writer's own. It is
 *     the one property the palette this replaced did *not* fail.
 *  4. **Mutually distinguishable under normal vision and all three dichromacies.** The palette this
 *     replaced collapsed here: blue and violet simulate to the same colour under deuteranopia, and
 *     green and teal nearly do under tritanopia.
 *
 * (1) and (2) together were a genuine squeeze while (2) was WCAG's 4.5:1, and these eight still
 * carry its marks: a colour light enough for ink text sat in a luminance window barely 4% wide,
 * which is why orange, teal and violet all land within a few hundredths of 3.1:1 against the sheet,
 * and why the set as a whole is more muted than the vivid one it replaces. Under APCA that squeeze
 * is gone -- the constraint is only "dark enough for white", which these clear with room -- but the
 * palette was kept exactly as it was, because the owner had already judged these colours by eye and
 * wanted them. Retuning it now would only be to satisfy a metric no longer being used.
 *
 * The alternative considered and rejected -- a fixed dark label background with the participant
 * colour as a mere accent, which would leave only (1) binding -- measured *worse*, not better: an
 * accent must also clear 3:1 against that dark label, which squeezes every colour into a narrower
 * luminance band than (1) and (2) do, and luminance is the one channel dichromats still have. See
 * `progress/contrast-and-participant-palette.md` for both sets of numbers.
 */
export const PARTICIPANT_COLOR_PALETTE = [
  '#b85162', // rose
  '#be865b', // orange
  '#887306', // amber
  '#015a1e', // green
  '#10a2a0', // teal
  '#345fdf', // blue
  '#af79e2', // violet
  '#9e0067', // pink
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

/**
 * The finite set of title-page fields a cursor may name -- mirrors `apps/web/src/
 * titlePageEditor.tsx`'s own `TitlePageFieldName` union, duplicated here rather than imported: this
 * package is server-only and must never depend on `apps/web`, the same reason `sanitizeCursor`
 * above validates the body cursor's shape without importing anything from `y-prosemirror`. Kept as
 * a finite whitelist, not "any non-empty string", because the client that receives this value
 * builds a `document.querySelector('[data-title-page-field="..."]')` attribute selector directly
 * from it (`apps/web/src/titlePageCursors.ts`) -- an unbounded string could otherwise carry
 * selector-breaking characters into a peer's browser, whereas a value outside this set is simply
 * dropped here before it ever reaches one.
 */
const TITLE_PAGE_CURSOR_FIELDS = new Set([
  'title',
  'credit',
  'source',
  'draft-date',
  'author',
  'contact',
]);

/** Structural validation for the title page's own cursor field (this slice's addition). Plain
 * data, not a Yjs relative position -- a title-page field is a last-write-wins string, not a
 * `Y.Text` (`progress/collaboration-title-page.md`), so there is no relative-position concept to
 * decode here at all, unlike `sanitizeCursor` above. `offset`/`lineIndex` are still only ever
 * checked for a plausible shape, never trusted as *correct* for the field's current length --
 * that clamping is the client's own job (`apps/web/src/titlePageCursors.ts`), since only the
 * client can measure the field's live DOM text. */
function sanitizeTitlePageCursor(
  value: unknown,
): { field: string; lineIndex?: number; offset: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { field?: unknown; lineIndex?: unknown; offset?: unknown };
  if (typeof candidate.field !== 'string' || !TITLE_PAGE_CURSOR_FIELDS.has(candidate.field)) {
    return undefined;
  }
  if (!Number.isInteger(candidate.offset) || (candidate.offset as number) < 0) return undefined;
  if (candidate.lineIndex !== undefined) {
    if (!Number.isInteger(candidate.lineIndex) || (candidate.lineIndex as number) < 0) {
      return undefined;
    }
    return {
      field: candidate.field,
      lineIndex: candidate.lineIndex as number,
      offset: candidate.offset as number,
    };
  }
  return { field: candidate.field, offset: candidate.offset as number };
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
 *
 * `titlePageCursor` (this slice's addition) is sanitized the same way `cursor` already is --
 * structurally validated and passed through unchanged if valid, dropped silently otherwise -- and
 * carries no identity of its own to overwrite, so it needs nothing beyond that.
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
    const titlePageCursor = sanitizeTitlePageCursor(
      (state as { titlePageCursor?: unknown }).titlePageCursor,
    );
    const sanitized: Record<string, unknown> = { user: sanitizedUser };
    if (cursor) sanitized.cursor = cursor;
    if (titlePageCursor) sanitized.titlePageCursor = titlePageCursor;
    states.set(clientId, sanitized);
  }
}

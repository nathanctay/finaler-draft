import {
  MEMBERSHIP_CHANGED_NOTIFY_CHANNEL,
  parseMembershipChangedNotification,
  type MembershipChangedNotification,
} from '@finaler-draft/database';
import { startNotificationListener, type NotificationClient } from './restoreNotifications.js';

/**
 * The screenplay-invitations slice's answer to "what happens to an open socket when someone is
 * demoted or removed."
 *
 * `resolveConnectionAuthorization` (authenticate.ts) resolves role and entitlement exactly once,
 * at connection time -- correct for the question it answers, but it means a demotion or a removal
 * performed in `apps/api` has no effect at all on a connection that is already established. For a
 * writer who leaves a tab open, "takes effect on their next reconnect" is unbounded, and a removed
 * member who keeps writing is the one outcome this slice is not allowed to ship.
 *
 * **What this does: closes the account's sockets, and nothing else.** It does not try to re-derive
 * the new authorization here. Closing makes the provider reconnect (`@hocuspocus/provider`
 * reconnects on an unexpected close by default), and the reconnect runs the *real*
 * `onAuthenticate` against the database -- so a removed member is denied outright (`apps/web`
 * shows its terminal "access could not be confirmed" banner and never retries), and a member
 * demoted from editor to reviewer comes back `readOnly`, with their further keystrokes dropped by
 * Hocuspocus's own low-level check and retained in `document_yjs_quarantined_updates` exactly as
 * any other reviewer's are. One mechanism covers both cases, and neither case depends on this
 * process reasoning about roles -- the database stays the only authority.
 *
 * **Why close rather than force `readOnly`.** `supersedeRestoredDocuments` deliberately does *not*
 * close, because a superseded document's holders have legitimately retained read access and the
 * stateless message tells them everything they need. This is the opposite situation: a removed
 * member has lost read access too, so leaving the socket open and merely read-only would keep
 * streaming them a document they are no longer allowed to see. Closing is the only action that is
 * correct for removal, and it is also correct for demotion, so it is the only action taken.
 */

/** The one member of Hocuspocus's own `Connection` this module touches, plus the `context` it needs
 * to tell whose connection it is -- named as an interface for the same reason
 * `LiveCollabConnection` is, so the selection logic can be exercised against plain objects with no
 * WebSocket and no running server. */
export interface ClosableCollabConnection {
  context: unknown;
  close(): void;
}

export interface MembershipLiveCollabDocument {
  name: string;
  connections: Iterable<readonly [ClosableCollabConnection, unknown]>;
}

export interface DisconnectResult {
  /** How many connections were closed -- for the log line, so a demotion or removal in production
   * leaves a record that it actually reached the live connections. */
  closedConnections: number;
  /** The document names those connections belonged to. */
  affectedDocuments: string[];
}

/**
 * Closes every live connection held by `notification.userId`, across every document this process
 * holds.
 *
 * Deliberately not narrowed to the project or screenplay whose membership changed: the
 * notification payload names only the account (see `MEMBERSHIP_CHANGED_NOTIFY_CHANNEL`'s own
 * comment). Over-inclusion costs an unaffected document a brief reconnect that re-reads the
 * database and resolves identically; under-inclusion would be the removed-member-still-writing
 * case. A reconnect can never grant access, so there is no risk on the permissive side of this
 * trade, only on the restrictive one.
 *
 * The actor id is read off each connection's own `context` -- the object `onAuthenticate` returned
 * for it, which is where `authenticateConnection`'s verified `actorId` lives. It is never taken
 * from the notification and matched against anything a client supplied.
 */
export function disconnectMembershipChangedConnections(
  documents: Iterable<MembershipLiveCollabDocument>,
  notification: MembershipChangedNotification,
): DisconnectResult {
  const affectedDocuments: string[] = [];
  let closedConnections = 0;
  for (const document of documents) {
    let affected = false;
    for (const [connection] of document.connections) {
      if (actorIdOf(connection.context) !== notification.userId) continue;
      connection.close();
      closedConnections += 1;
      affected = true;
    }
    if (affected) affectedDocuments.push(document.name);
  }
  return { affectedDocuments, closedConnections };
}

/** Reads the verified `actorId` off a connection's Hocuspocus `context`. Validated rather than
 * cast, matching `readAuthenticatedConnectionContext`: `context` is `any` in Hocuspocus's own
 * types and is genuinely `undefined` for a server-internal `DirectConnection`, and a connection
 * with no identity must simply not match rather than crash this listener. */
function actorIdOf(context: unknown): string | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  const candidate = context as { actorId?: unknown };
  return typeof candidate.actorId === 'string' ? candidate.actorId : undefined;
}

export interface StartMembershipNotificationListenerOptions {
  connect: () => Promise<NotificationClient>;
  onMembershipChanged: (notification: MembershipChangedNotification) => void;
  onError: (error: unknown) => void;
  retryDelayMs?: number;
  setTimeoutFn?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Subscribes to `MEMBERSHIP_CHANGED_NOTIFY_CHANNEL`, reusing `restoreNotifications.ts`'s own
 * generic listener rather than restating its reconnect/dispose logic -- that logic (one dedicated
 * connection because `LISTEN` is session state, abandon-and-retry on failure, a `started` promise a
 * test can await instead of sleeping) is identical for both channels, and the window in which this
 * process is deaf to a notification is exactly as consequential here as it is there.
 */
export function startMembershipNotificationListener(
  options: StartMembershipNotificationListenerOptions,
) {
  return startNotificationListener({
    channel: MEMBERSHIP_CHANGED_NOTIFY_CHANNEL,
    connect: options.connect,
    onError: options.onError,
    onPayload: (payload) => {
      const notification = parseMembershipChangedNotification(payload);
      if (notification) options.onMembershipChanged(notification);
    },
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.setTimeoutFn === undefined ? {} : { setTimeoutFn: options.setTimeoutFn }),
    ...(options.clearTimeoutFn === undefined ? {} : { clearTimeoutFn: options.clearTimeoutFn }),
  });
}

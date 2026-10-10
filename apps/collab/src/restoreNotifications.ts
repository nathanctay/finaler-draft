import { encodeCollabRestoredMessage, parseCollabDocumentName } from '@finaler-draft/config';
import { SCREENPLAY_RESTORED_NOTIFY_CHANNEL } from '@finaler-draft/database';

/**
 * Collaboration slice 5, plan.md step 4: "Connected clients receive a restore event and reload the
 * new epoch."
 *
 * The restore itself commits in `apps/api` (`restore.ts` -> `@finaler-draft/database`'s
 * `restoreRevisionAsCurrent`), a different process from the one holding the live WebSocket
 * connections. Postgres `LISTEN`/`NOTIFY` is how the news crosses that boundary: the restore
 * transaction issues its `pg_notify` *inside* the transaction, so the notification is delivered if
 * and only if the cutover commits, and this process subscribes to the same channel over the database
 * connection it already has credentials for. No new environment variable, no service-to-service
 * HTTP, and no knowledge in `apps/api` of where this service is deployed.
 *
 * **Why a dedicated client, not the shared pool.** A `LISTEN` is session state: it belongs to one
 * backend connection for as long as that connection lives. A pooled client would carry the
 * subscription back into the pool and hand it to the next unrelated query, and a pooled client that
 * is recycled loses the subscription silently. So this owns one connection outright, and reconnects
 * it on failure.
 */

/** The subset of `pg`'s `Client` this module uses, named as an interface so the reconnect/dispatch
 * logic below can be unit-tested against a stub with no database at all. `server.ts` adapts a real
 * `Client` to it at the one call site. */
export interface NotificationClient {
  listen(channel: string): Promise<void>;
  onNotification(listener: (payload: string | undefined) => void): void;
  /** Invoked for a connection-level failure (`pg`'s own `error` event, or the socket ending). The
   * listener is expected to trigger a reconnect, which is why this module never also treats it as
   * fatal. */
  onFailure(listener: (error: unknown) => void): void;
  close(): Promise<void>;
}

export interface RestoreNotification {
  screenplayId: string;
  epoch: number;
}

/**
 * Parses a `pg_notify` payload into a restore notification, or `undefined` for anything that is not
 * one. Validated rather than trusted even though this process writes nothing to the channel itself:
 * a notification payload is a string arriving from outside this process, and `JSON.parse` on an
 * unexpected shape followed by arithmetic on `undefined` is how a listener turns someone else's
 * mistake into a crash loop.
 */
export function parseRestoreNotification(
  payload: string | undefined,
): RestoreNotification | undefined {
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const candidate = parsed as { screenplayId?: unknown; epoch?: unknown };
    if (typeof candidate.screenplayId !== 'string' || candidate.screenplayId.length === 0)
      return undefined;
    if (typeof candidate.epoch !== 'number' || !Number.isSafeInteger(candidate.epoch)) {
      return undefined;
    }
    if (candidate.epoch < 0) return undefined;
    return { epoch: candidate.epoch, screenplayId: candidate.screenplayId };
  } catch {
    return undefined;
  }
}

export interface RestoreNotificationListener {
  /** Resolves once the subscription is established (or has failed and scheduled its first retry) --
   * what a test awaits instead of sleeping. */
  readonly started: Promise<void>;
  dispose(): Promise<void>;
}

export interface StartRestoreNotificationListenerOptions {
  connect: () => Promise<NotificationClient>;
  onRestored: (notification: RestoreNotification) => void;
  onError: (error: unknown) => void;
  /** How long to wait before re-establishing a dropped subscription. Injectable for tests; the
   * default is deliberately short, because the window in which this process is deaf to restores is a
   * window in which a writer can keep editing a document that is no longer live. */
  retryDelayMs?: number;
  /** Injectable timer, so a test never has to wait out a real delay. */
  setTimeoutFn?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_RETRY_DELAY_MS = 2_000;

/**
 * Subscribes to `SCREENPLAY_RESTORED_NOTIFY_CHANNEL` and calls `onRestored` for every valid
 * notification, re-establishing the subscription if the connection fails. `dispose()` stops
 * retrying and closes the current connection; it is safe to call before the first connection has
 * even been established (a shutdown during startup), and after a failure.
 */
export function startRestoreNotificationListener(
  options: StartRestoreNotificationListenerOptions,
): RestoreNotificationListener {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  let disposed = false;
  let client: NotificationClient | undefined;
  let retryHandle: ReturnType<typeof setTimeout> | undefined;

  function scheduleRetry(): void {
    if (disposed || retryHandle !== undefined) return;
    retryHandle = setTimeoutFn(() => {
      retryHandle = undefined;
      void subscribe();
    }, retryDelayMs);
  }

  async function subscribe(): Promise<void> {
    if (disposed) return;
    try {
      const connected = await options.connect();
      if (disposed) {
        await connected.close();
        return;
      }
      client = connected;
      connected.onNotification((payload) => {
        const notification = parseRestoreNotification(payload);
        if (notification) options.onRestored(notification);
      });
      connected.onFailure((error) => {
        options.onError(error);
        // The failed client is abandoned rather than closed: a connection that just errored is not
        // one to run more commands on, and `pg` has already torn its socket down by this point.
        if (client === connected) client = undefined;
        scheduleRetry();
      });
      await connected.listen(SCREENPLAY_RESTORED_NOTIFY_CHANNEL);
    } catch (error) {
      options.onError(error);
      client = undefined;
      scheduleRetry();
    }
  }

  const started = subscribe();

  return {
    started,
    async dispose() {
      disposed = true;
      if (retryHandle !== undefined) {
        clearTimeoutFn(retryHandle);
        retryHandle = undefined;
      }
      await started.catch(() => undefined);
      const current = client;
      client = undefined;
      if (current) await current.close().catch(() => undefined);
    },
  };
}

/** The two members of Hocuspocus's own `Connection` this module touches, named as an interface for
 * the same reason `NotificationClient` is: so the superseding logic can be exercised directly
 * against plain objects, with no WebSocket and no running server. */
export interface LiveCollabConnection {
  readOnly: boolean;
  sendStateless(payload: string): void;
}

/** The two members of Hocuspocus's own `Document` this module touches. `connections` is typed as an
 * iterable of entries rather than a `Map` so a real `Document.connections` (a
 * `Map<Connection, { clients: Set<unknown> }>`) satisfies it without a cast. */
export interface LiveCollabDocument {
  name: string;
  connections: Iterable<readonly [LiveCollabConnection, unknown]>;
}

export interface SupersedeResult {
  /** The document names that were superseded -- for the log line, so a restore in production leaves
   * a record of exactly which live documents it retired. */
  supersededDocuments: string[];
  notifiedConnections: number;
}

/**
 * What a committed restore does to the connections this process is already holding. For every live
 * document belonging to the restored screenplay at an epoch *older* than the new one:
 *
 *  1. Every connection is forced read-only. This is the half that a stale-epoch connection
 *     established *after* the restore already gets from `authenticate.ts`; a connection that was
 *     authenticated while its epoch was still current needs it applied here instead, or its next
 *     keystroke would be appended to the retired epoch's update log. The log of a retired epoch must
 *     be exactly what the cutover found -- that is what makes it a historical record rather than a
 *     branch that quietly keeps growing -- and read-only is what routes those keystrokes into
 *     `document_yjs_quarantined_updates` instead (`server.ts`'s `beforeHandleMessage`), where they
 *     are retained for the writer rather than merged anywhere.
 *  2. Each connection is sent the restore stateless message, carrying the new epoch, so the client
 *     can reload into the restored document (`apps/web`'s `App.tsx`).
 *
 * Connections are deliberately *not* closed. Closing would make every affected provider reconnect to
 * the same superseded document name it already holds -- the client learns nothing from a socket
 * closing that the stateless message has not already told it, and a close would race the delivery of
 * that message for no gain. A client that ignores the message stays attached to a document it can no
 * longer write to, which is inert rather than dangerous.
 *
 * Returns what it did, rather than logging itself, so `server.ts` owns the one log line and this
 * function stays a pure-ish transformation the tests can assert on directly.
 */
export function supersedeRestoredDocuments(
  documents: Iterable<LiveCollabDocument>,
  notification: RestoreNotification,
): SupersedeResult {
  const payload = encodeCollabRestoredMessage(notification.epoch);
  const supersededDocuments: string[] = [];
  let notifiedConnections = 0;
  for (const document of documents) {
    const parsed = parseCollabDocumentName(document.name);
    if (!parsed) continue;
    if (parsed.screenplayId !== notification.screenplayId) continue;
    if (parsed.epoch >= notification.epoch) continue;
    supersededDocuments.push(document.name);
    for (const [connection] of document.connections) {
      connection.readOnly = true;
      connection.sendStateless(payload);
      notifiedConnections += 1;
    }
  }
  return { notifiedConnections, supersededDocuments };
}

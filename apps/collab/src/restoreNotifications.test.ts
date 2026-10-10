import { describe, expect, it, vi } from 'vitest';
import {
  formatCollabDocumentName,
  parseCollabRestoredMessage,
  COLLAB_RESTORED_MESSAGE_TYPE,
} from '@finaler-draft/config';
import { SCREENPLAY_RESTORED_NOTIFY_CHANNEL } from '@finaler-draft/database';
import {
  parseRestoreNotification,
  startRestoreNotificationListener,
  supersedeRestoredDocuments,
  type LiveCollabConnection,
  type LiveCollabDocument,
  type NotificationClient,
} from './restoreNotifications.js';

/**
 * Collaboration slice 5, plan.md step 4 ("connected clients receive a restore event and reload the
 * new epoch") on the side of it that runs in `apps/collab`. Three independently testable pieces,
 * which is why they are three functions rather than one hook:
 *
 *  - parsing a `pg_notify` payload that arrives from outside this process,
 *  - keeping the subscription alive across connection failures,
 *  - deciding what a committed restore does to the connections this process is already holding.
 *
 * `collaboration.integration.test.ts` exercises all three together against a real database and real
 * sockets. These are the unit-level cases that suite cannot reach: a malformed payload nobody writes,
 * a connection failure nobody can reliably provoke, and the exact boundary of which documents are
 * superseded.
 */
const screenplayId = '11111111-1111-4111-8111-111111111111';
const otherScreenplayId = '22222222-2222-4222-8222-222222222222';

describe('parseRestoreNotification', () => {
  it('parses a well-formed notification', () => {
    expect(parseRestoreNotification(JSON.stringify({ screenplayId, epoch: 3 }))).toEqual({
      screenplayId,
      epoch: 3,
    });
  });

  /**
   * Validated rather than trusted even though this process writes nothing to the channel itself: a
   * notification payload is a string arriving from outside this process, and `JSON.parse` on an
   * unexpected shape followed by arithmetic on `undefined` is how a listener turns someone else's
   * mistake into a crash loop.
   */
  it('returns undefined for every payload that is not one', () => {
    for (const payload of [
      undefined,
      '',
      'not json',
      '{',
      '[]',
      'null',
      '"a string"',
      '7',
      JSON.stringify({ epoch: 1 }),
      JSON.stringify({ screenplayId }),
      JSON.stringify({ screenplayId: '', epoch: 1 }),
      JSON.stringify({ screenplayId: 7, epoch: 1 }),
      JSON.stringify({ screenplayId, epoch: '1' }),
      JSON.stringify({ screenplayId, epoch: -1 }),
      JSON.stringify({ screenplayId, epoch: 1.5 }),
      JSON.stringify({ screenplayId, epoch: Number.NaN }),
    ]) {
      expect(parseRestoreNotification(payload)).toBeUndefined();
    }
  });
});

/** A `NotificationClient` stub with hand-operated failure and notification channels. */
function fakeClient() {
  const listened: string[] = [];
  let notify: ((payload: string | undefined) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  let closed = 0;
  const client: NotificationClient = {
    close: async () => {
      closed += 1;
    },
    listen: async (channel) => {
      listened.push(channel);
    },
    onFailure: (listener) => {
      fail = listener;
    },
    onNotification: (listener) => {
      notify = listener;
    },
  };
  return {
    client,
    listened,
    get closeCount() {
      return closed;
    },
    notify: (payload: string | undefined) => notify?.(payload),
    fail: (error: unknown) => fail?.(error),
  };
}

describe('startRestoreNotificationListener', () => {
  it('listens on the restore channel and reports every valid notification, ignoring the rest', async () => {
    const first = fakeClient();
    const onRestored = vi.fn();
    const listener = startRestoreNotificationListener({
      connect: async () => first.client,
      onError: () => undefined,
      onRestored,
    });
    await listener.started;

    // The channel name is the one `@finaler-draft/database` exports -- a listener subscribed to a
    // channel the restore transaction does not notify would be silently deaf.
    expect(first.listened).toEqual([SCREENPLAY_RESTORED_NOTIFY_CHANNEL]);

    first.notify(JSON.stringify({ screenplayId, epoch: 2 }));
    first.notify('not a restore notification');
    first.notify(undefined);
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onRestored).toHaveBeenCalledWith({ screenplayId, epoch: 2 });

    await listener.dispose();
    expect(first.closeCount).toBe(1);
  });

  /**
   * The window in which this process is deaf to restores is a window in which a writer can keep
   * editing a document that is no longer live, so a dropped subscription must re-establish itself
   * rather than waiting for a deploy.
   */
  it('re-establishes the subscription after a connection-level failure, and the new connection receives notifications', async () => {
    const first = fakeClient();
    const second = fakeClient();
    const clients = [first.client, second.client];
    const onRestored = vi.fn();
    const onError = vi.fn();
    const timers: Array<() => void> = [];
    const listener = startRestoreNotificationListener({
      connect: async () => clients.shift()!,
      onError,
      onRestored,
      retryDelayMs: 2_000,
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => undefined,
    });
    await listener.started;

    const failure = new Error('Connection terminated unexpectedly');
    first.fail(failure);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(timers).toHaveLength(1);

    // The scheduled retry fires.
    timers[0]!();
    await vi.waitFor(() => expect(second.listened).toEqual([SCREENPLAY_RESTORED_NOTIFY_CHANNEL]));

    second.notify(JSON.stringify({ screenplayId, epoch: 4 }));
    expect(onRestored).toHaveBeenCalledWith({ screenplayId, epoch: 4 });

    await listener.dispose();
    // The failed client is abandoned rather than closed -- a connection that just errored is not one
    // to run more commands on. Only the live one is closed.
    expect(first.closeCount).toBe(0);
    expect(second.closeCount).toBe(1);
  });

  it('retries when the connection attempt itself throws, reporting the error rather than rejecting started', async () => {
    const connectFailure = new Error('ECONNREFUSED');
    const recovered = fakeClient();
    let attempts = 0;
    const onError = vi.fn();
    const timers: Array<() => void> = [];
    const listener = startRestoreNotificationListener({
      connect: async () => {
        attempts += 1;
        if (attempts === 1) throw connectFailure;
        return recovered.client;
      },
      onError,
      onRestored: () => undefined,
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => undefined,
    });

    // `started` resolves rather than rejecting: a failed first attempt has already scheduled its own
    // retry, and a rejected promise here would make a startup-time database blip fatal to the whole
    // process.
    await expect(listener.started).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(connectFailure);

    timers[0]!();
    await vi.waitFor(() =>
      expect(recovered.listened).toEqual([SCREENPLAY_RESTORED_NOTIFY_CHANNEL]),
    );
    await listener.dispose();
    expect(recovered.closeCount).toBe(1);
  });

  it('disposes safely during startup: a connection that arrives after dispose is closed, never subscribed', async () => {
    const late = fakeClient();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onRestored = vi.fn();
    const listener = startRestoreNotificationListener({
      connect: async () => {
        await gate;
        return late.client;
      },
      onError: () => undefined,
      onRestored,
    });

    const disposed = listener.dispose();
    release!();
    await disposed;
    await listener.started;

    expect(late.listened).toEqual([]);
    expect(late.closeCount).toBe(1);
    late.notify(JSON.stringify({ screenplayId, epoch: 1 }));
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('cancels a pending retry on dispose, so a shutdown never reconnects behind itself', async () => {
    const clearTimeoutFn = vi.fn();
    const timers: Array<() => void> = [];
    let attempts = 0;
    const listener = startRestoreNotificationListener({
      connect: async () => {
        attempts += 1;
        throw new Error('still down');
      },
      onError: () => undefined,
      onRestored: () => undefined,
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return 7 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn,
    });
    await listener.started;
    expect(attempts).toBe(1);

    await listener.dispose();
    expect(clearTimeoutFn).toHaveBeenCalledWith(7);
    // Even if the timer somehow fired anyway, a disposed listener does not reconnect.
    timers[0]!();
    expect(attempts).toBe(1);
  });
});

function fakeConnection(): LiveCollabConnection & { sent: string[] } {
  const sent: string[] = [];
  return {
    readOnly: false,
    sendStateless: (payload: string) => sent.push(payload),
    sent,
  };
}

function fakeDocument(name: string, connections: Array<LiveCollabConnection>): LiveCollabDocument {
  return {
    name,
    connections: connections.map((connection) => [connection, { clients: new Set() }] as const),
  };
}

describe('supersedeRestoredDocuments', () => {
  /**
   * The two things a committed restore must do to a connection that was open when it landed, and
   * the order they matter in: forcing `readOnly` is what routes the writer's next keystroke into
   * quarantine instead of the retired epoch's live log, and the stateless message is what lets the
   * client reload into the restored document.
   */
  it('forces every connection to a retired epoch read-only and tells each one the new epoch', () => {
    const first = fakeConnection();
    const second = fakeConnection();
    const document = fakeDocument(formatCollabDocumentName(screenplayId, 0), [first, second]);

    const result = supersedeRestoredDocuments([document], { screenplayId, epoch: 1 });

    expect(result).toEqual({
      notifiedConnections: 2,
      supersededDocuments: [formatCollabDocumentName(screenplayId, 0)],
    });
    expect(first.readOnly).toBe(true);
    expect(second.readOnly).toBe(true);
    for (const connection of [first, second]) {
      expect(connection.sent).toHaveLength(1);
      // The *new* epoch, so the client can reconnect to the restored document without a second
      // round trip to the API.
      expect(parseCollabRestoredMessage(connection.sent[0]!)).toEqual({
        type: COLLAB_RESTORED_MESSAGE_TYPE,
        epoch: 1,
      });
    }
  });

  it('leaves the restored epoch itself, and any later one, completely untouched', () => {
    const live = fakeConnection();
    const future = fakeConnection();
    const result = supersedeRestoredDocuments(
      [
        fakeDocument(formatCollabDocumentName(screenplayId, 1), [live]),
        fakeDocument(formatCollabDocumentName(screenplayId, 2), [future]),
      ],
      { screenplayId, epoch: 1 },
    );

    expect(result).toEqual({ notifiedConnections: 0, supersededDocuments: [] });
    expect(live.readOnly).toBe(false);
    expect(future.readOnly).toBe(false);
    expect(live.sent).toEqual([]);
    expect(future.sent).toEqual([]);
  });

  it('never touches another screenplay, even at an older epoch', () => {
    const bystander = fakeConnection();
    const result = supersedeRestoredDocuments(
      [fakeDocument(formatCollabDocumentName(otherScreenplayId, 0), [bystander])],
      { screenplayId, epoch: 1 },
    );

    expect(result).toEqual({ notifiedConnections: 0, supersededDocuments: [] });
    expect(bystander.readOnly).toBe(false);
    expect(bystander.sent).toEqual([]);
  });

  it('skips a document whose name does not parse, rather than guessing which screenplay it belongs to', () => {
    const unknown = fakeConnection();
    const retired = fakeConnection();
    const result = supersedeRestoredDocuments(
      [
        fakeDocument(screenplayId, [unknown]),
        fakeDocument(formatCollabDocumentName(screenplayId, 0), [retired]),
      ],
      { screenplayId, epoch: 1 },
    );

    expect(result.supersededDocuments).toEqual([formatCollabDocumentName(screenplayId, 0)]);
    expect(unknown.readOnly).toBe(false);
    expect(unknown.sent).toEqual([]);
    expect(retired.readOnly).toBe(true);
  });

  it('supersedes every retired epoch at once, not only the one immediately before the restore', () => {
    const oldest = fakeConnection();
    const older = fakeConnection();
    const result = supersedeRestoredDocuments(
      [
        fakeDocument(formatCollabDocumentName(screenplayId, 0), [oldest]),
        fakeDocument(formatCollabDocumentName(screenplayId, 1), [older]),
      ],
      { screenplayId, epoch: 2 },
    );

    expect(result.notifiedConnections).toBe(2);
    expect(result.supersededDocuments).toEqual([
      formatCollabDocumentName(screenplayId, 0),
      formatCollabDocumentName(screenplayId, 1),
    ]);
    expect(oldest.readOnly).toBe(true);
    expect(older.readOnly).toBe(true);
  });

  it('reports a superseded document with no connections at all', () => {
    const result = supersedeRestoredDocuments(
      [fakeDocument(formatCollabDocumentName(screenplayId, 0), [])],
      { screenplayId, epoch: 1 },
    );
    expect(result).toEqual({
      notifiedConnections: 0,
      supersededDocuments: [formatCollabDocumentName(screenplayId, 0)],
    });
  });
});

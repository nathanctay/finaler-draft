import { describe, expect, it, vi } from 'vitest';
import { MEMBERSHIP_CHANGED_NOTIFY_CHANNEL } from '@finaler-draft/database';
import {
  disconnectMembershipChangedConnections,
  startMembershipNotificationListener,
  type ClosableCollabConnection,
  type MembershipLiveCollabDocument,
} from './membershipNotifications.js';
import type { NotificationClient } from './restoreNotifications.js';

/**
 * The screenplay-invitations slice's answer to "what happens to an open socket when someone is
 * demoted or removed", on the side that runs in `apps/collab`.
 *
 * `collaboration.integration.test.ts` exercises the whole path -- a real `LISTEN`, a real socket,
 * a real reconnect that re-authorizes against the database and comes back denied or read-only.
 * These are the unit-level cases that suite cannot reach: the exact boundary of which connections
 * are closed, a connection with no identity at all, and a subscription failure nobody can reliably
 * provoke against a healthy database.
 */
const removedUserId = 'user-removed';
const otherUserId = 'user-other';

function connection(actorId: string | undefined): ClosableCollabConnection & {
  close: ReturnType<typeof vi.fn>;
} {
  return {
    close: vi.fn(),
    context: actorId === undefined ? undefined : { actorId },
  };
}

function document(
  name: string,
  connections: ClosableCollabConnection[],
): MembershipLiveCollabDocument {
  return { connections: connections.map((item) => [item, undefined] as const), name };
}

describe('disconnectMembershipChangedConnections', () => {
  it('closes only the connections belonging to the account whose membership changed', () => {
    const removed = connection(removedUserId);
    const bystander = connection(otherUserId);
    const result = disconnectMembershipChangedConnections(
      [document('screenplay-a:0', [removed, bystander])],
      { userId: removedUserId },
    );
    expect(removed.close).toHaveBeenCalledOnce();
    // The document is not the unit of this operation -- one account is. A removal must not
    // interrupt the collaborators who still have access.
    expect(bystander.close).not.toHaveBeenCalled();
    expect(result).toEqual({ affectedDocuments: ['screenplay-a:0'], closedConnections: 1 });
  });

  it('closes that account’s connections across every document, not only the one that changed', () => {
    // The notification deliberately names only the account, so this over-includes: a document
    // whose membership did not change still gets a reconnect, which re-reads the database and
    // resolves identically. Over-inclusion is the safe direction -- a reconnect can never grant
    // anything -- and under-inclusion would be the removed-member-still-writing case.
    const first = connection(removedUserId);
    const second = connection(removedUserId);
    const result = disconnectMembershipChangedConnections(
      [document('screenplay-a:0', [first]), document('screenplay-b:2', [second])],
      { userId: removedUserId },
    );
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(result).toEqual({
      affectedDocuments: ['screenplay-a:0', 'screenplay-b:2'],
      closedConnections: 2,
    });
  });

  it('closes every one of that account’s connections to the same document', () => {
    // A writer with the screenplay open in two tabs holds two connections, and leaving either one
    // open would leave them writing.
    const tabs = [connection(removedUserId), connection(removedUserId)];
    const result = disconnectMembershipChangedConnections([document('screenplay-a:0', tabs)], {
      userId: removedUserId,
    });
    for (const tab of tabs) expect(tab.close).toHaveBeenCalledOnce();
    expect(result.closedConnections).toBe(2);
  });

  it('reports a document as unaffected when none of its connections belong to that account', () => {
    const bystander = connection(otherUserId);
    expect(
      disconnectMembershipChangedConnections([document('screenplay-a:0', [bystander])], {
        userId: removedUserId,
      }),
    ).toEqual({ affectedDocuments: [], closedConnections: 0 });
    expect(bystander.close).not.toHaveBeenCalled();
  });

  it('ignores a connection with no identity on its context rather than closing it or crashing', () => {
    // `context` is `any` in Hocuspocus's own types and is genuinely `undefined` for a
    // server-internal `DirectConnection`. This application never makes one, but a listener that
    // assumed the shape would crash the whole notification rather than skip one connection -- and
    // one that treated "no identity" as a match would close every connection on every membership
    // change.
    const anonymous = connection(undefined);
    const malformed: ClosableCollabConnection & { close: ReturnType<typeof vi.fn> } = {
      close: vi.fn(),
      context: { actorId: 42 },
    };
    const result = disconnectMembershipChangedConnections(
      [document('screenplay-a:0', [anonymous, malformed])],
      { userId: removedUserId },
    );
    expect(anonymous.close).not.toHaveBeenCalled();
    expect(malformed.close).not.toHaveBeenCalled();
    expect(result).toEqual({ affectedDocuments: [], closedConnections: 0 });
  });

  it('handles a process holding no documents at all', () => {
    expect(disconnectMembershipChangedConnections([], { userId: removedUserId })).toEqual({
      affectedDocuments: [],
      closedConnections: 0,
    });
  });
});

describe('startMembershipNotificationListener', () => {
  function stubClient(): NotificationClient & {
    channels: string[];
    emit: (payload: string | undefined) => void;
    fail: (error: unknown) => void;
    closed: () => number;
  } {
    const channels: string[] = [];
    let onNotification: (payload: string | undefined) => void = () => undefined;
    let onFailure: (error: unknown) => void = () => undefined;
    let closes = 0;
    return {
      channels,
      close: async () => void (closes += 1),
      closed: () => closes,
      emit: (payload) => onNotification(payload),
      fail: (error) => onFailure(error),
      listen: async (channel) => void channels.push(channel),
      onFailure: (listener) => void (onFailure = listener),
      onNotification: (listener) => void (onNotification = listener),
    };
  }

  it('subscribes to the membership channel and reports every valid notification', async () => {
    const client = stubClient();
    const seen: Array<{ userId: string }> = [];
    const listener = startMembershipNotificationListener({
      connect: async () => client,
      onError: () => undefined,
      onMembershipChanged: (notification) => void seen.push(notification),
    });
    await listener.started;
    expect(client.channels).toEqual([MEMBERSHIP_CHANGED_NOTIFY_CHANNEL]);

    client.emit(JSON.stringify({ userId: removedUserId }));
    expect(seen).toEqual([{ userId: removedUserId }]);
    await listener.dispose();
  });

  it('ignores a payload that is not a membership notification, without reconnecting', async () => {
    const client = stubClient();
    const seen: Array<{ userId: string }> = [];
    const listener = startMembershipNotificationListener({
      connect: async () => client,
      onError: () => undefined,
      onMembershipChanged: (notification) => void seen.push(notification),
    });
    await listener.started;
    client.emit('not json');
    client.emit(JSON.stringify({ userId: '' }));
    client.emit(undefined);
    expect(seen).toEqual([]);
    await listener.dispose();
  });

  it('re-establishes the subscription after a connection failure', async () => {
    // The window in which this process is deaf to a notification is a window in which a removed
    // member keeps writing, so a dropped `LISTEN` connection has to come back on its own.
    const clients = [stubClient(), stubClient()];
    let connects = 0;
    const errors: unknown[] = [];
    const scheduled: Array<() => void> = [];
    const listener = startMembershipNotificationListener({
      connect: async () => clients[connects++]!,
      onError: (error) => void errors.push(error),
      onMembershipChanged: () => undefined,
      // Injected so the retry runs on demand rather than after a real delay.
      clearTimeoutFn: () => undefined,
      setTimeoutFn: (callback) => {
        scheduled.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    await listener.started;
    clients[0]!.fail(new Error('connection ended'));
    expect(errors).toHaveLength(1);
    expect(scheduled).toHaveLength(1);

    scheduled[0]!();
    // Settle the retry's own async `connect`.
    await Promise.resolve();
    await Promise.resolve();
    expect(connects).toBe(2);
    expect(clients[1]!.channels).toEqual([MEMBERSHIP_CHANGED_NOTIFY_CHANNEL]);
    await listener.dispose();
  });

  it('reports a failure to connect at all, and schedules a retry rather than giving up', async () => {
    const errors: unknown[] = [];
    const scheduled: Array<() => void> = [];
    const listener = startMembershipNotificationListener({
      connect: async () => Promise.reject(new Error('no database')),
      onError: (error) => void errors.push(error),
      onMembershipChanged: () => undefined,
      clearTimeoutFn: () => undefined,
      setTimeoutFn: (callback) => {
        scheduled.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    await listener.started;
    expect(errors).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    await listener.dispose();
  });

  it('closes its connection on dispose, and is safe to dispose twice', async () => {
    const client = stubClient();
    const listener = startMembershipNotificationListener({
      connect: async () => client,
      onError: () => undefined,
      onMembershipChanged: () => undefined,
    });
    await listener.started;
    await listener.dispose();
    expect(client.closed()).toBe(1);
    await listener.dispose();
    expect(client.closed()).toBe(1);
  });
});

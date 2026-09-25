import { describe, expect, it } from 'vitest';
import {
  deriveParticipantColor,
  fetchDisplayName,
  resolvePresenceIdentity,
  sanitizeAwarenessStates,
} from './presence.js';
import type { Queryable } from './authenticate.js';

function fakeQueryable(name: string | undefined): Queryable {
  return {
    async query() {
      return { rows: name === undefined ? [] : [{ name }] };
    },
  };
}

describe('deriveParticipantColor', () => {
  it('is deterministic for the same actor id', () => {
    expect(deriveParticipantColor('actor-1')).toBe(deriveParticipantColor('actor-1'));
  });

  it('always returns one of the fixed palette entries', () => {
    const color = deriveParticipantColor('any-actor-id-at-all');
    expect(color).toMatch(/^#[0-9a-f]{6}$/u);
  });

  it('spreads across the palette rather than collapsing every id onto one slot', () => {
    const colors = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((id) => deriveParticipantColor(id)),
    );
    // Not a claim of zero collisions (the owner's own decision accepts occasional ones) -- only
    // that the hash is not degenerate, e.g. always returning the same slot regardless of input.
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('fetchDisplayName', () => {
  it('returns the account name', async () => {
    expect(await fetchDisplayName(fakeQueryable('Mara Quinn'), 'actor-1')).toBe('Mara Quinn');
  });

  it('falls back to a generic label rather than throwing when the row is missing', async () => {
    expect(await fetchDisplayName(fakeQueryable(undefined), 'actor-1')).toBe('A collaborator');
  });

  it('falls back for a blank name rather than showing an empty label', async () => {
    expect(await fetchDisplayName(fakeQueryable('   '), 'actor-1')).toBe('A collaborator');
  });
});

describe('resolvePresenceIdentity', () => {
  it('combines the fetched name with the derived colour', async () => {
    const identity = await resolvePresenceIdentity(fakeQueryable('Mara Quinn'), 'actor-1');
    expect(identity).toEqual({ name: 'Mara Quinn', color: deriveParticipantColor('actor-1') });
  });
});

const identity = { name: 'Mara Quinn', color: '#2563eb' };

describe('sanitizeAwarenessStates', () => {
  it('overwrites a client-claimed name/colour with the authenticated identity', () => {
    const states = new Map([
      [1, { user: { name: 'Impersonator', color: '#000000', lastActiveAt: 100 } }],
    ]);
    sanitizeAwarenessStates(states, identity, 200);
    expect(states.get(1)).toEqual({
      user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 100 },
    });
  });

  it('drops every field outside the whitelisted shape', () => {
    const states = new Map([
      [
        1,
        {
          user: { name: 'x', color: '#000', lastActiveAt: 50 },
          role: 'owner',
          secret: 'exfiltrate-me',
        },
      ],
    ]);
    sanitizeAwarenessStates(states, identity, 100);
    expect(states.get(1)).toEqual({
      user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 50 },
    });
  });

  it('clamps a future-dated lastActiveAt to now rather than trusting the client', () => {
    const states = new Map([[1, { user: { lastActiveAt: 999_999 } }]]);
    sanitizeAwarenessStates(states, identity, 100);
    expect((states.get(1) as { user: { lastActiveAt: number } }).user.lastActiveAt).toBe(100);
  });

  it('treats a missing lastActiveAt as never-active (0), not as active-now', () => {
    const states = new Map([[1, {}]]);
    sanitizeAwarenessStates(states, identity, 100);
    expect((states.get(1) as { user: { lastActiveAt: number } }).user.lastActiveAt).toBe(0);
  });

  it('treats a malformed lastActiveAt the same way', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { lastActiveAt: 'not-a-number' } }],
    ]);
    sanitizeAwarenessStates(states, identity, 100);
    expect((states.get(1) as { user: { lastActiveAt: number } }).user.lastActiveAt).toBe(0);
  });

  it('keeps a well-formed cursor unchanged', () => {
    const cursor = {
      anchor: { tname: 'default', item: null, assoc: 0 },
      head: { tname: 'default', item: null, assoc: 0 },
    };
    const states = new Map([[1, { user: {}, cursor }]]);
    sanitizeAwarenessStates(states, identity, 100);
    expect((states.get(1) as { cursor: unknown }).cursor).toEqual(cursor);
  });

  it('drops a malformed cursor rather than forwarding something y-prosemirror might throw decoding', () => {
    const states = new Map([[1, { user: {}, cursor: { anchor: 'not-an-object', head: null } }]]);
    sanitizeAwarenessStates(states, identity, 100);
    expect(states.get(1)).toEqual({
      user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 0 },
    });
  });

  it('drops a cursor whose anchor is valid but whose head is not', () => {
    const states = new Map([
      [1, { user: {}, cursor: { anchor: { tname: 'default' }, head: 'not-an-object' } }],
    ]);
    sanitizeAwarenessStates(states, identity, 100);
    expect(states.get(1)).toEqual({
      user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 0 },
    });
  });

  it('drops a cursor that is not an object at all', () => {
    const states = new Map([[1, { user: {}, cursor: 'not-an-object' }]]);
    sanitizeAwarenessStates(states, identity, 100);
    expect(states.get(1)).toEqual({
      user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 0 },
    });
  });

  it('stamps every entry with the connection’s own identity when a message legitimately carries more than one client id', () => {
    // A real `HocuspocusProviderWebsocket` batches `added`/`updated`/`removed` client ids from one
    // connection's own `Awareness` instance into a single outbound message (confirmed directly --
    // see this function's own top-of-file comment) -- this is not the "another peer's clientId"
    // spoof this hook exists to close, and must not be dropped as if it were.
    const states = new Map([
      [1, { user: { lastActiveAt: 100 } }],
      [2, { user: { name: 'Impersonator', lastActiveAt: 90 } }],
    ]);
    sanitizeAwarenessStates(states, identity, 100);
    expect(states.get(1)).toEqual({
      user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 100 },
    });
    expect(states.get(2)).toEqual({
      user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 90 },
    });
  });

  it('leaves an empty map empty', () => {
    const states = new Map<number, Record<string, unknown>>();
    sanitizeAwarenessStates(states, identity, 100);
    expect(states.size).toBe(0);
  });

  describe('titlePageCursor', () => {
    it('keeps a well-formed title-page cursor unchanged', () => {
      const titlePageCursor = { field: 'title', offset: 3 };
      const states = new Map([[1, { user: {}, titlePageCursor }]]);
      sanitizeAwarenessStates(states, identity, 100);
      expect((states.get(1) as { titlePageCursor: unknown }).titlePageCursor).toEqual(
        titlePageCursor,
      );
    });

    it('keeps a well-formed title-page cursor with a lineIndex unchanged', () => {
      const titlePageCursor = { field: 'author', lineIndex: 1, offset: 5 };
      const states = new Map([[1, { user: {}, titlePageCursor }]]);
      sanitizeAwarenessStates(states, identity, 100);
      expect((states.get(1) as { titlePageCursor: unknown }).titlePageCursor).toEqual(
        titlePageCursor,
      );
    });

    it('drops a title-page cursor naming a field outside the whitelist', () => {
      const states = new Map([
        [1, { user: {}, titlePageCursor: { field: 'not-a-real-field', offset: 0 } }],
      ]);
      sanitizeAwarenessStates(states, identity, 100);
      expect(states.get(1)).toEqual({
        user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 0 },
      });
    });

    it('drops a title-page cursor whose field is not a string at all -- the exact shape that would otherwise reach a peer’s querySelector', () => {
      const states = new Map([[1, { user: {}, titlePageCursor: { field: 123, offset: 0 } }]]);
      sanitizeAwarenessStates(states, identity, 100);
      expect(states.get(1)).toEqual({
        user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 0 },
      });
    });

    it('drops a title-page cursor with a negative offset', () => {
      const states = new Map([[1, { user: {}, titlePageCursor: { field: 'title', offset: -1 } }]]);
      sanitizeAwarenessStates(states, identity, 100);
      expect(states.get(1)).toEqual({
        user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 0 },
      });
    });

    it('drops a title-page cursor with a non-integer offset', () => {
      const states = new Map([[1, { user: {}, titlePageCursor: { field: 'title', offset: 1.5 } }]]);
      sanitizeAwarenessStates(states, identity, 100);
      expect(states.get(1)).toEqual({
        user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 0 },
      });
    });

    it('drops a title-page cursor with a negative lineIndex', () => {
      const states = new Map([
        [1, { user: {}, titlePageCursor: { field: 'author', lineIndex: -1, offset: 0 } }],
      ]);
      sanitizeAwarenessStates(states, identity, 100);
      expect(states.get(1)).toEqual({
        user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 0 },
      });
    });

    it('drops a title-page cursor that is not an object at all', () => {
      const states = new Map([[1, { user: {}, titlePageCursor: 'not-an-object' }]]);
      sanitizeAwarenessStates(states, identity, 100);
      expect(states.get(1)).toEqual({
        user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 0 },
      });
    });

    it('carries a valid cursor and a valid titlePageCursor together -- a writer can move between the two surfaces without either being clobbered', () => {
      const cursor = {
        anchor: { tname: 'default', item: null, assoc: 0 },
        head: { tname: 'default', item: null, assoc: 0 },
      };
      const titlePageCursor = { field: 'contact', lineIndex: 0, offset: 2 };
      const states = new Map([[1, { user: {}, cursor, titlePageCursor }]]);
      sanitizeAwarenessStates(states, identity, 100);
      expect(states.get(1)).toEqual({
        user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: 0 },
        cursor,
        titlePageCursor,
      });
    });
  });
});

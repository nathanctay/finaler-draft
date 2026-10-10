import { describe, expect, it } from 'vitest';
import {
  COLLAB_RESTORED_MESSAGE_TYPE,
  DEFAULT_COLLAB_DEV_PORT,
  encodeCollabRestoredMessage,
  formatCollabDocumentName,
  parseCollabDocumentName,
  parseCollabRestoredMessage,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENTS_MESSAGE,
} from './index.js';

describe('password policy', () => {
  it('publishes the shared password policy for auth clients and the server', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(PASSWORD_REQUIREMENTS_MESSAGE).toBe('Password must be 12–128 characters.');
  });
});

describe('DEFAULT_COLLAB_DEV_PORT', () => {
  it('is a valid port number clear of every other local dev port this monorepo already uses', () => {
    expect(Number.isInteger(DEFAULT_COLLAB_DEV_PORT)).toBe(true);
    expect(DEFAULT_COLLAB_DEV_PORT).toBeGreaterThan(0);
    expect(DEFAULT_COLLAB_DEV_PORT).toBeLessThanOrEqual(65535);
    // apps/api (3001), Vite (5173), the landing app (4321), and the Playwright harnesses
    // (4173-4175) -- see this export's own doc comment for why 1234 (Hocuspocus's own
    // conventional default) was rejected instead of just picking a port clear of those.
    expect([3001, 5173, 4321, 4173, 4174, 4175]).not.toContain(DEFAULT_COLLAB_DEV_PORT);
  });
});

/**
 * Collaboration slice 5 (restore-as-current). These two functions are the agreement between
 * `apps/web` (which builds the name it connects with, and keys its own offline store on it) and
 * `apps/collab` (which parses it back to decide what the connection may do). A disagreement here is
 * not a cosmetic bug: a name `apps/collab` cannot parse is refused outright, and a name it parses to
 * the *wrong* epoch would be the difference between accepting and quarantining a writer's updates.
 */
describe('collaboration document names', () => {
  it('round-trips a screenplay id and epoch', () => {
    const screenplayId = '11111111-1111-4111-8111-111111111111';
    expect(formatCollabDocumentName(screenplayId, 0)).toBe(`${screenplayId}:0`);
    expect(parseCollabDocumentName(formatCollabDocumentName(screenplayId, 7))).toEqual({
      screenplayId,
      epoch: 7,
    });
  });

  // The case every client built before this slice sends. Refused, not defaulted to epoch 0 -- see
  // `parseCollabDocumentName`'s own comment: a client that cannot name an epoch also cannot be told
  // when the one it holds stops being current, so admitting it would create a connection that can
  // never learn it is stale.
  it('refuses a bare screenplay id with no epoch at all', () => {
    expect(parseCollabDocumentName('11111111-1111-4111-8111-111111111111')).toBeUndefined();
  });

  it('refuses a name whose epoch is not a non-negative integer', () => {
    for (const name of ['doc:', 'doc:-1', 'doc:1.5', 'doc:01', 'doc:abc', 'doc: 1', ':0']) {
      expect(parseCollabDocumentName(name)).toBeUndefined();
    }
  });

  // Parsed from the right, so a screenplay id that itself contained a separator could not be
  // misread as a shorter id with a nonsense epoch. UUIDs never do, but the parser must not depend on
  // that staying true of every id this codebase ever uses.
  it('parses from the last separator, not the first', () => {
    expect(parseCollabDocumentName('a:b:3')).toEqual({ screenplayId: 'a:b', epoch: 3 });
  });
});

describe('the restore stateless message', () => {
  it('round-trips the new epoch', () => {
    expect(parseCollabRestoredMessage(encodeCollabRestoredMessage(4))).toEqual({
      type: COLLAB_RESTORED_MESSAGE_TYPE,
      epoch: 4,
    });
  });

  // The stateless channel is shared by definition: anything else a future slice broadcasts over it
  // must be ignored here, never coerced into a restore. A client that mistook an unrelated payload
  // for a restore would lock a writer out of a document that was never superseded.
  it('ignores every payload that is not a restore message', () => {
    for (const payload of [
      '',
      'not json',
      '{}',
      '[]',
      'null',
      '"a string"',
      JSON.stringify({ type: 'something-else', epoch: 1 }),
      JSON.stringify({ type: COLLAB_RESTORED_MESSAGE_TYPE }),
      JSON.stringify({ type: COLLAB_RESTORED_MESSAGE_TYPE, epoch: '1' }),
      JSON.stringify({ type: COLLAB_RESTORED_MESSAGE_TYPE, epoch: -1 }),
      JSON.stringify({ type: COLLAB_RESTORED_MESSAGE_TYPE, epoch: 1.5 }),
    ]) {
      expect(parseCollabRestoredMessage(payload)).toBeUndefined();
    }
  });
});

import type { Pool } from 'pg';
import { OutgoingMessage } from '@hocuspocus/server';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  extractSyncUpdatePayload,
  quarantineUpdate,
  updateCarriesNewContent,
} from './quarantine.js';

/**
 * Hand-encodes a message in the identical wire format `IncomingMessage`/`OutgoingMessage` use
 * (`lib0/encoding`'s own varUint/varString/varUint8Array -- LEB128 varints, a length-prefixed
 * UTF-8 string, a length-prefixed byte array), for the one shape the installed
 * `@hocuspocus/server`'s own `OutgoingMessage` has no dedicated builder for: a `SyncStep2` message
 * specifically (it has `writeUpdate` for the `Update` sync sub-type and `writeFirstSyncStepFor`
 * for `SyncStep1`, but nothing for `SyncStep2`, since the server itself never needs to *construct*
 * one -- only ever to receive one from a client). `lib0` is not a direct dependency of this
 * package (only a transitive one of `@hocuspocus/server`), so this is hand-rolled rather than
 * imported -- three primitives, not worth a new dependency for a test file.
 */
function encodeVarUint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0b0111_1111;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0b1000_0000;
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

function encodeVarString(value: string): number[] {
  const utf8 = Array.from(new TextEncoder().encode(value));
  return [...encodeVarUint(utf8.length), ...utf8];
}

function encodeVarUint8Array(value: Uint8Array): number[] {
  return [...encodeVarUint(value.length), ...Array.from(value)];
}

const MESSAGE_TYPE_SYNC = 0;
const MESSAGE_TYPE_AWARENESS = 1;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
// `SYNC_UPDATE` (2) is exercised via the real `OutgoingMessage.writeUpdate` case above, not a
// hand-built message -- no constant needed for it here.

function buildMessage(parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

describe('extractSyncUpdatePayload', () => {
  it('extracts the update payload from a real Update message built by the installed OutgoingMessage class', () => {
    const update = new Uint8Array([10, 20, 30, 40]);
    const raw = new OutgoingMessage('doc-1').createSyncMessage().writeUpdate(update).toUint8Array();
    expect(extractSyncUpdatePayload(raw)).toEqual(update);
  });

  it('extracts the update payload from a hand-built SyncStep2 message', () => {
    const update = new Uint8Array([1, 2, 3]);
    const raw = buildMessage([
      encodeVarString('doc-1'),
      encodeVarUint(MESSAGE_TYPE_SYNC),
      encodeVarUint(SYNC_STEP_2),
      encodeVarUint8Array(update),
    ]);
    expect(extractSyncUpdatePayload(raw)).toEqual(update);
  });

  it('returns undefined for a SyncStep1 message -- a state vector, not an update, is never quarantined', () => {
    const stateVector = new Uint8Array([9, 9, 9]);
    const raw = buildMessage([
      encodeVarString('doc-1'),
      encodeVarUint(MESSAGE_TYPE_SYNC),
      encodeVarUint(SYNC_STEP_1),
      encodeVarUint8Array(stateVector),
    ]);
    expect(extractSyncUpdatePayload(raw)).toBeUndefined();
  });

  it('returns undefined for a non-Sync message (e.g. Awareness)', () => {
    const raw = buildMessage([
      encodeVarString('doc-1'),
      encodeVarUint(MESSAGE_TYPE_AWARENESS),
      encodeVarUint8Array(new Uint8Array([1])),
    ]);
    expect(extractSyncUpdatePayload(raw)).toBeUndefined();
  });

  it('returns undefined rather than throwing for malformed bytes', () => {
    expect(extractSyncUpdatePayload(new Uint8Array([255, 255, 255]))).toBeUndefined();
    expect(extractSyncUpdatePayload(new Uint8Array([]))).toBeUndefined();
  });
});

describe('updateCarriesNewContent', () => {
  it('is false for an update the document snapshot already fully contains', () => {
    const doc = new Y.Doc();
    doc.getText('body').insert(0, 'hello');
    const update = Y.encodeStateAsUpdate(doc);
    expect(updateCarriesNewContent(doc, update)).toBe(false);
  });

  it('is true for an update carrying content the document does not have', () => {
    const doc = new Y.Doc();
    doc.getText('body').insert(0, 'hello');

    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(other);
    other.getText('body').insert(5, ' world');
    const delta = Y.encodeStateAsUpdate(other, before);

    expect(updateCarriesNewContent(doc, delta)).toBe(true);
  });
});

describe('quarantineUpdate / listQuarantinedUpdates', () => {
  it('persists the update bytes and actor id, readable back in insertion order', async () => {
    const rows: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        rows.push({ text, values });
        if (text.startsWith('insert')) return { rows: [] };
        if (text.startsWith('select')) {
          return {
            rows: rows
              .filter((row) => row.text.startsWith('insert'))
              .map((row) => ({ update: row.values![2], actorId: row.values![3] })),
          };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
    };

    await quarantineUpdate(pool as unknown as Pool, {
      screenplayId: 'screenplay-1',
      epoch: 0,
      update: new Uint8Array([7, 7, 7]),
      actorId: 'actor-1',
    });

    const listed = await listQuarantinedUpdatesForTest(pool as unknown as Pool);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.actorId).toBe('actor-1');
    expect(Buffer.from(listed[0]!.update)).toEqual(Buffer.from([7, 7, 7]));
  });
});

async function listQuarantinedUpdatesForTest(pool: Pool) {
  const { listQuarantinedUpdates } = await import('./quarantine.js');
  return listQuarantinedUpdates(pool, 'screenplay-1', 0);
}

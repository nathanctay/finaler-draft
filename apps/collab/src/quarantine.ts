import { IncomingMessage, MessageType } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { Pool } from 'pg';
import type { Queryable } from './updateLog.js';

/**
 * The y-protocols/sync sub-message types (`y-protocols/sync.js`'s own `messageYjsSyncStep1`/
 * `messageYjsSyncStep2`/`messageYjsUpdate` constants -- reproduced here, not imported, because
 * `y-protocols` is only a *peer* dependency of the installed `@hocuspocus/server` and is not
 * itself resolvable from this package without adding a new direct dependency for three stable,
 * long-published protocol integers). Only `SyncStep2` and `Update` ever carry actual Yjs update
 * bytes; `SyncStep1` carries a state vector only -- nothing to quarantine.
 */
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;

/**
 * Peeks the *raw* wire bytes Hocuspocus's `beforeHandleMessage` hook hands every extension --
 * still address-prefixed and not yet parsed for real, since the receiver that actually applies a
 * message parses its own, separate, already-partially-consumed decoder instance (confirmed by
 * reading the installed `@hocuspocus/server` source: `Connection.processMessages` reads the
 * address off `message`, then passes the *original*, unread `rawUpdate` to
 * `beforeHandleMessage`) -- and returns the inner Yjs update payload, if and only if this message
 * is a sync message carrying one (`SyncStep2` or `Update`; not `SyncStep1`, not Awareness, not
 * Auth, not any of the other message types this protocol defines). Returns `undefined` for every
 * other message shape, non-destructively: this constructs its own `IncomingMessage` over the same
 * underlying bytes rather than mutating anything the real receiver still needs to read, mirroring
 * the identical peek-with-a-fresh-decoder pattern the installed source itself uses internally
 * (`handleConnection`'s own `tmpMsg` probes, read directly from the compiled package).
 */
export function extractSyncUpdatePayload(rawMessage: Uint8Array): Uint8Array | undefined {
  try {
    const probe = new IncomingMessage(rawMessage);
    probe.readVarString(); // the address/document-name prefix -- not needed here.
    const outerType = probe.readVarUint();
    if (outerType !== MessageType.Sync && outerType !== MessageType.SyncReply) return undefined;
    const innerType = probe.readVarUint();
    if (innerType !== SYNC_STEP_2 && innerType !== SYNC_UPDATE) return undefined;
    return probe.readVarUint8Array();
  } catch {
    // A malformed or unexpectedly-shaped message: not this function's job to diagnose (the real
    // receiver will independently reject it), and not a reason to quarantine anything -- there is
    // no well-formed update payload to have extracted.
    return undefined;
  }
}

/**
 * The detection half of "accept the data, never grant editing access": whether `payload` (already
 * known, by the caller, to have arrived on a connection `authenticate.ts` resolved as `readOnly`)
 * carries anything the live `document` does not already have. Hocuspocus's own low-level
 * `readOnly` check performs the identical comparison for `SyncStep2` specifically (confirmed by
 * reading the installed source -- `y_protocols_sync.messageYjsSyncStep2`'s `readOnly` branch uses
 * `Y.snapshotContainsUpdate` to decide whether to ack success or failure), so reusing it here is
 * not a new judgment call, only extending an existing one to also gate whether something is worth
 * retaining. Without this check, every ordinary reconnect from a read-only viewer (a reviewer
 * opening a screenplay they were never going to edit) would write a full-document-sized
 * quarantine row on every single connection, for content that carries nothing new at all.
 */
export function updateCarriesNewContent(document: Y.Doc, update: Uint8Array): boolean {
  const snapshot = Y.snapshot(document);
  return !Y.snapshotContainsUpdate(snapshot, update);
}

/**
 * The retention half: persists one refused update, tagged with who sent it and when, without
 * touching the live document at all -- there is no code path here that calls `Y.applyUpdate`
 * against anything. Hocuspocus's own message handling still independently drops this same update
 * from ever reaching the document (the `readOnly` branch this update was found inside of), so the
 * live document staying unchanged does not depend on this function doing anything in particular;
 * this function's only job is making sure the bytes are not simply gone once that drop happens.
 *
 * `epoch` is threaded through for the identical forward-compatibility reason
 * `document_yjs_updates`/`document_yjs_checkpoints` carry it (see those tables' own schema
 * comments): a future epoch cutover (slice 5) means a lapsed writer's retained work needs to be
 * attributable to the epoch it was actually written against, not implicitly assumed to be the
 * document's current one.
 */
export async function quarantineUpdate(
  pool: Pool,
  params: { screenplayId: string; epoch: number; update: Uint8Array; actorId: string | undefined },
): Promise<void> {
  await pool.query(
    `insert into document_yjs_quarantined_updates (screenplay_id, epoch, update, authenticated_actor_id)
     values ($1, $2, $3, $4)`,
    [params.screenplayId, params.epoch, Buffer.from(params.update), params.actorId ?? null],
  );
}

/** Every quarantined update currently retained for (screenplayId, epoch), oldest first -- the
 * read side this slice's tests use to prove retention; the resubscribe-and-merge interface that
 * would call this in production is explicitly deferred (see `progress/collaboration-offline-
 * durable.md`). */
export async function listQuarantinedUpdates(
  queryable: Queryable,
  screenplayId: string,
  epoch: number,
): Promise<Array<{ update: Buffer; actorId: string | null }>> {
  const result = await queryable.query<{ update: Buffer; actorId: string | null }>(
    `select update, authenticated_actor_id as "actorId"
       from document_yjs_quarantined_updates
      where screenplay_id = $1 and epoch = $2
      order by id asc`,
    [screenplayId, epoch],
  );
  return result.rows;
}

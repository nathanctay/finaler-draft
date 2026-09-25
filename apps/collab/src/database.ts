import { createHash } from 'node:crypto';
import type { fetchPayload, storePayload } from '@hocuspocus/server';
import type { Pool } from 'pg';
import { screenplaySchema, type DocumentSettings, type TitlePage } from '@finaler-draft/screenplay';
import {
  DOCUMENT_SETTINGS_YJS_MAP,
  editorContentFromScreenplay,
  isDocumentSettingsMapSeeded,
  isTitlePageMapSeeded,
  nonEmptyEditorContent,
  projectYDocScreenplay,
  seedScreenplayYDoc,
  TITLE_PAGE_YJS_MAP,
  writeDocumentSettingsToYMap,
  writeTitlePageToYMap,
} from '@finaler-draft/screenplay-editor';
import * as Y from 'yjs';

type CanonicalScreenplayRow = {
  titlePages?: TitlePage[];
  documentSettings?: DocumentSettings;
};

/**
 * Reads whatever this screenplay's `canonical_screenplay` column currently holds for its title
 * page and document settings -- the two pieces `backfillTitlePageAndDocumentSettings` below needs
 * when a Yjs document turns out to predate this slice. A dedicated query (not folded into
 * `createFetch`'s "no state row" branch, which already has this same data) because the migration
 * check that decides whether to call this runs *after* `document_yjs_state` has already been
 * checked, and the common, steady-state case -- a document already carrying both maps -- must
 * never pay for this query at all. See `createFetch`'s own comment for why.
 */
async function fetchCanonicalTitlePageAndDocumentSettings(
  pool: Pool,
  documentName: string,
): Promise<CanonicalScreenplayRow | undefined> {
  const result = await pool.query<{ canonicalScreenplay: CanonicalScreenplayRow }>(
    'select canonical_screenplay as "canonicalScreenplay" from screenplays where id = $1 and deleted_at is null',
    [documentName],
  );
  return result.rows[0]?.canonicalScreenplay;
}

/**
 * Backfills `doc`'s title page and/or document settings maps from `canonical` when -- and only
 * when -- a map is genuinely unseeded (`isTitlePageMapSeeded`/`isDocumentSettingsMapSeeded` both
 * `false`), mutating `doc` in place. Returns whether anything actually changed, so `createFetch`
 * knows whether the buffer it is about to return needs re-encoding.
 *
 * This is the migration: a screenplay already opened collaboratively before this slice shipped has
 * a `document_yjs_state` row whose title page and document settings maps were never written to --
 * that concept didn't exist yet -- so `createFetch`'s ordinary "stored state exists, return it
 * unchanged" fast path would otherwise carry that gap forward forever, silently. Backfilling here,
 * gated on the map's own seeded-ness rather than on any separate "have I migrated this document"
 * flag, is what makes this safe to call on every cold load without a second bookkeeping mechanism:
 * the *moment* a title page (however sparse) or a document settings object is written -- by this
 * function or by a real writer editing collaboratively -- `isTitlePageMapSeeded`/
 * `isDocumentSettingsMapSeeded` flips to `true` and this function never touches that map again.
 * That is the idempotency and the "never clobber a writer's collaborative edit" guarantee in one
 * property, not two: there is no code path that overwrites a seeded map, ever.
 *
 * A screenplay that genuinely has no title page (`canonical.titlePages` empty or absent) leaves
 * the title page map unseeded after this call too -- correctly, since `writeTitlePageToYMap(map,
 * undefined)` clears rather than seeds it, and `isTitlePageMapSeeded` will (harmlessly) ask again
 * on the next cold load. Same for a screenplay whose canonical row has no `documentSettings` at
 * all (one old enough to predate that field too): the settings map stays unseeded, which
 * `documentSettingsFromYMap` already treats as "let the schema default it," the correct outcome.
 */
function backfillTitlePageAndDocumentSettings(
  doc: Y.Doc,
  canonical: CanonicalScreenplayRow,
): boolean {
  let changed = false;
  doc.transact(() => {
    const titlePageMap = doc.getMap(TITLE_PAGE_YJS_MAP);
    if (!isTitlePageMapSeeded(titlePageMap) && canonical.titlePages?.[0]) {
      writeTitlePageToYMap(titlePageMap, canonical.titlePages[0]);
      changed = true;
    }
    const documentSettingsMap = doc.getMap(DOCUMENT_SETTINGS_YJS_MAP);
    if (!isDocumentSettingsMapSeeded(documentSettingsMap) && canonical.documentSettings) {
      writeDocumentSettingsToYMap(documentSettingsMap, canonical.documentSettings);
      changed = true;
    }
  });
  return changed;
}

/**
 * Loads this document's durable Yjs state (`packages/database`'s `document_yjs_state`, one row
 * per screenplay -- see that table's own doc comment for why this is snapshot durability, not yet
 * the append-only update log a later slice adds). Two top-level cases:
 *
 *  - A row already exists: this is an ordinary reconnect (or the server restarting). The stored
 *    `state` -- the full merged `Y.encodeStateAsUpdate` from the last `store` -- is decoded far
 *    enough to check whether its title page and document settings maps are seeded
 *    (`backfillTitlePageAndDocumentSettings`'s own comment explains exactly what "seeded" means
 *    and why checking it is safe to repeat). If both already are (the overwhelming common case
 *    once every collaboratively-opened screenplay has been through this once), the original bytes
 *    are handed back completely unchanged -- no extra query, no re-encoding. Only when a map is
 *    genuinely unseeded does this query `canonical_screenplay` and backfill it, returning the
 *    freshly re-encoded state instead.
 *  - No row exists yet: this screenplay has never been opened collaboratively at all. Its
 *    `canonical_screenplay` (the JSON a writer's last REST `PUT` produced, back when that route
 *    existed, or the collab server's own debounced projection since) is the only record of its
 *    content, so it is projected into editor content and encoded as a *fresh* Yjs document's
 *    initial state via `seedScreenplayYDoc` -- body, title page, and document settings together,
 *    exactly once, the first time this screenplay is opened after this slice ships.
 *    `createLocalScreenplayYDoc`'s own doc comment (which `seedScreenplayYDoc` delegates to for
 *    the body) is explicit that this conversion must never be used to *rehydrate* an
 *    already-collaborative document, which is precisely why this branch is reached only when no
 *    `document_yjs_state` row exists to rehydrate from in the first place.
 *
 * A screenplay with canonical content this editor cannot represent (more than one title page,
 * notes, dual dialogue, page breaks -- `editorContentFromScreenplay`'s own guard) cannot be seeded
 * at all; `null` here means Hocuspocus creates an empty document, matching what the web client
 * already does for such a screenplay (it never attempts to connect a collaborative editor to one
 * -- see `App.tsx`).
 */
export function createFetch(pool: Pool) {
  return async function fetch({ documentName }: fetchPayload): Promise<Uint8Array | null> {
    const stored = await pool.query<{ state: Buffer }>(
      'select state from document_yjs_state where screenplay_id = $1',
      [documentName],
    );
    const storedState = stored.rows[0]?.state;
    if (storedState) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, storedState);
      const alreadySeeded =
        isTitlePageMapSeeded(doc.getMap(TITLE_PAGE_YJS_MAP)) &&
        isDocumentSettingsMapSeeded(doc.getMap(DOCUMENT_SETTINGS_YJS_MAP));
      if (alreadySeeded) return new Uint8Array(storedState);

      const canonical = await fetchCanonicalTitlePageAndDocumentSettings(pool, documentName);
      // The screenplay row is gone (deleted between the document being opened and this fetch) --
      // nothing to backfill from; hand back the stored state exactly as found rather than treating
      // a vanished row as a reason to invent content.
      if (!canonical) return new Uint8Array(storedState);

      const migrated = backfillTitlePageAndDocumentSettings(doc, canonical);
      return migrated ? Y.encodeStateAsUpdate(doc) : new Uint8Array(storedState);
    }

    const existing = await pool.query<{ canonicalScreenplay: unknown }>(
      'select canonical_screenplay as "canonicalScreenplay" from screenplays where id = $1 and deleted_at is null',
      [documentName],
    );
    const row = existing.rows[0];
    if (!row) return null;
    try {
      const screenplay = screenplaySchema.parse(row.canonicalScreenplay);
      const content = editorContentFromScreenplay(screenplay);
      // A brand-new (or emptied-out) screenplay's `blocks` is genuinely `[]`; without this, the
      // collaborative document this seeds has no block at all for the caret to occupy --
      // `nonEmptyEditorContent`'s own doc comment on why this must be applied here explicitly,
      // matching the identical rule `App.tsx`'s `editorContent` already applies for a screenplay
      // opened without collaboration.
      const seeded = seedScreenplayYDoc(
        nonEmptyEditorContent(content.body),
        screenplay.titlePages[0],
        screenplay.documentSettings,
      );
      return Y.encodeStateAsUpdate(seeded);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'collab_seed_failed',
          documentName,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  };
}

function canonicalHash(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson).digest('hex');
}

/**
 * Persists this document's current Yjs state, debounced by Hocuspocus itself (`onStoreDocument`,
 * tuned via `debounce`/`maxDebounce` in server.ts -- see that file's own comment on the chosen
 * values). Two writes in one transaction:
 *
 *  1. `document_yjs_state`: the raw merged state, so a restart or a reconnect resumes from exactly
 *     here (`createFetch` above).
 *  2. `screenplays.canonical_screenplay`/`canonical_hash`: the projection -- "the canonical
 *     screenplay is a projection of the Yjs document rather than the thing clients PUT." Every
 *     export, every REST read (`GET /api/screenplays/:id`), and pagination all read this column
 *     unchanged from before this slice; only what keeps it current has changed.
 *
 * `titlePages`/`documentSettings` are no longer read from the *existing* row and passed through --
 * that pass-through was correct while these lived outside the Yjs document at all (the previous
 * comment here explained exactly that), but it is wrong now that they live in `document`'s own
 * `TITLE_PAGE_YJS_MAP`/`DOCUMENT_SETTINGS_YJS_MAP`: `projectYDocScreenplay` reads both directly off
 * `document`, the same `Y.Doc` this function is already storing, so there is exactly one source for
 * them, not two. Only the screenplay's `title` (a project-level field distinct from the title
 * *page*, and still not part of Yjs) still needs a fallback read from the existing row.
 *
 * Skips the write entirely when the projection is invalid (a mid-edit or otherwise unrepresentable
 * document state) -- the same "never persist an invalid projection" rule the deleted client-side
 * `scheduleSave` enforced, now enforced here since this is the only remaining writer.
 */
export function createStore(pool: Pool) {
  return async function store({ documentName, document, state }: storePayload): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const existing = await client.query<{
        title: string;
        canonicalScreenplay: { title?: string };
      }>(
        `select title, canonical_screenplay as "canonicalScreenplay"
           from screenplays
          where id = $1 and deleted_at is null
          for update`,
        [documentName],
      );
      const row = existing.rows[0];
      if (!row) {
        // The screenplay was deleted (or never existed) between this document being opened and
        // this debounced flush running. Nothing to persist to -- `document_yjs_state` is
        // FK-cascaded from `screenplays`, so leaving it untouched here is correct, not a leak.
        await client.query('rollback');
        return;
      }

      await client.query(
        `insert into document_yjs_state (screenplay_id, state, updated_at)
         values ($1, $2, now())
         on conflict (screenplay_id) do update set state = excluded.state, updated_at = excluded.updated_at`,
        [documentName, Buffer.from(state)],
      );

      const projection = projectYDocScreenplay(document, {
        id: documentName,
        title: row.canonicalScreenplay.title ?? row.title,
      });
      if (projection.valid) {
        const canonicalJson = JSON.stringify(projection.screenplay);
        await client.query(
          `update screenplays
              set canonical_screenplay = $1::jsonb, canonical_hash = $2, updated_at = now()
            where id = $3`,
          [canonicalJson, canonicalHash(canonicalJson), documentName],
        );
      }

      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };
}

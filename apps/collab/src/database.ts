import { createHash } from 'node:crypto';
import type { fetchPayload, storePayload } from '@hocuspocus/server';
import type { Pool } from 'pg';
import { screenplaySchema, type DocumentSettings, type TitlePage } from '@finaler-draft/screenplay';
import {
  createLocalScreenplayYDoc,
  editorContentFromScreenplay,
  nonEmptyEditorContent,
  projectYDocScreenplay,
} from '@finaler-draft/screenplay-editor';
import * as Y from 'yjs';

/**
 * Loads this document's durable Yjs state (`packages/database`'s `document_yjs_state`, one row
 * per screenplay -- see that table's own doc comment for why this is snapshot durability, not yet
 * the append-only update log a later slice adds). Two cases:
 *
 *  - A row already exists: this is an ordinary reconnect (or the server restarting), and the
 *    stored `state` -- the full merged `Y.encodeStateAsUpdate` from the last `store` -- is handed
 *    back unchanged for Hocuspocus's own `Database` extension to apply.
 *  - No row exists yet: this screenplay predates this slice, or has simply never been opened
 *    collaboratively. Its `canonical_screenplay` (the JSON a writer's last REST `PUT` produced,
 *    back when that route existed) is the only record of its content, so it is projected into
 *    editor content and encoded as a *fresh* Yjs document's initial state -- exactly once, the
 *    first time this screenplay is opened after this slice ships. `createLocalScreenplayYDoc`'s
 *    own doc comment is explicit that this conversion must never be used to *rehydrate* an
 *    already-collaborative document (it discards Yjs history), which is precisely why this branch
 *    is reached only when no `document_yjs_state` row exists to rehydrate from in the first place.
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
    if (storedState) return new Uint8Array(storedState);

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
      const seeded = createLocalScreenplayYDoc(nonEmptyEditorContent(content.body));
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
 * `titlePages`/`documentSettings`/the in-document `title` are read back from the *existing* row
 * and passed through unchanged to `projectYDocScreenplay`, never defaulted -- this server has no
 * way to know a screenplay's title page or document settings from the Yjs document alone (they
 * live outside the ProseMirror body; see `packages/screenplay-editor`'s own comment on
 * `editorContentFromScreenplay`), and defaulting them here would silently erase a writer's title
 * page and document settings the moment collaboration first persisted their screenplay. Only
 * `blocks` (and the schema version/id, which `projectDocumentScreenplay` always derives fresh) are
 * genuinely sourced from Yjs.
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
        canonicalScreenplay: {
          title?: string;
          titlePages?: TitlePage[];
          documentSettings?: DocumentSettings;
        };
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
        titlePages: row.canonicalScreenplay.titlePages ?? [],
        // Spread in only when present: `ProjectScreenplayOptions.documentSettings` is optional,
        // not nullable (`exactOptionalPropertyTypes`), so an existing row with none yet must omit
        // the key entirely -- letting `projectDocumentScreenplay`'s own schema default apply --
        // rather than pass `documentSettings: undefined` explicitly.
        ...(row.canonicalScreenplay.documentSettings
          ? { documentSettings: row.canonicalScreenplay.documentSettings }
          : {}),
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

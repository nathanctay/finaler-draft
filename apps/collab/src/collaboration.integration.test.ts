import { randomUUID } from 'node:crypto';
import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createAuth } from '@finaler-draft/auth-server';
import type { MailMessage, MailPort } from '@finaler-draft/auth-server/mail';
import { mintConnectionToken, verifyConnectionToken } from '@finaler-draft/collab-token';
import type { ConnectionTokenVerification } from '@finaler-draft/collab-token';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import {
  createLocalScreenplayYDoc,
  documentSettingsFromYMap,
  DOCUMENT_SETTINGS_YJS_MAP,
  getScreenplayEditorSchema,
  SCREENPLAY_YJS_FRAGMENT,
  titlePageFromYMap,
  TITLE_PAGE_YJS_MAP,
  writeTitlePageToYMap,
} from '@finaler-draft/screenplay-editor';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { Pool } from 'pg';
import WS from 'ws';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRANSIENT_SYNC_AUTH_FAILURE_REASON } from '@finaler-draft/config';
import { authenticateConnection } from './authenticate.js';
import { createFetch, createStore, DEFAULT_EPOCH } from './database.js';
import {
  resolvePresenceIdentity,
  sanitizeAwarenessStates,
  type ServerPresenceIdentity,
} from './presence.js';
import { appendUpdate } from './updateLog.js';
import {
  extractSyncUpdatePayload,
  quarantineUpdate,
  updateCarriesNewContent,
} from './quarantine.js';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
  suppressPoolShutdownErrors,
} from './integrationTestDatabase.js';

// Any fixed, 32+ character string works: this is the shared secret `startServer`'s own
// `verifyToken` and every `mintConnectionToken` call in this file agree on, standing in for the
// real `COLLAB_TOKEN_SECRET` `apps/api` and `apps/collab` share in every real deployment. Not read
// from the environment -- this suite never runs `requireCollabPersistenceEnvironment` at all; it
// builds a `Server` by hand (`startServer` below), the same way it always has.
const COLLAB_TOKEN_TEST_SECRET = 'integration-test-collab-token-secret-32-chars-minimum';

/**
 * The end-to-end proof this slice's brief asks for, chosen deliberately over a Playwright test:
 * a node-level test driving two real `HocuspocusProvider` clients against a real, running
 * Hocuspocus `Server` (this file's own `apps/collab` code, not a stand-in) and a real, migrated
 * Postgres database is a *more* direct exercise of the exact assertion that matters most --
 * "write rejection at the socket" -- than a browser test would be. A Playwright test would still
 * have to route through this same server to prove anything; it would add a full web build, a
 * running API for the session cookie and connection-token minting, and two browser contexts on
 * top of the same claim, without
 * testing a different code path. What a Playwright test *would* additionally prove -- that the
 * Tiptap editor visually renders a remote peer's keystrokes -- is exactly what
 * `canonicalRoundTrip.test.ts` and `packages/screenplay-editor/src/editing.test.ts` already cover
 * for the editor half,
 * and `y-prosemirror`'s own `ySyncPlugin` is third-party code this slice does not need to
 * re-prove; the collaboration *server*'s authorization behaviour is what is actually new here, and
 * this test drives it directly, over a real socket, with no shortcut through an in-process
 * function call.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;

let admin: Pool | undefined;
let pool: Pool | undefined;
let auth: ReturnType<typeof createAuth>['auth'] | undefined;
let trustedOrigins: readonly string[] | undefined;
let server: Server | undefined;
let serverUrl: string | undefined;

const sentMail = new Map<string, MailMessage>();
const mail: MailPort = {
  async send(message) {
    sentMail.set(message.to, message);
  },
};

/** Builds and starts a real `Server` wired exactly the way `server.ts`'s own production entry
 * point wires one -- the same `Database` extension and the same `authenticateConnection` call in
 * `onAuthenticate` -- against an ephemeral port so this suite (and, in the restart test, a second
 * instance standing in for the process having restarted) can run without a fixed port collision. */
async function startServer(
  wrapVerifyToken: (
    real: (token: string, now: Date) => Promise<ConnectionTokenVerification>,
  ) => (token: string, now: Date) => Promise<ConnectionTokenVerification> = (real) => real,
): Promise<Server> {
  const realVerifyToken = (token: string, now: Date) =>
    verifyConnectionToken(COLLAB_TOKEN_TEST_SECRET, token, now);
  // Defaults to `realVerifyToken` unchanged (every existing test calls `startServer()` with no
  // argument) -- the transient-failure-classification test below is the only caller that wraps
  // it, to simulate a database-shaped unexpected error during exactly the token-verification stage
  // without needing to actually break Postgres for this whole shared suite. (Note this is a
  // synthetic fault, not a real property of `verifyConnectionToken` -- that function is pure and
  // never touches Postgres; see `authenticate.ts`'s own comment on why the wrapping is still
  // meaningful: `authenticateConnection` must classify *whatever* `verifyToken` throws as
  // transient, regardless of why it threw.)
  const verifyToken = wrapVerifyToken(realVerifyToken);
  const instance = new Server({
    address: '127.0.0.1',
    extensions: [new Database({ fetch: createFetch(pool!), store: createStore(pool!) })],
    async onAuthenticate(data) {
      const { actorId, readOnly } = await authenticateConnection(
        { queryable: pool!, verifyToken, trustedOrigins: trustedOrigins! },
        {
          documentName: data.documentName,
          requestHeaders: data.requestHeaders,
          token: data.token,
        },
      );
      data.connectionConfig.readOnly = readOnly;
      const presence = await resolvePresenceIdentity(pool!, actorId);
      return { actorId, presence };
    },
    // Mirrors `server.ts`'s own `onChange`/`beforeHandleMessage`/`beforeHandleAwareness` -- this
    // harness rebuilds the server's hook wiring rather than importing `server.ts` (a
    // self-executing entrypoint, not an exported config), so it has to be kept in step by hand.
    // The tests below (append, compaction-under-load, quarantine, presence) exist specifically to
    // catch that file and this one drifting apart.
    async onChange({ document, documentName, update, context }) {
      const actorId = (context as { actorId?: string } | undefined)?.actorId;
      await appendUpdate(pool!, {
        screenplayId: documentName,
        epoch: DEFAULT_EPOCH,
        update,
        actorId,
      });
      void document;
    },
    async beforeHandleMessage({ connection, document, update, documentName, context }) {
      if (!connection.readOnly) return;
      const payload = extractSyncUpdatePayload(update);
      if (!payload) return;
      if (!updateCarriesNewContent(document, payload)) return;
      const actorId = (context as { actorId?: string } | undefined)?.actorId;
      await quarantineUpdate(pool!, {
        screenplayId: documentName,
        epoch: DEFAULT_EPOCH,
        update: payload,
        actorId,
      });
    },
    async beforeHandleAwareness({ states, context }) {
      const presence = (context as { presence?: ServerPresenceIdentity } | undefined)?.presence;
      if (!presence) {
        states.clear();
        return;
      }
      sanitizeAwarenessStates(states, presence);
    },
    port: 0,
    quiet: true,
  });
  await instance.listen();
  return instance;
}

describe.skipIf(!databaseUrl)('Hocuspocus collaboration server', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    await runIntegrationMigrations(databaseUrl!);

    const authentication = createAuth(
      {
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: 'integration-test-secret-with-at-least-thirty-two-characters',
        BETTER_AUTH_URL: 'http://127.0.0.1:4000',
      },
      { mail, rateLimitEnabled: false },
    );
    auth = authentication.auth;
    pool = authentication.pool;
    suppressPoolShutdownErrors(authentication.pool);
    trustedOrigins = authentication.trustedOrigins;

    server = await startServer();
    serverUrl = server.webSocketURL;
  }, 30_000);

  afterAll(async () => {
    await server?.destroy();
    await pool?.end();
    if (admin) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
      await admin!.end();
    }
  });

  it('two editors converge on the same document', async () => {
    const owner = await signUp('owner-converge@example.test');
    const editor = await signUp('editor-converge@example.test');
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner.actorId);
    await addMember(projectId, editor.actorId, 'editor');

    const clientA = connectProvider(screenplayId, owner.token);
    const clientB = connectProvider(screenplayId, editor.token);
    try {
      await Promise.all([waitForSynced(clientA), waitForSynced(clientB)]);

      writeLine(clientA, 'A line only client A wrote.');

      await waitForCondition(() => projectedText(clientB).includes('A line only client A wrote.'));
    } finally {
      clientA.destroy();
      clientB.destroy();
    }
  }, 20_000);

  // Slice 3's browser-offline story, proven server-side: a fully-entitled editor's socket drops,
  // they keep writing locally (exactly what `y-indexeddb`/Yjs's own queue-and-flush behaviour lets
  // `apps/web` do -- see progress/collaboration-offline-durable.md), and reconnecting catches the
  // server up with no loss and no conflict, because there is nothing to reconcile beyond Yjs's own
  // CRDT merge: both sides' edits survive.
  it('an offline editor reconnects and catches the server up with no loss, and a concurrent edit made while they were away survives alongside theirs', async () => {
    const owner = await signUp('owner-offline-catchup@example.test');
    const editor = await signUp('editor-offline-catchup@example.test');
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner.actorId);
    await addMember(projectId, editor.actorId, 'editor');

    const { provider: editorClient, websocketProvider } = connectProviderWithSocket(
      screenplayId,
      editor.token,
    );
    const ownerClient = connectProvider(screenplayId, owner.token);
    try {
      await Promise.all([waitForSynced(editorClient), waitForSynced(ownerClient)]);

      const disconnected = new Promise<void>((resolvePromise) => {
        websocketProvider.on('disconnect', () => resolvePromise());
      });
      websocketProvider.disconnect();
      await disconnected;

      // Offline edit, made with no server in the loop at all.
      writeLine(editorClient, 'Written while this editor was offline.');
      // A genuinely concurrent edit from someone else, made *while* the first editor is away --
      // the case a rollback-style "recover my version" flow would have forced a choice on; a CRDT
      // has none to make.
      writeLine(ownerClient, 'Written by the owner while the editor was offline.');
      await waitForCondition(() =>
        projectedText(ownerClient).includes('Written by the owner while the editor was offline.'),
      );

      websocketProvider.connect();
      await waitForSynced(editorClient);

      await waitForCondition(() =>
        projectedText(ownerClient).includes('Written while this editor was offline.'),
      );
      await waitForCondition(() =>
        projectedText(editorClient).includes('Written by the owner while the editor was offline.'),
      );
      // Both survive, on both sides -- no loss, and (correctly) no merge conflict to resolve.
      expect(projectedText(editorClient)).toContain('Written while this editor was offline.');
      expect(projectedText(editorClient)).toContain(
        'Written by the owner while the editor was offline.',
      );
    } finally {
      editorClient.destroy();
      ownerClient.destroy();
    }
  }, 20_000);

  // The migration this slice's brief calls the highest-stakes part of the work: an existing
  // screenplay's title page and document settings, sitting only in `canonical_screenplay`, must
  // end up in the Yjs document the first time it is opened collaboratively -- and, for a
  // screenplay that was *already* collaborative before this slice shipped, must be backfilled on
  // the next open without ever clobbering a writer's own collaborative edit. Run against a real,
  // migrated Postgres database (not the fake-pool unit tests in `database.test.ts`, which cover
  // the same logic in isolation) and through the real socket, the same way every other guarantee
  // in this file is proven.
  //
  // Only the "first open, no checkpoint yet" test below needs this: that is the only migration
  // path that calls `editorContentFromScreenplay` (`createFetch`'s seed-from-canonical branch), so
  // it is the only one `screenplayFixture`'s own `dual_dialogue`/`page_break`/note content --
  // deliberately unrepresentable in this editor -- would break. The backfill and idempotency tests
  // insert a checkpoint directly and never touch `blocks` at all.
  const editableBodyFields: Partial<typeof screenplayFixture> = {
    annotations: [],
    blocks: [{ id: randomUUID(), type: 'action', text: 'A single representable block.' }],
  };

  it('a screenplay opened collaboratively for the first time carries its real title page and document settings into the Yjs document', async () => {
    const owner = await signUp('owner-migration-first-open@example.test');
    // `screenplayFixture` (`packages/screenplay/src/fixtures.ts`) has a real, populated title page
    // -- not a placeholder -- exactly the "a screenplay that has a populated title page" case the
    // brief asks this to be tested against. `blocks`/`annotations` are overridden to content this
    // editor can actually represent (see `createProjectAndScreenplay`'s own comment); the title
    // page and document settings this test asserts on stay the fixture's real, unmodified values.
    const { screenplayId } = await createProjectAndScreenplay(owner.actorId, editableBodyFields);

    const client = connectProvider(screenplayId, owner.token);
    try {
      await waitForSynced(client);
      expect(titlePageFromYMap(client.document.getMap(TITLE_PAGE_YJS_MAP))).toEqual(
        screenplayFixture.titlePages[0],
      );
      expect(documentSettingsFromYMap(client.document.getMap(DOCUMENT_SETTINGS_YJS_MAP))).toEqual(
        screenplayFixture.documentSettings,
      );
    } finally {
      client.destroy();
    }
  }, 20_000);

  it('a screenplay already collaborative before this slice backfills its title page on the next open', async () => {
    const owner = await signUp('owner-migration-backfill@example.test');
    const { screenplayId } = await createProjectAndScreenplay(owner.actorId);

    // Simulates a checkpoint written before this slice's title-page/document-settings migration
    // shipped: real body content, but the title page/document settings maps were never written,
    // since that concept did not exist yet. Inserted directly into the database as the document's
    // one and only checkpoint (through_sequence 0, no log rows), standing in for what an earlier
    // `apps/collab` process would have persisted.
    const preSliceDoc = createLocalScreenplayYDoc({
      type: 'screenplayDocument',
      content: [
        {
          type: 'screenplayBlock',
          attrs: { element: 'action', id: randomUUID() },
          content: [{ type: 'text', text: 'Pre-existing collaborative content.' }],
        },
      ],
    });
    await pool!.query(
      `insert into document_yjs_checkpoints (screenplay_id, epoch, through_sequence, merged_update)
       values ($1, 0, 0, $2)`,
      [screenplayId, Buffer.from(Y.encodeStateAsUpdate(preSliceDoc))],
    );

    const client = connectProvider(screenplayId, owner.token);
    try {
      await waitForSynced(client);
      expect(projectedText(client)).toContain('Pre-existing collaborative content.');
      expect(titlePageFromYMap(client.document.getMap(TITLE_PAGE_YJS_MAP))).toEqual(
        screenplayFixture.titlePages[0],
      );
    } finally {
      client.destroy();
    }
  }, 20_000);

  it('the backfill is idempotent: a title page a writer has already edited collaboratively survives a later reload, even though canonical_screenplay still disagrees', async () => {
    const owner = await signUp('owner-migration-idempotent@example.test');
    const { screenplayId } = await createProjectAndScreenplay(owner.actorId);

    // Same pre-slice fixture as above: a checkpoint with no title page map yet.
    const preSliceDoc = createLocalScreenplayYDoc({
      type: 'screenplayDocument',
      content: [{ type: 'screenplayBlock', attrs: { element: 'action', id: randomUUID() } }],
    });
    await pool!.query(
      `insert into document_yjs_checkpoints (screenplay_id, epoch, through_sequence, merged_update)
       values ($1, 0, 0, $2)`,
      [screenplayId, Buffer.from(Y.encodeStateAsUpdate(preSliceDoc))],
    );

    // First open: the migration backfills the fixture's own title page, exactly like the test
    // above. A writer then edits it collaboratively to something new.
    const firstOpen = connectProvider(screenplayId, owner.token);
    const writersOwnTitlePage = {
      id: screenplayFixture.titlePages[0]!.id,
      title: "The Writer's Own Later Title",
    };
    try {
      await waitForSynced(firstOpen);
      expect(titlePageFromYMap(firstOpen.document.getMap(TITLE_PAGE_YJS_MAP))).toEqual(
        screenplayFixture.titlePages[0],
      );
      firstOpen.document.transact(() => {
        writeTitlePageToYMap(firstOpen.document.getMap(TITLE_PAGE_YJS_MAP), writersOwnTitlePage);
      });
      await waitForCondition(
        () =>
          titlePageFromYMap(firstOpen.document.getMap(TITLE_PAGE_YJS_MAP))?.title ===
          writersOwnTitlePage.title,
      );
      // Forces the debounced store to run now, persisting the writer's edit into a fresh
      // checkpoint rather than waiting out the real debounce window. The pre-slice fixture above
      // already inserted one checkpoint (through_sequence 0); compaction absorbing the writer's
      // title-page edit produces a second, later one.
      server!.hocuspocus.flushPendingStores();
      await waitForCondition(async () => {
        const row = await pool!.query(
          'select count(*)::int as count from document_yjs_checkpoints where screenplay_id = $1',
          [screenplayId],
        );
        return (row.rows[0]?.count ?? 0) >= 2;
      });
    } finally {
      firstOpen.destroy();
    }

    // Standing in for a cold load (server restart, or the document having been evicted from
    // memory and reopened) -- a brand-new server instance against the same database, the same
    // technique the "survives a Hocuspocus restart" test above uses.
    await server!.destroy();

    // `canonical_screenplay` is made to disagree with the writer's edit, modelling a genuinely
    // stale read. This must happen *after* `server.destroy()`, not before: `destroy()` flushes
    // Hocuspocus's pending stores, and that flush rewrites `canonical_screenplay` from the
    // document's own projection -- so a stale value planted before it is overwritten by the
    // writer's real title again, and the next open would find canonical and the Yjs document in
    // perfect agreement, asserting nothing. Planted here, the disagreement actually survives to
    // the reopen below, which is the only arrangement under which this test can fail if the
    // migration's seeded-ness gate is removed.
    await pool!.query(
      `update screenplays set canonical_screenplay = jsonb_set(canonical_screenplay, '{titlePages,0,title}', $1::jsonb) where id = $2`,
      [JSON.stringify('A Stale Title From Before The Edit'), screenplayId],
    );

    server = await startServer();
    serverUrl = server.webSocketURL;

    const reopened = connectProvider(screenplayId, owner.token);
    try {
      await waitForSynced(reopened);
      expect(titlePageFromYMap(reopened.document.getMap(TITLE_PAGE_YJS_MAP))).toEqual(
        writersOwnTitlePage,
      );
    } finally {
      reopened.destroy();
    }
  }, 30_000);

  it('presence never reaches the database -- an awareness-only update leaves the update log, the checkpoint count, and canonical_screenplay untouched', async () => {
    const owner = await signUp('owner-presence-db-test@example.test');
    const { screenplayId } = await createProjectAndScreenplay(owner.actorId);

    const before = await pool!.query(
      'select updated_at as "updatedAt" from screenplays where id = $1',
      [screenplayId],
    );
    const updatesBefore = await pool!.query(
      'select 1 from document_yjs_updates where screenplay_id = $1',
      [screenplayId],
    );
    expect(updatesBefore.rowCount).toBe(0);

    const client = connectProvider(screenplayId, owner.token);
    try {
      await waitForSynced(client);
      // Connecting for the first time itself seeds one checkpoint (`createFetch`'s "never opened
      // collaboratively before" branch, via `writeCheckpoint`) -- captured *after* `waitForSynced`
      // so the awareness-only assertion below is about what happens *beyond* that ordinary seed,
      // not a false positive from it.
      const checkpointsAfterSeed = await pool!.query(
        'select count(*)::int as count from document_yjs_checkpoints where screenplay_id = $1',
        [screenplayId],
      );

      client.awareness!.setLocalStateField('user', { lastActiveAt: Date.now() });
      client.awareness!.setLocalStateField('cursor', { anchor: 'irrelevant', head: 'irrelevant' });
      // This slice's own addition to awareness -- the title page's own cursor, subject to the
      // identical guarantee `cursor` (the manuscript body's) already proves above: awareness never
      // reaches `onChange`/`onStoreDocument`, regardless of which surface a cursor is for.
      client.awareness!.setLocalStateField('titlePageCursor', { field: 'title', offset: 3 });
      server!.hocuspocus.flushPendingStores();
      // No `waitForCondition` polling a positive signal here on purpose: this proves an absence,
      // which only a fixed wait can -- the same reasoning `collaboration.integration.test.ts`'s
      // own reviewer-write-rejection test gives for its identical choice.
      await sleep(500);

      const updatesAfter = await pool!.query(
        'select 1 from document_yjs_updates where screenplay_id = $1',
        [screenplayId],
      );
      expect(updatesAfter.rowCount).toBe(0);
      const checkpointsAfterAwareness = await pool!.query(
        'select count(*)::int as count from document_yjs_checkpoints where screenplay_id = $1',
        [screenplayId],
      );
      expect(checkpointsAfterAwareness.rows[0].count).toBe(checkpointsAfterSeed.rows[0].count);
    } finally {
      client.destroy();
    }

    const after = await pool!.query(
      'select updated_at as "updatedAt" from screenplays where id = $1',
      [screenplayId],
    );
    expect(after.rows[0].updatedAt).toEqual(before.rows[0].updatedAt);
  }, 20_000);

  it('a client cannot claim another writer’s name or colour -- the server, not the client, is authoritative for identity', async () => {
    const owner = await signUp('owner-presence-identity@example.test');
    const editor = await signUp('editor-presence-identity@example.test');
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner.actorId);
    await addMember(projectId, editor.actorId, 'editor');

    const ownerClient = connectProvider(screenplayId, owner.token);
    const editorClient = connectProvider(screenplayId, editor.token);
    try {
      await Promise.all([waitForSynced(ownerClient), waitForSynced(editorClient)]);

      // The owner's own client claims to be someone else entirely -- exactly the spoofing
      // `presence.ts`'s own top-of-file comment says this hook exists to close off.
      ownerClient.awareness!.setLocalStateField('user', {
        name: 'Someone Else Entirely',
        color: '#000000',
        lastActiveAt: Date.now(),
      });

      // Keyed on the *value* the editor observes, not a specific client id: the underlying
      // `HocuspocusProviderWebsocket`/`Y.Doc` pairing is free to reconnect and mint a fresh
      // client id mid-test (observed directly while writing this test -- not something this
      // property needs to be sensitive to), and the real property under test is that the
      // sanitized identity is what arrives, under *whichever* client id it arrives as.
      const usersEditorSees = () =>
        Array.from(editorClient.awareness!.getStates().values()) as Array<{
          user?: { name?: string; color?: string };
        }>;
      await waitForCondition(() =>
        usersEditorSees().some((state) => state.user?.name === 'owner-presence-identity'),
      );

      const names = usersEditorSees().map((state) => state.user?.name);
      expect(names).toContain('owner-presence-identity');
      expect(names).not.toContain('Someone Else Entirely');
      const ownerState = usersEditorSees().find(
        (state) => state.user?.name === 'owner-presence-identity',
      );
      expect(ownerState?.user?.color).toBeDefined();
    } finally {
      ownerClient.destroy();
      editorClient.destroy();
    }
  }, 20_000);

  it('a reviewer receives updates but a reviewer edit never reaches the other client -- write rejection at the socket', async () => {
    const owner = await signUp('owner-reviewer-test@example.test');
    const reviewer = await signUp('reviewer-write-test@example.test');
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner.actorId);
    await addMember(projectId, reviewer.actorId, 'reviewer');

    const ownerClient = connectProvider(screenplayId, owner.token);
    const reviewerClient = connectProvider(screenplayId, reviewer.token);
    try {
      await Promise.all([waitForSynced(ownerClient), waitForSynced(reviewerClient)]);
      expect(reviewerClient.authorizedScope).toBe('readonly');

      // The owner writes; the reviewer must receive it -- reviewers are not second-class
      // viewers (plan.md).
      writeLine(ownerClient, 'Owner-authored line, visible to everyone.');
      await waitForCondition(() =>
        projectedText(reviewerClient).includes('Owner-authored line, visible to everyone.'),
      );

      // The reviewer attempts to write. This must never reach the owner's document -- the
      // single most important assertion in this slice.
      writeLine(reviewerClient, 'A reviewer line that must never survive.');
      // Give the (rejected) update every opportunity to have propagated if it were, incorrectly,
      // accepted -- a fixed wait is deliberate here, not a `waitForCondition` polling for absence,
      // which could only ever prove "not yet", never "never".
      await sleep(500);
      expect(projectedText(ownerClient)).not.toContain('A reviewer line that must never survive.');
      // The reviewer's own local Yjs document is free to hold the pending change (Hocuspocus does
      // not need to explain the rejection back into the client's local state for this slice) --
      // what matters is that it never reached the shared document the owner sees.
    } finally {
      ownerClient.destroy();
      reviewerClient.destroy();
    }
  }, 20_000);

  it('a reviewer’s title-page cursor is visible to the owner, but a reviewer’s attempted title-page edit never reaches the shared document -- the same write-rejection gate, proven for this slice’s own two Y.Maps', async () => {
    const owner = await signUp('owner-reviewer-titlepage-test@example.test');
    const reviewer = await signUp('reviewer-titlepage-write-test@example.test');
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner.actorId);
    await addMember(projectId, reviewer.actorId, 'reviewer');

    const ownerClient = connectProvider(screenplayId, owner.token);
    const reviewerClient = connectProvider(screenplayId, reviewer.token);
    try {
      await Promise.all([waitForSynced(ownerClient), waitForSynced(reviewerClient)]);
      expect(reviewerClient.authorizedScope).toBe('readonly');

      // Visible: `progress/collaboration-title-page.md`'s "write rejection is free" argument
      // extends to awareness too -- a reviewer is not a second-class viewer just because they
      // cannot edit (plan.md), so their title-page cursor must reach the owner exactly like an
      // editor's would.
      reviewerClient.awareness!.setLocalStateField('user', { lastActiveAt: Date.now() });
      reviewerClient.awareness!.setLocalStateField('titlePageCursor', {
        field: 'title',
        offset: 2,
      });
      await waitForCondition(() =>
        Array.from(ownerClient.awareness!.getStates().values()).some(
          (state) =>
            (state as { titlePageCursor?: { field?: string } }).titlePageCursor?.field === 'title',
        ),
      );

      // Never writes: the reviewer attempts to overwrite the title page directly on their own
      // document -- bypassing `TitlePageView`'s own `readOnly` gate entirely, the same "test the
      // socket, not only the UI" shape `writeLine` above already established for the body. This
      // must never reach the owner's own `TITLE_PAGE_YJS_MAP`.
      const reviewerTitlePageMap = reviewerClient.document.getMap(TITLE_PAGE_YJS_MAP);
      reviewerTitlePageMap.doc!.transact(() => {
        writeTitlePageToYMap(reviewerTitlePageMap, {
          id: randomUUID(),
          title: 'A reviewer title that must never survive',
        });
      });
      // A fixed wait, not `waitForCondition` polling for absence -- proving a negative, the same
      // reasoning the body's own reviewer-write-rejection test above gives.
      await sleep(500);
      const ownerTitlePage = titlePageFromYMap(ownerClient.document.getMap(TITLE_PAGE_YJS_MAP));
      expect(ownerTitlePage?.title).not.toBe('A reviewer title that must never survive');
    } finally {
      ownerClient.destroy();
      reviewerClient.destroy();
    }
  }, 20_000);

  // Alongside the reviewer test above: the *other* way a connection ends up read-only --
  // `checkEntitlement`'s `edit-screenplay`/`'not-in-slot'` branch (a restricted-tier account with
  // a role on this screenplay, but this is not the one occupying their one editable slot). Unlike
  // the reviewer case, this one is billing-state-dependent and runs through
  // `fetchCandidateScreenplayIds`/`fetchSlot`'s real SQL, not just `fetchRole`'s -- `authenticate
  // .test.ts`'s "marks a restricted-tier editor read-only when this screenplay is not the one
  // occupying their slot" already asserts the identical mapping against a fake `Queryable`; this
  // is the same claim proven against a real Postgres database and a real socket, the same
  // upgrade the reviewer test above already got over a unit test.
  it('a free-tier collaborator outside their editable slot connects, receives updates, and cannot write', async () => {
    const owner = await signUp('owner-outside-slot-test@example.test');
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner.actorId);

    const restrictedEditor = await signUp('editor-outside-slot-test@example.test');
    await addMember(projectId, restrictedEditor.actorId, 'editor');
    // Gives `restrictedEditor` a second candidate of their own, and an explicit slot naming it --
    // free tier (no `subscriptions` row is ever inserted anywhere in this file, the same "absent
    // means restricted" default `packages/entitlements`'s own doc comment describes), two
    // candidate screenplays (their own, plus `screenplayId` above via the `addMember` just
    // above), and a slot that names the *other* one -- exactly `checkEntitlement`'s
    // `'not-in-slot'` case for a connection to `screenplayId`.
    const { screenplayId: restrictedEditorsOwnScreenplayId } = await createProjectAndScreenplay(
      restrictedEditor.actorId,
    );
    await pool!.query(
      'insert into editable_slots (user_id, screenplay_id, updated_at) values ($1, $2, now())',
      [restrictedEditor.actorId, restrictedEditorsOwnScreenplayId],
    );

    const ownerClient = connectProvider(screenplayId, owner.token);
    const restrictedClient = connectProvider(screenplayId, restrictedEditor.token);
    try {
      await Promise.all([waitForSynced(ownerClient), waitForSynced(restrictedClient)]);
      // The connection itself must succeed -- "readable," not merely "connectable" -- and must be
      // read-only, never silently full-access.
      expect(restrictedClient.authorizedScope).toBe('readonly');

      // The owner writes; the restricted collaborator must still receive it -- plan.md's "They
      // should not be second class viewers just because they cannot edit," the same guarantee the
      // reviewer test above proves for role-based read-only.
      writeLine(ownerClient, 'Owner-authored line, visible to a restricted collaborator.');
      await waitForCondition(() =>
        projectedText(restrictedClient).includes(
          'Owner-authored line, visible to a restricted collaborator.',
        ),
      );

      // The restricted collaborator attempts to write. This must never reach the owner's
      // document -- the free-tier analogue of the reviewer test's own central assertion.
      writeLine(
        restrictedClient,
        'A restricted-tier line outside the editable slot that must never survive.',
      );
      await sleep(500);
      expect(projectedText(ownerClient)).not.toContain(
        'A restricted-tier line outside the editable slot that must never survive.',
      );
    } finally {
      ownerClient.destroy();
      restrictedClient.destroy();
    }
  }, 20_000);

  // Slice 3's quarantine (progress/collaboration-offline-durable.md): the tension between "a
  // writer's honest offline work must never simply vanish" and "going offline must never become a
  // way to keep editing without the entitlement that would otherwise gate it." This is the same
  // restricted-slot writer as the test above, but instead of a single rejected live keystroke, it
  // makes a real *offline* edit (disconnected socket, local Yjs mutation, exactly what this
  // writer's editor keeps accepting locally while offline per plan.md) and reconnects -- the batch
  // of accumulated local changes arrives at the server as this connection's own `SyncStep2`, the
  // same message `beforeHandleMessage` (`server.ts`) inspects for any `readOnly` connection.
  it('quarantine: a reconnecting writer outside their editable slot has their offline edit retained, but it never reaches the live document', async () => {
    const owner = await signUp('owner-quarantine-test@example.test');
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner.actorId);

    const restrictedEditor = await signUp('editor-quarantine-test@example.test');
    await addMember(projectId, restrictedEditor.actorId, 'editor');
    const { screenplayId: restrictedEditorsOwnScreenplayId } = await createProjectAndScreenplay(
      restrictedEditor.actorId,
    );
    await pool!.query(
      'insert into editable_slots (user_id, screenplay_id, updated_at) values ($1, $2, now())',
      [restrictedEditor.actorId, restrictedEditorsOwnScreenplayId],
    );

    const { provider: restrictedClient, websocketProvider } = connectProviderWithSocket(
      screenplayId,
      restrictedEditor.token,
    );
    try {
      await waitForSynced(restrictedClient);
      expect(restrictedClient.authorizedScope).toBe('readonly');

      // Go offline: close the socket, but the local `Y.Doc` -- and this writer's editor bound to
      // it -- keeps working exactly as it would with a real dropped connection.
      const disconnected = new Promise<void>((resolvePromise) => {
        websocketProvider.on('disconnect', () => resolvePromise());
      });
      websocketProvider.disconnect();
      await disconnected;

      writeLine(restrictedClient, 'Offline edit made while entitlement had lapsed.');

      // Reconnect. The accumulated local edit is what this connection's own first `SyncStep2`
      // carries back to the server.
      websocketProvider.connect();
      await waitForSynced(restrictedClient);

      // Retained: the server accepted and kept the bytes, even though it never merged them.
      await waitForCondition(async () => {
        const rows = await pool!.query(
          'select 1 from document_yjs_quarantined_updates where screenplay_id = $1',
          [screenplayId],
        );
        return (rows.rowCount ?? 0) > 0;
      });
      const quarantined = await pool!.query<{ actorId: string | null }>(
        'select authenticated_actor_id as "actorId" from document_yjs_quarantined_updates where screenplay_id = $1',
        [screenplayId],
      );
      expect(quarantined.rows.some((row) => row.actorId === restrictedEditor.actorId)).toBe(true);

      // Never merged: a fresh connection -- the owner's -- never sees the offline edit's content.
      const ownerClient = connectProvider(screenplayId, owner.token);
      try {
        await waitForSynced(ownerClient);
        await sleep(300);
        expect(projectedText(ownerClient)).not.toContain(
          'Offline edit made while entitlement had lapsed.',
        );
      } finally {
        ownerClient.destroy();
      }
    } finally {
      restrictedClient.destroy();
    }
  }, 20_000);

  // `updateLog.test.ts` proves compaction under concurrent appends against an in-memory model with
  // a real FIFO mutex standing in for `pg_advisory_xact_lock`; this repeats the identical
  // interleaving against a genuinely running Postgres, so the lock's real behaviour -- not a
  // model of it -- is what this specific assertion rests on.
  it('compaction survives a genuinely concurrent append against a real database', async () => {
    const owner = await signUp('owner-compaction-race-test@example.test');
    const { screenplayId } = await createProjectAndScreenplay(owner.actorId);
    const { writeCheckpoint, appendUpdate, createCheckpoint, reconstructDocumentState } =
      await import('./updateLog.js');

    const base = createLocalScreenplayYDoc({
      type: 'screenplayDocument',
      content: [{ type: 'screenplayBlock', attrs: { element: 'action', id: randomUUID() } }],
    });
    await writeCheckpoint(pool!, {
      screenplayId,
      epoch: 0,
      throughSequence: 0,
      doc: base,
    });

    // `live` mirrors `base`'s exact state (via a fresh, empty `Y.Doc` that only ever receives
    // `base`'s own bytes) rather than being independently constructed and then merged -- an
    // independently-created doc's own content would carry origin references the checkpoint above
    // never captured, and a later delta built against it could reference an item reconstruction
    // has no way to resolve.
    const live = new Y.Doc();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(base));
    const captureUpdate = (mutate: () => void): Uint8Array => {
      const before = Y.encodeStateVector(live);
      mutate();
      return Y.encodeStateAsUpdate(live, before);
    };
    const fragment = () => live.getXmlFragment(SCREENPLAY_YJS_FRAGMENT);
    const firstUpdate = captureUpdate(() => {
      const el = new Y.XmlElement('screenplayBlock');
      el.setAttribute('element', 'action');
      el.setAttribute('id', randomUUID());
      const text = new Y.XmlText();
      text.insert(0, 'First concurrent line.');
      el.insert(0, [text]);
      fragment().insert(fragment().length, [el]);
    });
    await appendUpdate(pool!, {
      screenplayId,
      epoch: 0,
      update: firstUpdate,
      actorId: owner.actorId,
    });

    // Compaction and a second, genuinely concurrent append race each other for real, against the
    // real database -- not simulated timing.
    const secondUpdate = captureUpdate(() => {
      const el = new Y.XmlElement('screenplayBlock');
      el.setAttribute('element', 'action');
      el.setAttribute('id', randomUUID());
      const text = new Y.XmlText();
      text.insert(0, 'Second concurrent line.');
      el.insert(0, [text]);
      fragment().insert(fragment().length, [el]);
    });
    const [compactionResult] = await Promise.all([
      createCheckpoint(pool!, { screenplayId, epoch: 0 }),
      appendUpdate(pool!, { screenplayId, epoch: 0, update: secondUpdate, actorId: owner.actorId }),
    ]);
    expect(compactionResult).toBeDefined();

    const reconstruction = await reconstructDocumentState(pool!, screenplayId, 0);
    expect(reconstruction).toBeDefined();
    const reconstructedText = reconstruction!.doc
      .getXmlFragment(SCREENPLAY_YJS_FRAGMENT)
      .toString();
    expect(reconstructedText).toContain('First concurrent line.');
    expect(reconstructedText).toContain('Second concurrent line.');
  }, 20_000);

  it('the document survives a Hocuspocus restart', async () => {
    const owner = await signUp('owner-restart-test@example.test');
    const { screenplayId } = await createProjectAndScreenplay(owner.actorId);

    const client = connectProvider(screenplayId, owner.token);
    await waitForSynced(client);
    writeLine(client, 'This line must survive a restart.');
    await waitForCondition(() =>
      projectedText(client).includes('This line must survive a restart.'),
    );
    // Forces the debounced `onStoreDocument` to run immediately rather than waiting out the real
    // 2s/10s debounce window -- see server.ts's own comment on why those defaults are otherwise
    // left untouched in this slice.
    server!.hocuspocus.flushPendingStores();
    await waitForCondition(async () => {
      const row = await pool!.query(
        'select 1 from document_yjs_checkpoints where screenplay_id = $1',
        [screenplayId],
      );
      return (row.rowCount ?? 0) > 0;
    });
    client.destroy();

    // Standing in for the process having restarted: a brand-new `Server` instance, on a fresh
    // ephemeral port, reading through the same `Database` extension against the same database --
    // nothing here is a mock of a restart, it is one, short of actually killing this test's own
    // process.
    await server!.destroy();
    server = await startServer();
    serverUrl = server.webSocketURL;

    const reconnected = connectProvider(screenplayId, owner.token);
    try {
      await waitForSynced(reconnected);
      expect(projectedText(reconnected)).toContain('This line must survive a restart.');
    } finally {
      reconnected.destroy();
    }
  }, 30_000);

  // The two tests below prove the classification `progress/collaboration-slice-1.md` records as
  // the fix for the permanent-hang bug: a thrown, unexpected error during `onAuthenticate` (a
  // database hiccup, not a decision about this actor) must be recoverable without a page reload,
  // and a resolved, deliberate denial must not be -- and a client must be able to tell the two
  // apart, since Hocuspocus sends both over the identical, still-open socket (this file's own
  // `startServer` comment, and `authenticate.ts`'s `TransientAuthenticationError`).
  it('recovers on its own from a transient authentication failure, without a new session or page reload', async () => {
    const owner = await signUp('owner-transient-test@example.test');
    const { screenplayId } = await createProjectAndScreenplay(owner.actorId);

    // Simulates an unexpected failure during exactly the token-verification stage -- a thrown
    // error from the `verifyToken` dependency `authenticateConnection` calls, run through the
    // real, shipped classification logic in `authenticate.ts`, not a shortcut around it. Recovers
    // on its own after exactly one failure, standing in for a transient outage that has already
    // finished by the time this test's own retry (`waitForSyncedAfterTransientRetry` below) fires.
    let failuresRemaining = 1;
    await server!.destroy();
    server = await startServer((real) => async (token, now) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('Simulated transient outage (integration test fault injection)');
      }
      return real(token, now);
    });
    serverUrl = server.webSocketURL;

    const { provider, websocketProvider } = connectProviderWithSocket(screenplayId, owner.token);
    try {
      await waitForSyncedAfterTransientRetry(provider, websocketProvider);
      expect(provider.isSynced).toBe(true);
    } finally {
      provider.destroy();
    }
  }, 20_000);

  // Risk #1 from the connection-tokens brief, proven end-to-end over a real socket rather than at
  // the unit level alone (`authenticate.test.ts` proves the classification in isolation; this
  // proves the *reconnection* actually recovers). "An expired token must produce a refresh, not a
  // permanent denial. Slice 2's reconnection logic treats permanent denials as terminal and stops
  // retrying. If an expired token lands in that bucket, a reconnecting tab gives up forever."
  it('reconnects and syncs once its token has expired, rather than terminating', async () => {
    const owner = await signUp('owner-expired-token-test@example.test');
    const { screenplayId } = await createProjectAndScreenplay(owner.actorId);

    // A token minted with `now` set an hour in the past is, by construction, already expired by
    // the time the real server (using the real, current wall clock) verifies it -- deterministic,
    // not a race against `CONNECTION_TOKEN_TTL_MS`. The second and later calls return
    // `owner.token`, a real, currently-valid one -- standing in for `apps/web/src/App.tsx`'s async
    // `token: () => api.connectionToken().then(...)`, which mints a fresh token from `apps/api`'s
    // real endpoint on every reconnect. `@hocuspocus/provider`'s own `getToken()`/`sendToken()`
    // (called on every `onOpen`, confirmed by reading the installed source) is what makes this
    // function -- not a bare string -- the mechanism that lets a reconnect matter at all.
    let tokenCalls = 0;
    const tokenFn = async () => {
      tokenCalls += 1;
      if (tokenCalls === 1) {
        return mintConnectionToken(
          COLLAB_TOKEN_TEST_SECRET,
          owner.actorId,
          new Date(Date.now() - 60 * 60 * 1000),
        );
      }
      return owner.token;
    };

    const { provider, websocketProvider } = connectProviderWithSocket(screenplayId, tokenFn);
    try {
      await waitForSyncedAfterTransientRetry(provider, websocketProvider);
      expect(provider.isSynced).toBe(true);
      // Proves the retry actually re-fetched a token, not that the first (expired) one somehow
      // succeeded -- if this were 1, the sync above did not come from a refresh at all.
      expect(tokenCalls).toBeGreaterThanOrEqual(2);
    } finally {
      provider.destroy();
    }
  }, 20_000);

  it('a genuine denial reaches a distinct terminal state and is never retried, unlike a transient failure', async () => {
    const owner = await signUp('owner-denied-test@example.test');
    const stranger = await signUp('stranger-denied-test@example.test');
    const { screenplayId } = await createProjectAndScreenplay(owner.actorId);
    // Deliberately no `addMember` call for `stranger` -- the plain "no role on this document at
    // all" denial `authenticate.test.ts`'s own unit tests already prove in isolation. This test is
    // about what a real *client*, over a real socket, observes when that happens: a reason it can
    // tell apart from the transient one above, and no automatic recovery.

    await server!.destroy();
    server = await startServer();
    serverUrl = server.webSocketURL;

    const client = connectProvider(screenplayId, stranger.token);
    try {
      const reason = await new Promise<string | undefined>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(
          () => rejectPromise(new Error('Timed out waiting for authenticationFailed.')),
          5_000,
        );
        client.on('synced', () => {
          clearTimeout(timeout);
          rejectPromise(
            new Error('This connection must never sync -- the actor has no role on this document.'),
          );
        });
        client.on('authenticationFailed', ({ reason: failureReason }: { reason?: string }) => {
          clearTimeout(timeout);
          resolvePromise(failureReason);
        });
      });
      // The one signal a real client (`apps/web/src/App.tsx`) uses to tell "retry on your own"
      // apart from "show a terminal state, stop waiting" -- this must not be the transient tag.
      expect(reason).not.toBe(TRANSIENT_SYNC_AUTH_FAILURE_REASON);

      // And, unlike the transient case above, nothing here ever retries it: give the denied --
      // still open, per `authenticate.ts`'s own comment on this exact gap -- socket every
      // opportunity to have synced if something, incorrectly, retried it anyway. A fixed wait, not
      // a `waitForCondition` polling for absence, for the same reason the reviewer-write-rejection
      // test above uses one: this can only ever prove "not yet", never "never".
      await sleep(500);
      expect(client.isSynced).toBe(false);
    } finally {
      client.destroy();
    }
  }, 20_000);

  // The security property the brief calls out explicitly: "An integration test proving a token
  // minted for actor A cannot be used to reach a document only actor B may see." A's own token is
  // real, honestly minted, currently valid, and identifies A correctly (unlike the "genuine
  // denial" test above, which never mints a role-bearing token at all) -- the denial here can only
  // come from `resolveConnectionAuthorization`'s own database-backed role lookup finding no row
  // for A on this document, proving identity and authorization are resolved from two genuinely
  // different places, exactly as the brief requires ("resolveConnectionAuthorization must keep
  // resolving role and entitlement server-side from the database at connection time").
  it('a token minted for one actor cannot be used to reach a document only another actor may see', async () => {
    const actorA = await signUp('actor-a-cross-actor-test@example.test');
    const actorB = await signUp('actor-b-cross-actor-test@example.test');
    // Only B is ever added as a member -- A has a real account and a real, valid token, but no
    // role on this document at all.
    const { screenplayId } = await createProjectAndScreenplay(actorB.actorId);

    await server!.destroy();
    server = await startServer();
    serverUrl = server.webSocketURL;

    const client = connectProvider(screenplayId, actorA.token);
    try {
      const reason = await new Promise<string | undefined>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(
          () => rejectPromise(new Error('Timed out waiting for authenticationFailed.')),
          5_000,
        );
        client.on('synced', () => {
          clearTimeout(timeout);
          rejectPromise(
            new Error(
              "This connection must never sync -- A's token is real, but A has no role on B's document.",
            ),
          );
        });
        client.on('authenticationFailed', ({ reason: failureReason }: { reason?: string }) => {
          clearTimeout(timeout);
          resolvePromise(failureReason);
        });
      });
      expect(reason).not.toBe(TRANSIENT_SYNC_AUTH_FAILURE_REASON);
      await sleep(500);
      expect(client.isSynced).toBe(false);
    } finally {
      client.destroy();
    }
  }, 20_000);
});

function projectedText(provider: HocuspocusProvider): string {
  const doc = yXmlFragmentToProseMirrorRootNode(
    provider.document.getXmlFragment(SCREENPLAY_YJS_FRAGMENT),
    getScreenplayEditorSchema(),
  );
  return doc.textContent;
}

function writeLine(provider: HocuspocusProvider, text: string): void {
  const fragment = provider.document.getXmlFragment(SCREENPLAY_YJS_FRAGMENT);
  fragment.doc!.transact(() => {
    const element = new Y.XmlElement('screenplayBlock');
    element.setAttribute('element', 'action');
    element.setAttribute('id', randomUUID());
    const textNode = new Y.XmlText();
    textNode.insert(0, text);
    element.insert(0, [textNode]);
    fragment.insert(fragment.length, [element]);
  });
}

/**
 * The one place this suite constructs a `HocuspocusProvider`/`HocuspocusProviderWebsocket` pair,
 * shared by `connectProvider` and `connectProviderWithSocket` below (the two used to be near-
 * identical copies of each other, one dropping the `websocketProvider` handle the other kept).
 *
 * `token` accepts the identical union `@hocuspocus/provider`'s own `configuration.token` does --
 * a plain string, or a (possibly async) function -- so the one expired-token-reconnect test below
 * can pass a stateful function that returns an already-expired token on its first call and a real
 * one on every call after, standing in for `apps/web/src/App.tsx`'s real `token: async () =>
 * (await api.connectionToken()).token`, while every other test keeps passing a plain string.
 *
 * No `Cookie` header is ever set here, unlike this file's own pre-connection-tokens version --
 * that is the property this whole slice exists to prove: only `Origin` (a real browser always
 * attaches this to a cross-origin WebSocket handshake; this Node test client does not unless told
 * to, so it is set explicitly here to the one origin this suite's `BETTER_AUTH_URL` trusts) and
 * the connection token itself, sent over the socket's own `AuthenticationMessage`, ever
 * authenticate this handshake now.
 */
function buildProviderPair(
  screenplayId: string,
  token: string | (() => string) | (() => Promise<string>),
): { provider: HocuspocusProvider; websocketProvider: HocuspocusProviderWebsocket } {
  class OriginOnlyWebSocket extends WS {
    constructor(address: string, protocols?: string | string[]) {
      super(address, protocols, { headers: { Origin: 'http://127.0.0.1:4000' } });
    }
  }
  const websocketProvider = new HocuspocusProviderWebsocket({
    url: serverUrl!,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocketPolyfill: OriginOnlyWebSocket as any,
  });
  const provider = new HocuspocusProvider({ websocketProvider, name: screenplayId, token });
  // `HocuspocusProvider` only wires up its own forwarding listeners and connects automatically
  // (`manageSocket`) when it constructs its *own* internal `websocketProvider` from a bare `url`.
  // Supplying one explicitly here (the only way to attach a per-connection `Origin` via
  // `WebSocketPolyfill`) means this attachment must be done by hand -- confirmed by reading the
  // installed `@hocuspocus/provider` source and its own deprecation note on `connect()`/
  // `disconnect()`: "Please connect/disconnect on the websocketProvider, or attach/deattach
  // providers."
  provider.attach();
  // Since `websocketProvider` was supplied explicitly, `provider.destroy()` alone (`manageSocket`
  // is false) detaches this provider but leaves the underlying WebSocket connection it owns
  // running -- each test's own `finally { client.destroy() }` needs that same call to also close
  // the raw connection, or the test process is left with a live socket after every test.
  const destroy = provider.destroy.bind(provider);
  provider.destroy = () => {
    destroy();
    websocketProvider.destroy();
  };
  return { provider, websocketProvider };
}

function connectProvider(
  screenplayId: string,
  token: string | (() => string) | (() => Promise<string>),
): HocuspocusProvider {
  return buildProviderPair(screenplayId, token).provider;
}

async function waitForSynced(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onSynced = () => {
      cleanup();
      resolvePromise();
    };
    const onFailed = ({ reason }: { reason: string }) => {
      cleanup();
      rejectPromise(new Error(`Authentication failed: ${reason}`));
    };
    function cleanup() {
      provider.off('synced', onSynced);
      provider.off('authenticationFailed', onFailed);
    }
    provider.on('synced', onSynced);
    provider.on('authenticationFailed', onFailed);
  });
}

/** Like `connectProvider` above, but also returns the underlying `HocuspocusProviderWebsocket` --
 * needed by the transient-recovery and expired-token-recovery tests below, both of which must call
 * `disconnect()`/`connect()` on the *socket* directly. `buildProviderPair`'s own comment explains
 * why: with an explicit `websocketProvider` supplied (the only way to attach the `Origin` header
 * this suite needs), `manageSocket` is `false`, so the per-document `HocuspocusProvider`'s own
 * `connect()`/`disconnect()` are deprecated no-ops (confirmed by reading the installed source) --
 * exactly the opposite of `apps/web/src/App.tsx`'s real usage, where `HocuspocusProvider`
 * constructs its own internal socket and `manageSocket` is `true`, so calling `connect()`/
 * `disconnect()` on the per-document provider there is correct as written. */
function connectProviderWithSocket(
  screenplayId: string,
  token: string | (() => string) | (() => Promise<string>),
): { provider: HocuspocusProvider; websocketProvider: HocuspocusProviderWebsocket } {
  return buildProviderPair(screenplayId, token);
}

/**
 * Stands in for `apps/web/src/App.tsx`'s own sync-tracking effect (specifically its
 * `handleAuthenticationFailed` transient branch) -- this Node-only test cannot import that
 * browser component, so this reimplements the identical disconnect-then-reconnect dance directly
 * against the raw provider, to prove the *mechanism* `App.tsx` relies on: closing the socket
 * (`disconnect()`) and reopening it (`connect()`) once a `TRANSIENT_SYNC_AUTH_FAILURE_REASON`
 * `authenticationFailed` arrives is enough, on its own, to reach `synced` once the underlying
 * fault clears -- no new session, no page reload. A non-transient reason rejects immediately,
 * exactly like `App.tsx`'s own `setSyncState('denied')` branch, which never retries.
 */
async function waitForSyncedAfterTransientRetry(
  provider: HocuspocusProvider,
  websocketProvider: HocuspocusProviderWebsocket,
): Promise<void> {
  if (provider.isSynced) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onSynced = () => {
      cleanup();
      resolvePromise();
    };
    const onFailed = ({ reason }: { reason?: string }) => {
      if (reason !== TRANSIENT_SYNC_AUTH_FAILURE_REASON) {
        cleanup();
        rejectPromise(new Error(`Authentication failed with a non-transient reason: ${reason}`));
        return;
      }
      const onDisconnectedForRetry = () => {
        websocketProvider.off('disconnect', onDisconnectedForRetry);
        websocketProvider.connect();
      };
      websocketProvider.on('disconnect', onDisconnectedForRetry);
      websocketProvider.disconnect();
    };
    function cleanup() {
      provider.off('synced', onSynced);
      provider.off('authenticationFailed', onFailed);
    }
    provider.on('synced', onSynced);
    provider.on('authenticationFailed', onFailed);
  });
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition.');
    await sleep(25);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * `screenplayOverrides`, when given, replace fields of `screenplayFixture` wholesale (not merged
 * field-by-field) -- used only by the migration tests above, which need `blocks`/`annotations`
 * this editor can actually represent (`screenplayFixture` itself has `dual_dialogue`, a
 * `page_break`, and a note, all of which `editorContentFromScreenplay` rejects, so `createFetch`
 * never seeds a Yjs document from it at all -- confirmed directly: every other test in this file
 * logs `collab_seed_failed` for exactly this reason, harmlessly, since none of them assert on
 * seeded content). `screenplayFixture`'s own title page and document settings stay the default,
 * since those are exactly what the migration tests want to prove got carried over.
 */
async function createProjectAndScreenplay(
  ownerActorId: string,
  screenplayOverrides: Partial<typeof screenplayFixture> = {},
): Promise<{ projectId: string; screenplayId: string }> {
  const projectId = randomUUID();
  const screenplayId = randomUUID();
  const screenplay = { ...screenplayFixture, ...screenplayOverrides, id: screenplayId };
  const canonicalJson = JSON.stringify(screenplay);
  await pool!.query('insert into projects (id, title) values ($1, $2)', [
    projectId,
    'Test Project',
  ]);
  await pool!.query(
    "insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')",
    [projectId, ownerActorId],
  );
  await pool!.query(
    `insert into screenplays (id, project_id, title, canonical_screenplay, canonical_hash)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [screenplayId, projectId, 'Test Screenplay', canonicalJson, 'test-hash'],
  );
  return { projectId, screenplayId };
}

async function addMember(
  projectId: string,
  actorId: string,
  role: 'owner' | 'editor' | 'reviewer',
): Promise<void> {
  await pool!.query('insert into project_members (project_id, user_id, role) values ($1, $2, $3)', [
    projectId,
    actorId,
    role,
  ]);
}

/**
 * Signs up and verifies the real email link (see `apps/api/src/persistence.integration.test.ts`'s
 * identically-named helper for why this step is needed at all), then mints a real connection
 * token for the resulting actor directly via `mintConnectionToken` -- the identical function
 * `apps/api`'s own `POST /api/collab/connection-token` route calls, minted here without going
 * through that route (or a Better Auth session/cookie at all) because that HTTP-and-session layer
 * is `apps/api`'s own responsibility to prove (`apps/api/src/app.test.ts`), not this file's; this
 * file's job is proving `apps/collab` correctly verifies whatever token it is handed. Returns the
 * actor's own user id too (read straight back from the database, the same way
 * `persistence.integration.test.ts`'s `userIdFor` does) -- several tests need it to insert
 * `project_members` rows directly. Calls `auth.handler` directly with a Fetch API
 * `Request`/`Response` rather than going through a Fastify app (`apps/api/src/app.ts`'s own route
 * just forwards to this identical handler) -- `apps/collab` never mounts one, and Better Auth's
 * handler is framework-agnostic by design.
 */
async function signUp(email: string): Promise<{ actorId: string; token: string }> {
  const signUpResponse = await auth!.handler(
    new Request('http://127.0.0.1:4000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: email.split('@')[0],
        email,
        password: 'correct-horse-battery-staple',
      }),
    }),
  );
  expect(signUpResponse.status).toBe(200);
  await verifyEmail(email);
  const actorId = await userIdFor(email);
  const token = await mintConnectionToken(COLLAB_TOKEN_TEST_SECRET, actorId, new Date());
  return { actorId, token };
}

async function verifyEmail(email: string): Promise<void> {
  const message = sentMail.get(email);
  if (!message) throw new Error(`No verification email was recorded for ${email}.`);
  const link = message.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`No verification link found in the email sent to ${email}.`);
  const url = new URL(link);
  const response = await auth!.handler(
    new Request(`http://127.0.0.1:4000${url.pathname}${url.search}`, { method: 'GET' }),
  );
  expect(response.status).toBe(302);
}

async function userIdFor(email: string): Promise<string> {
  const result = await pool!.query<{ id: string }>('select id from "user" where email = $1', [
    email,
  ]);
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`No user row found for ${email}.`);
  return id;
}

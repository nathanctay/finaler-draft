import { randomUUID } from 'node:crypto';
import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createAuth } from '@finaler-draft/auth-server';
import type { MailMessage, MailPort } from '@finaler-draft/auth-server/mail';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import {
  getScreenplayEditorSchema,
  SCREENPLAY_YJS_FRAGMENT,
} from '@finaler-draft/screenplay-editor';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { Pool } from 'pg';
import WS from 'ws';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRANSIENT_SYNC_AUTH_FAILURE_REASON } from '@finaler-draft/config';
import { authenticateConnection } from './authenticate.js';
import { createFetch, createStore } from './database.js';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
  suppressPoolShutdownErrors,
} from './integrationTestDatabase.js';

/**
 * The end-to-end proof this slice's brief asks for, chosen deliberately over a Playwright test:
 * a node-level test driving two real `HocuspocusProvider` clients against a real, running
 * Hocuspocus `Server` (this file's own `apps/collab` code, not a stand-in) and a real, migrated
 * Postgres database is a *more* direct exercise of the exact assertion that matters most --
 * "write rejection at the socket" -- than a browser test would be. A Playwright test would still
 * have to route through this same server to prove anything; it would add a full web build, a
 * running API for session cookies, and two browser contexts on top of the same claim, without
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
  wrapGetActorId: (
    real: (headers: Headers) => Promise<string | null>,
  ) => (headers: Headers) => Promise<string | null> = (real) => real,
): Promise<Server> {
  const realGetActorId = async (headers: Headers) =>
    (await auth!.api.getSession({ headers }))?.user.id ?? null;
  // Defaults to `realGetActorId` unchanged (every existing test calls `startServer()` with no
  // argument) -- the two failure-classification tests below are the only callers that wrap it, to
  // simulate a transient database error during exactly the session lookup without needing to
  // actually break Postgres for this whole shared suite.
  const getActorId = wrapGetActorId(realGetActorId);
  const instance = new Server({
    address: '127.0.0.1',
    extensions: [new Database({ fetch: createFetch(pool!), store: createStore(pool!) })],
    async onAuthenticate(data) {
      const { actorId, readOnly } = await authenticateConnection(
        { queryable: pool!, getActorId, trustedOrigins: trustedOrigins! },
        { documentName: data.documentName, requestHeaders: data.requestHeaders },
      );
      data.connectionConfig.readOnly = readOnly;
      return { actorId };
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

    const clientA = connectProvider(screenplayId, owner.cookie);
    const clientB = connectProvider(screenplayId, editor.cookie);
    try {
      await Promise.all([waitForSynced(clientA), waitForSynced(clientB)]);

      writeLine(clientA, 'A line only client A wrote.');

      await waitForCondition(() => projectedText(clientB).includes('A line only client A wrote.'));
    } finally {
      clientA.destroy();
      clientB.destroy();
    }
  }, 20_000);

  it('a reviewer receives updates but a reviewer edit never reaches the other client -- write rejection at the socket', async () => {
    const owner = await signUp('owner-reviewer-test@example.test');
    const reviewer = await signUp('reviewer-write-test@example.test');
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner.actorId);
    await addMember(projectId, reviewer.actorId, 'reviewer');

    const ownerClient = connectProvider(screenplayId, owner.cookie);
    const reviewerClient = connectProvider(screenplayId, reviewer.cookie);
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

    const ownerClient = connectProvider(screenplayId, owner.cookie);
    const restrictedClient = connectProvider(screenplayId, restrictedEditor.cookie);
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

  it('the document survives a Hocuspocus restart', async () => {
    const owner = await signUp('owner-restart-test@example.test');
    const { screenplayId } = await createProjectAndScreenplay(owner.actorId);

    const client = connectProvider(screenplayId, owner.cookie);
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
      const row = await pool!.query('select 1 from document_yjs_state where screenplay_id = $1', [
        screenplayId,
      ]);
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

    const reconnected = connectProvider(screenplayId, owner.cookie);
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

    // Simulates Postgres being unreachable for exactly the first handshake attempt -- a thrown
    // error from the real `getActorId` dependency `authenticateConnection` calls, run through the
    // real, shipped classification logic in `authenticate.ts`, not a shortcut around it. Recovers
    // on its own after exactly one failure, standing in for a Postgres restart that has already
    // finished by the time this test's own retry (`waitForSyncedAfterTransientRetry` below) fires.
    let failuresRemaining = 1;
    await server!.destroy();
    server = await startServer((real) => async (headers) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('Simulated transient database outage (integration test fault injection)');
      }
      return real(headers);
    });
    serverUrl = server.webSocketURL;

    const { provider, websocketProvider } = connectProviderWithSocket(screenplayId, owner.cookie);
    try {
      await waitForSyncedAfterTransientRetry(provider, websocketProvider);
      expect(provider.isSynced).toBe(true);
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

    const client = connectProvider(screenplayId, stranger.cookie);
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

function connectProvider(screenplayId: string, cookie: string): HocuspocusProvider {
  class CookieWebSocket extends WS {
    constructor(address: string, protocols?: string | string[]) {
      // A real browser always attaches `Origin` to a cross-origin WebSocket handshake; this
      // Node test client does not unless told to, so it is set explicitly here to the one origin
      // this suite's `BETTER_AUTH_URL` trusts -- proving the origin guard passes a legitimate
      // request, not merely that it exists.
      super(address, protocols, {
        headers: { Cookie: cookie, Origin: 'http://127.0.0.1:4000' },
      });
    }
  }
  const websocketProvider = new HocuspocusProviderWebsocket({
    url: serverUrl!,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocketPolyfill: CookieWebSocket as any,
  });
  const provider = new HocuspocusProvider({
    websocketProvider,
    name: screenplayId,
    token: 'unused',
  });
  // `HocuspocusProvider` only wires up its own forwarding listeners and connects automatically
  // (`manageSocket`) when it constructs its *own* internal `websocketProvider` from a bare `url`.
  // Supplying one explicitly here (the only way to attach a per-connection `Cookie`/`Origin` via
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
  return provider;
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
 * needed only by the transient-recovery test, which must call `disconnect()`/`connect()` on the
 * *socket* directly. `connectProvider`'s own comment explains why: with an explicit
 * `websocketProvider` supplied (the only way to attach the Cookie/Origin headers this suite
 * needs), `manageSocket` is `false`, so the per-document `HocuspocusProvider`'s own `connect()`/
 * `disconnect()` are deprecated no-ops (confirmed by reading the installed source) -- exactly the
 * opposite of `apps/web/src/App.tsx`'s real usage, where `HocuspocusProvider` constructs its own
 * internal socket and `manageSocket` is `true`, so calling `connect()`/`disconnect()` on the
 * per-document provider there is correct as written. */
function connectProviderWithSocket(
  screenplayId: string,
  cookie: string,
): { provider: HocuspocusProvider; websocketProvider: HocuspocusProviderWebsocket } {
  class CookieWebSocket extends WS {
    constructor(address: string, protocols?: string | string[]) {
      super(address, protocols, {
        headers: { Cookie: cookie, Origin: 'http://127.0.0.1:4000' },
      });
    }
  }
  const websocketProvider = new HocuspocusProviderWebsocket({
    url: serverUrl!,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocketPolyfill: CookieWebSocket as any,
  });
  const provider = new HocuspocusProvider({
    websocketProvider,
    name: screenplayId,
    token: 'unused',
  });
  provider.attach();
  const destroy = provider.destroy.bind(provider);
  provider.destroy = () => {
    destroy();
    websocketProvider.destroy();
  };
  return { provider, websocketProvider };
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

async function createProjectAndScreenplay(
  ownerActorId: string,
): Promise<{ projectId: string; screenplayId: string }> {
  const projectId = randomUUID();
  const screenplayId = randomUUID();
  const screenplay = { ...screenplayFixture, id: screenplayId };
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
 * Signs up, verifies the real email link (see `apps/api/src/persistence.integration.test.ts`'s
 * identically-named helper for why -- `requireEmailVerification: true` means sign-up alone
 * creates no session), and signs in, returning both a usable session cookie and the actor's own
 * user id (read straight back from the database, the same way that other suite's `userIdFor`
 * does). Calls `auth.handler` directly with a Fetch API `Request`/`Response` rather than going
 * through a Fastify app (`apps/api/src/app.ts`'s own route just forwards to this identical
 * handler) -- `apps/collab` never mounts one, and Better Auth's handler is framework-agnostic by
 * design.
 */
async function signUp(email: string): Promise<{ actorId: string; cookie: string }> {
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
  const cookie = await signIn(email);
  const actorId = await userIdFor(email);
  return { actorId, cookie };
}

async function signIn(email: string): Promise<string> {
  const response = await auth!.handler(
    new Request('http://127.0.0.1:4000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple' }),
    }),
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTypeOf('string');
  return setCookie!.split(';', 1)[0]!;
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

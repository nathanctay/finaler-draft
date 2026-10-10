import { Client } from 'pg';
import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { createAuth } from '@finaler-draft/auth-server';
import { verifyConnectionToken } from '@finaler-draft/collab-token';
import {
  loadRootEnvironment,
  requireCollabPersistenceEnvironment,
  shouldLoadRootEnvironment,
} from './environment.js';
import {
  authenticateConnection,
  ExpiredConnectionTokenError,
  readAuthenticatedConnectionContext,
  TransientAuthenticationError,
  UnknownDocumentEpochError,
} from './authenticate.js';
import { createFetch, createStore } from './database.js';
import { unreachableMailPort } from './mailStub.js';
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
import { createIdleSessionRevisionScheduler, maybeCreateIdleSessionRevision } from './revisions.js';
import {
  startRestoreNotificationListener,
  supersedeRestoredDocuments,
  type NotificationClient,
} from './restoreNotifications.js';
import { encodeCollabRestoredMessage } from '@finaler-draft/config';

try {
  if (shouldLoadRootEnvironment(process.env)) {
    loadRootEnvironment();
  }
  const environment = requireCollabPersistenceEnvironment(process.env);
  // Reused, not recomputed: `createAuth`'s own `trustedOrigins` (the identical
  // `[BETTER_AUTH_URL, CLIENT_ORIGIN?]` allowlist `apps/api`'s origin guard trusts) is the one
  // this WebSocket handshake must agree with byte-for-byte -- see `authenticate.ts`'s own comment
  // on why an unvalidated `Origin` is a hijacking vulnerability here specifically. `auth` itself
  // (Better Auth's own session-verification surface) is deliberately not destructured: this
  // process no longer reads a session cookie at all -- see `verifyToken` below -- and `createAuth`
  // is called only for the `pool`/`trustedOrigins` it builds alongside that surface.
  const { pool, trustedOrigins } = createAuth(environment, { mail: unreachableMailPort });
  // The replacement for the Better Auth session cookie this process used to read directly off the
  // handshake's own headers (`apps/collab/src/authenticate.ts`'s own module comment on why that
  // cookie never reaches this process once `app` and `collab` are on two different hosts). Bound
  // to this process's own `COLLAB_TOKEN_SECRET` here, at the one call site, rather than threaded
  // through as a bare string -- `authenticateConnection` below never sees the secret itself, only
  // this already-bound function, the same shape `getActorId` had before it.
  const verifyToken = (token: string, now: Date) =>
    verifyConnectionToken(environment.COLLAB_TOKEN_SECRET, token, now);

  // Collaboration slice 4a's "meaningful idle session" revision trigger (plan.md; see
  // `revisions.ts`'s own comment for the chosen 10-minute threshold and its reasoning). One
  // scheduler for this whole process, fed by every accepted edit via `onChange` below and torn
  // down in `onDestroy`.
  const idleSessionRevisions = createIdleSessionRevisionScheduler(
    (screenplayId, epoch) => maybeCreateIdleSessionRevision(pool, { screenplayId, epoch }),
    {
      onError: (error, screenplayId) => {
        console.error(
          JSON.stringify({
            event: 'idle_session_revision_failed',
            screenplayId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    },
  );

  // Collaboration slice 5 (plan.md step 4). Declared before the `Server` so `onDestroy` can close it,
  // and assigned immediately after -- the listener's own callback needs `server.hocuspocus.documents`,
  // which does not exist until the `Server` is constructed. See `restoreNotifications.ts` for why this
  // is a dedicated connection rather than a pooled one, and why Postgres `NOTIFY` rather than an HTTP
  // call from `apps/api`.
  let onRestored: (notification: { screenplayId: string; epoch: number }) => void = () => undefined;
  const restoreNotifications = startRestoreNotificationListener({
    connect: async () => {
      const client = new Client({ connectionString: environment.DATABASE_URL });
      await client.connect();
      // Adapted to `NotificationClient` explicitly rather than passed through: that interface exists
      // so the listener's reconnect logic is testable without a database, and an adapter here is what
      // keeps the production path honest about using exactly the four operations it describes.
      const adapted: NotificationClient = {
        close: async () => {
          await client.end();
        },
        listen: async (channel) => {
          // The channel name is a compile-time constant from `@finaler-draft/database`, never
          // user-supplied -- `listen` takes no bind parameters, so a dynamic value here would be
          // string interpolation into SQL.
          await client.query(`listen ${channel}`);
        },
        onFailure: (listener) => {
          client.on('error', listener);
          client.on('end', () => listener(new Error('Notification connection ended')));
        },
        onNotification: (listener) => {
          client.on('notification', (message) => listener(message.payload));
        },
      };
      return adapted;
    },
    onError: (error) => {
      console.error(
        JSON.stringify({
          event: 'collab_restore_listener_failed',
          error: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    },
    onRestored: (notification) => onRestored(notification),
  });

  const server = new Server({
    extensions: [
      new Database({
        fetch: createFetch(pool),
        store: createStore(pool),
      }),
    ],
    // No `debounce`/`maxDebounce` override in development or production: this slice starts at
    // Hocuspocus's own defaults (2s debounce, 10s maxDebounce -- confirmed against the installed
    // package's `defaultConfiguration`), tuned against real use rather than guessed now (the
    // owner: "we might need to play with it a little to find a good timing"). See
    // progress/collaboration-slice-1.md for what those numbers mean concretely and the crash
    // exposure they bound.
    //
    // The one exception is `FINALER_SYSTEM_TEST` mode (the same flag `selectMailPort` already
    // uses for its own test-only branch, `packages/auth-server/src/mail.ts`): `apps/web/e2e/
    // page-rendering-persistence.spec.ts` and `persistence.spec.ts` poll the real, database-backed
    // `GET /api/screenplays/:id` until a debounced save lands (`PERSISTED_POLL_TIMEOUT_MS`,
    // `apps/web/e2e/persistedPollTimeout.ts`) -- proof that persistence itself works, not a check
    // on how long Hocuspocus's own debounce takes. Waiting out a full production-sized 10-second
    // `maxDebounce` on every such poll, across 18 tests under this suite's `workers: 3`
    // parallelism (one shared `apps/collab` process and Postgres pool per run), is exactly what
    // made `10_000ms`-then-`25_000ms` poll budgets intermittently insufficient in practice
    // (confirmed by direct reproduction: three consecutive real runs at `10_000ms` failed 2, 1,
    // and 1 of 18, always at this exact poll; even `25_000ms` still failed once). Shortening the
    // debounce specifically for this harness attacks that budget at its source instead of chasing
    // an ever-larger client-side timeout: it changes nothing this suite actually asserts on (no
    // test depends on the debounce's own duration), and a genuinely broken `store` still never
    // satisfies the poll regardless of how short the debounce is -- verified directly: forcing
    // `store` to a no-op still fails the same tests with this override in place.
    ...(process.env.FINALER_SYSTEM_TEST === 'true' ? { debounce: 300, maxDebounce: 1000 } : {}),
    async onAuthenticate(data) {
      try {
        const { actorId, currentEpoch, epoch, readOnly, screenplayId, staleEpoch } =
          await authenticateConnection(
            { queryable: pool, verifyToken, trustedOrigins },
            {
              documentName: data.documentName,
              requestHeaders: data.requestHeaders,
              token: data.token,
            },
          );
        // Mutates the *same* `connectionConfig` object Hocuspocus later reads to decide the
        // connection's own `readOnly` flag (confirmed by reading the installed
        // `@hocuspocus/server` source: `onAuthenticate`'s payload spreads the pending
        // connection's `connectionConfig` by reference, and that same object drives both the
        // "authenticated" reply and the `Connection` instance itself). This is the assertion
        // that matters most in this slice: from this point on, Hocuspocus's own protocol
        // handling rejects every `syncStep2`/`update` message this connection sends whenever
        // `readOnly` is `true` -- see `authenticate.ts`'s own module comment and
        // `authenticate.integration.test.ts`'s "a reviewer's own edit never reaches..." test,
        // which fails if this line is removed.
        //
        // Since collaboration slice 5 `readOnly` is additionally `true` for every connection whose
        // requested epoch is older than the screenplay's current one, whatever the actor's role --
        // see `authenticate.ts`'s own comment on why that is where plan.md step 4's "the server
        // rejects writes to the old epoch" lands on this path, and why rejecting means
        // quarantine-not-merge rather than refusing the connection.
        data.connectionConfig.readOnly = readOnly;
        // Resolved once per connection, not per awareness update (which can fire as often as
        // every caret move): cached here on the connection's own `context`, which every later
        // hook for this connection -- `beforeHandleAwareness` below included -- receives back
        // unchanged. See `presence.ts`'s own comment on why the server, not the client, is
        // authoritative for a connection's displayed name and colour.
        const presence = await resolvePresenceIdentity(pool, actorId);
        // `screenplayId`/`epoch` are cached on the context for the same reason `presence` is: every
        // later hook for this connection receives the context back unchanged, and re-parsing the
        // document name in each of them would be the same string parsed four times -- with four
        // chances to disagree about what it meant. `currentEpoch`/`staleEpoch` are what the
        // `connected` hook below needs to tell this client its document has been superseded.
        return { actorId, currentEpoch, epoch, presence, readOnly, screenplayId, staleEpoch };
      } catch (error) {
        // Previously silent: Hocuspocus reports only "permission-denied" (or, for a transient
        // failure, the same message tagged with `TransientAuthenticationError`'s own `reason`)
        // to the client, and nothing on this side ever recorded which of `authenticateConnection`'s
        // five rejections actually fired -- three sessions of diagnosing a permanently-hung
        // connection had to guess at the mechanism for exactly that reason. `error.message` is
        // safe to log here specifically because all five rejections are fixed literal strings
        // this module defines (`'Cross-origin connection rejected'`, `'Authentication required'`,
        // `'This document is not visible to this account'`, or `TransientAuthenticationError`'s/
        // `ExpiredConnectionTokenError`'s own fixed messages) -- never interpolated with request
        // data -- unlike `app.ts`'s Stripe webhook route, which logs only an error's `name`
        // because *that* error can carry a raw header/payload. This never logs the cookie, the
        // connection token, or the request headers themselves; `causeName` is deliberately
        // narrowed to the cause's own constructor name for the identical reason the Stripe route
        // stays at `.name` rather than the object.
        //
        // `transient` (for the log line) is true for either class that carries
        // `TRANSIENT_SYNC_AUTH_FAILURE_REASON` -- a genuinely unexpected failure
        // (`TransientAuthenticationError`, which alone carries a `.cause` and a `.stage`) and an
        // ordinary expired token (`ExpiredConnectionTokenError`, which carries neither, since
        // there is no underlying cause to report and no stage the expiry happened at -- it is not
        // a failure of any lookup, it is the token's own clock running out).
        const transientFailure = error instanceof TransientAuthenticationError;
        const expiredToken = error instanceof ExpiredConnectionTokenError;
        const unknownEpoch = error instanceof UnknownDocumentEpochError;
        const cause = transientFailure ? error.cause : undefined;
        console.error(
          JSON.stringify({
            event: 'collab_authenticate_rejected',
            documentName: data.documentName,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            reason: error instanceof Error ? error.message : String(error),
            transient: transientFailure || expiredToken,
            // Not transient and not a permission problem: the client named an epoch this screenplay
            // has never reached (`UnknownDocumentEpochError`). Logged distinctly because the remedy
            // is a reload, and because seeing this in production would mean a client is constructing
            // document names from something other than `GET /api/screenplays/:id`.
            unknownEpoch,
            stage: transientFailure ? error.stage : undefined,
            causeName:
              cause instanceof Error
                ? cause.name
                : cause === undefined
                  ? undefined
                  : 'UnknownCause',
          }),
        );
        throw error;
      }
    },
    // The append-only durable update log (progress/collaboration-offline-durable.md). `onChange`
    // -- not the debounced `onStoreDocument` `Database` extension hook above -- is the correct
    // place to append: reading the installed `@hocuspocus/server` source confirms `onChange`
    // fires once per individual Yjs update, synchronously with `handleDocumentUpdate`, and hands
    // back that update's own raw bytes; `onStoreDocument` only ever sees Hocuspocus's own merged,
    // debounced result of possibly many such updates, which cannot be un-merged back into the
    // individual writes an append-only log exists to preserve. A read-only connection's writes
    // never reach here at all -- Hocuspocus's own low-level `readOnly` check (the same one
    // `progress/collaboration-slice-1.md`'s "write-rejection mechanism" documents) drops them
    // before they are ever applied to `document`, and `onChange` only fires for updates that
    // *were* applied -- so this hook, by construction, only ever logs a write from a connection
    // that was actually allowed to make one.
    async onChange({ document, documentName, update, context }) {
      const connection = readAuthenticatedConnectionContext(context);
      // No context (a server-internal `DirectConnection`; this application never makes one) means
      // there is no connection whose epoch this update belongs to, and appending it under a guessed
      // epoch is exactly the mistake slice 5 exists to prevent. Skipped rather than defaulted.
      if (!connection) return;
      await appendUpdate(pool, {
        // Deliberately the *connection's own* epoch, not the screenplay's current one. These are the
        // same number for every ordinary connection, and differ only for a connection that outlived
        // a restore -- in which case this update belongs to the epoch it was made against, and
        // writing it under the current epoch would be precisely the auto-merge into the restored
        // screenplay that plan.md step 5 forbids. (That update cannot normally reach this hook at
        // all: `supersedeRestoredDocuments` forces such a connection read-only the moment the restore
        // commits, and a read-only connection's updates never get applied, so `onChange` never fires
        // for them. This is the second of the two mechanisms, not the first.)
        screenplayId: connection.screenplayId,
        epoch: connection.epoch,
        update,
        actorId: connection.actorId,
      });
      void document; // reconstruction reads the durable log, not this live object -- see updateLog.ts.
      void documentName; // the (screenplayId, epoch) pair it encodes is already on `context`.
      // Resets this screenplay's idle-session timer -- by construction, `onChange` only ever fires
      // for a write that was actually applied to the live document (see this hook's own comment
      // above on quarantine/`readOnly` connections never reaching here), so this is exactly "real
      // editing activity happened just now," the one signal the idle-session trigger needs.
      idleSessionRevisions.noteActivity(connection.screenplayId, connection.epoch);
    },
    // Quarantine (progress/collaboration-offline-durable.md): the detection and retention half of
    // "accept the data, never grant editing access" for a reconnecting client whose connection
    // `authenticate.ts` resolved as `readOnly` -- a reviewer, or an owner/editor account whose
    // subscription lapsed while it was offline. Runs *before* Hocuspocus's own low-level
    // `readOnly` check (confirmed by reading the installed source: `beforeHandleMessage` fires on
    // the raw wire bytes before `MessageReceiver.apply` ever inspects them), which is what makes
    // it possible to retain exactly the bytes that check is about to silently drop with no trace.
    // Never applies anything to `document` itself -- the live document staying unchanged does not
    // depend on this hook at all; Hocuspocus's own existing drop already guarantees that.
    // Since collaboration slice 5 this hook additionally carries plan.md step 5: a returning offline
    // client whose epoch has been superseded is read-only (`authenticate.ts`), so the work it made
    // while offline arrives here and is retained in `document_yjs_quarantined_updates` tagged with
    // the epoch it was actually written against -- never merged into the restored screenplay, and
    // never appended to the retired epoch's live log either. The writer is told separately (the
    // restore stateless message, `connected` below) and offers their own copy as a recovery
    // screenplay from the browser; this is the server-side half that survives a cleared browser.
    async beforeHandleMessage({ connection, document, update, context }) {
      if (!connection.readOnly) return;
      const payload = extractSyncUpdatePayload(update);
      if (!payload) return;
      if (!updateCarriesNewContent(document, payload)) return;
      const identity = readAuthenticatedConnectionContext(context);
      if (!identity) return;
      await quarantineUpdate(pool, {
        screenplayId: identity.screenplayId,
        epoch: identity.epoch,
        update: payload,
        actorId: identity.actorId,
      });
    },
    /**
     * Tells a client that connected to an already-superseded epoch so, the moment its connection is
     * established. The counterpart to `supersedeRestoredDocuments`, which handles the connections
     * that were *already* open when the restore committed: between them, every connection to a
     * retired epoch is told exactly once, whether it was open at the time or arrived afterwards.
     *
     * `sendStateless` on the one connection rather than `broadcastStateless` on the document: the
     * other connections to this same document have each already been told by whichever of the two
     * paths applied to them, and telling them again on every new arrival would be noise.
     */
    async connected({ connection, context }) {
      const identity = readAuthenticatedConnectionContext(context);
      if (!identity?.staleEpoch) return;
      connection.sendStateless(encodeCollabRestoredMessage(identity.currentEpoch));
    },
    // Presence: the awareness-protocol half of this slice (plan.md's "Cursors and presence are
    // transient and never belong in history" -- see `presence.ts`'s own comment for the full
    // design). Runs *before* Hocuspocus applies an inbound awareness update to the document's
    // shared `Awareness` state and relays it on to every other connected client, so mutating
    // `states` here is what every other browser actually receives -- never merely advisory.
    // `context` is `undefined` for a server-internal awareness write (`DirectConnection`, per the
    // installed types' own comment); this application never makes one, but the guard keeps this
    // hook a no-op rather than a crash if that ever changes.
    async beforeHandleAwareness({ states, context }) {
      const presence = (context as { presence?: ServerPresenceIdentity } | undefined)?.presence;
      if (!presence) {
        states.clear();
        return;
      }
      sanitizeAwarenessStates(states, presence);
    },
    // Closes this process's *own* database pool -- the one `authenticateConnection`'s role/
    // entitlement queries and the `Database` extension's `fetch`/`store` all share, built by
    // `createAuth` above, and
    // entirely outside anything Hocuspocus itself knows about. `onDestroy` is Hocuspocus's own
    // hook for exactly this: `Server.listen()` defaults `stopOnSignals` to `true` (confirmed by
    // reading the installed 4.6.0 source -- `defaultServerConfiguration`), so SIGINT/SIGQUIT/
    // SIGTERM already call `server.destroy()` before `process.exit(0)`, and `destroy()` already
    // closes every open connection and calls `flushPendingStores()` -- so a genuinely in-flight
    // debounced save is not lost on a Railway deploy or a `tsx watch` restart, without this file
    // needing to reimplement any of that. What was missing is this pool: `runDestroy()` never
    // touches it, and it stays open across the signal, matching `apps/api/src/server.ts`'s own
    // `onClose` hook closing its identically-shaped pool for the identical reason. Awaited before
    // `destroy()` resolves (confirmed by reading the installed source: the signal handler awaits
    // `destroy()`, which awaits this hook via `this.hocuspocus.hooks('onDestroy', ...)`, before
    // ever calling `process.exit(0)`), so this always finishes before the process actually exits.
    async onDestroy() {
      idleSessionRevisions.dispose();
      await restoreNotifications.dispose();
      await pool.end();
    },
    port: environment.PORT,
    quiet: environment.NODE_ENV === 'production',
  });

  // Wired after construction for the reason stated above the listener: this closure needs the
  // `Hocuspocus` instance the `Server` owns. A notification that arrives before this assignment (the
  // window is the synchronous gap between the two statements) would find the default no-op -- which
  // is correct rather than a dropped event, because there are no connections to supersede before the
  // server has started listening.
  onRestored = (notification) => {
    const result = supersedeRestoredDocuments(server.hocuspocus.documents.values(), notification);
    console.info(
      JSON.stringify({
        event: 'collab_restore_superseded_documents',
        screenplayId: notification.screenplayId,
        epoch: notification.epoch,
        supersededDocuments: result.supersededDocuments,
        notifiedConnections: result.notifiedConnections,
      }),
    );
  };

  await server.listen();
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'collab_server_start_failed',
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    }),
  );
  process.exitCode = 1;
}

import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { createAuth } from '@finaler-draft/auth-server';
import {
  loadRootEnvironment,
  requireCollabPersistenceEnvironment,
  shouldLoadRootEnvironment,
} from './environment.js';
import { authenticateConnection, TransientAuthenticationError } from './authenticate.js';
import { createFetch, createStore } from './database.js';
import { unreachableMailPort } from './mailStub.js';
import {
  resolvePresenceIdentity,
  sanitizeAwarenessStates,
  type ServerPresenceIdentity,
} from './presence.js';

try {
  if (shouldLoadRootEnvironment(process.env)) {
    loadRootEnvironment();
  }
  const environment = requireCollabPersistenceEnvironment(process.env);
  // Reused, not recomputed: `createAuth`'s own `trustedOrigins` (the identical
  // `[BETTER_AUTH_URL, CLIENT_ORIGIN?]` allowlist `apps/api`'s origin guard trusts) is the one
  // this WebSocket handshake must agree with byte-for-byte -- see `authenticate.ts`'s own comment
  // on why an unvalidated `Origin` is a hijacking vulnerability here specifically.
  const { auth, pool, trustedOrigins } = createAuth(environment, { mail: unreachableMailPort });
  const getActorId = async (headers: Headers) =>
    (await auth.api.getSession({ headers }))?.user.id ?? null;

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
        const { actorId, readOnly } = await authenticateConnection(
          { queryable: pool, getActorId, trustedOrigins },
          { documentName: data.documentName, requestHeaders: data.requestHeaders },
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
        data.connectionConfig.readOnly = readOnly;
        // Resolved once per connection, not per awareness update (which can fire as often as
        // every caret move): cached here on the connection's own `context`, which every later
        // hook for this connection -- `beforeHandleAwareness` below included -- receives back
        // unchanged. See `presence.ts`'s own comment on why the server, not the client, is
        // authoritative for a connection's displayed name and colour.
        const presence = await resolvePresenceIdentity(pool, actorId);
        return { actorId, presence };
      } catch (error) {
        // Previously silent: Hocuspocus reports only "permission-denied" (or, for a transient
        // failure, the same message tagged with `TransientAuthenticationError`'s own `reason`)
        // to the client, and nothing on this side ever recorded which of `authenticateConnection`'s
        // four rejections actually fired -- three sessions of diagnosing a permanently-hung
        // connection had to guess at the mechanism for exactly that reason. `error.message` is
        // safe to log here specifically because all four rejections are fixed literal strings
        // this module defines (`'Cross-origin connection rejected'`, `'Authentication required'`,
        // `'This document is not visible to this account'`, or `TransientAuthenticationError`'s
        // own message) -- never interpolated with request data -- unlike `app.ts`'s Stripe
        // webhook route, which logs only an error's `name` because *that* error can carry a raw
        // header/payload. This never logs the cookie, the session token, or the request headers
        // themselves; `causeName` is deliberately narrowed to the cause's own constructor name
        // for the identical reason the Stripe route stays at `.name` rather than the object.
        const transient = error instanceof TransientAuthenticationError;
        const cause = transient ? error.cause : undefined;
        console.error(
          JSON.stringify({
            event: 'collab_authenticate_rejected',
            documentName: data.documentName,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            reason: error instanceof Error ? error.message : String(error),
            transient,
            stage: transient ? error.stage : undefined,
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
    // Closes this process's *own* database pool -- the one `getActorId`/`authenticateConnection`
    // and the `Database` extension's `fetch`/`store` all share, built by `createAuth` above, and
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
      await pool.end();
    },
    port: environment.PORT,
    quiet: environment.NODE_ENV === 'production',
  });

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

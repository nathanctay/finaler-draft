import {
  defineRailway,
  github,
  image,
  postgres,
  preserve,
  project,
  service,
  volume,
} from 'railway/iac';

export default defineRailway(() => {
  const finalerDraft = github('nathanctay/finaler-draft');

  const Postgres = postgres('Postgres', { region: 'us-west2' });
  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-west2',
    sizeMB: 5000,
  });
  const drizzleGatewayVolume = volume('drizzle-gateway-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'us-west2',
    sizeMB: 5000,
  });
  const DrizzleGateway = service('Drizzle Gateway', {
    source: image('ghcr.io/drizzle-team/gateway:latest'),
    healthcheck: '/health',
    replicas: { 'us-west2': 1 },
    networking: { privateNetworkEndpoint: 'drizzle-gateway' },
    volumeMounts: { '/app': drizzleGatewayVolume },
    env: { MASTERPASS: preserve() },
  });
  // Static site: no adapter, no server. `pnpm --filter @finaler-draft/landing start` runs sirv
  // (a real static file server, apps/landing/package.json) against the build output. It replaces
  // `astro preview`, a Vite dev server whose Host-header allowlist rejected every Railway domain
  // (403 "Blocked request") -- see progress/deploy-config.md.
  const landing = service('landing', {
    source: finalerDraft,
    build: {
      buildCommand: 'pnpm --filter @finaler-draft/landing build',
      buildEnvironment: 'V3',
      builder: 'RAILPACK',
      watchPatterns: ['apps/landing/**'],
    },
    start: 'pnpm --filter @finaler-draft/landing start',
    replicas: { 'us-west2': 1 },
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 3 },
    env: { PUBLIC_APP_ORIGIN: preserve(), PUBLIC_SITE_URL: preserve() },
  });
  const app = service('app', {
    source: finalerDraft,
    build: 'pnpm build',
    start: 'pnpm start',
    healthcheck: '/api/health',
    healthcheckTimeout: 100,
    // Runs in its own container, ahead of the start command, with the same environment variables
    // (including DATABASE_URL). If this command fails, Railway does not proceed to start the new
    // deployment at all -- this is what actually prevents the "missing migration" class of
    // incident the healthcheck's `/api/health` probe can only detect after the fact (it is a
    // `select 1` reachability check, not a schema check). See progress/deploy-config.md.
    preDeploy: 'pnpm --filter @finaler-draft/database db:migrate',
    replicas: { 'us-west2': 1 },
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 3 },
    env: {
      BETTER_AUTH_SECRET: preserve(),
      BETTER_AUTH_URL: preserve(),
      CLIENT_ORIGIN: preserve(),
      // Signs the short-lived, collab-scoped connection token this service mints at
      // `POST /api/collab/connection-token` and `collab` verifies on every WebSocket handshake
      // (progress/collaboration-connection-tokens.md). **The value must be identical in both
      // services.** A mismatch does not crash or warn -- every handshake simply fails as
      // "Authentication required," which looks exactly like the cookie defect this token replaced,
      // so it is the first thing to check if collaboration stops connecting. Deliberately distinct
      // from `BETTER_AUTH_SECRET`: the two credentials protect different things, and sharing one
      // secret would mean a leak of either compromised both.
      COLLAB_TOKEN_SECRET: preserve(),
      DATABASE_URL: preserve(),
      MAIL_FROM_ADDRESS: preserve(),
      NODE_ENV: preserve(),
      PORT: preserve(),
      RESEND_API_KEY: preserve(),
      STRIPE_PRICE_ID_ANNUAL: preserve(),
      STRIPE_PRICE_ID_MONTHLY: preserve(),
      STRIPE_SECRET_KEY: preserve(),
      STRIPE_WEBHOOK_SECRET: preserve(),
      // The collaboration server's `wss://` address, read by `apps/web/src/collabConfig.ts`.
      // Listed here because omitting a variable from this file deletes it on the next
      // `railway config apply` -- and deleting this one does not fail loudly. It is a Vite
      // *build-time* variable inlined into the bundle, and when it is absent `COLLAB_WS_URL` is
      // `undefined`, which makes `App.tsx` fall back to a local, unconnected `Y.Doc`. Since slice 1
      // deleted the whole-document `PUT`, that fallback has no save path at all: the editor would
      // look entirely normal and persist nothing. Any deploy of this service must have this set
      // before `pnpm build` runs, not after.
      VITE_COLLAB_WS_URL: preserve(),
    },
  });
  // Collaboration slice 1 (progress/collaboration-slice-1.md): the Hocuspocus WebSocket server
  // Yjs documents sync through. No `preDeploy` migration step here -- `app`'s own `preDeploy`
  // already runs `db:migrate` against the identical `DATABASE_URL` on every deploy, and this
  // service needs no migration path of its own; running the same migration twice on every deploy
  // would be redundant, not additionally safe. No mail/Stripe env vars either: `apps/collab`
  // never mounts Better Auth's HTTP handler and never sends mail (`mailStub.ts`'s
  // `unreachableMailPort` throws if that ever changes silently) and never talks to Stripe.
  // `healthcheck: '/'` is a real, working endpoint, not a placeholder: `@hocuspocus/server`'s own
  // `requestHandler` answers any plain (non-upgrade) HTTP request with `200 Welcome to
  // Hocuspocus!` by default (confirmed by reading the installed package's compiled source) --
  // there is no dedicated `/health` route to add.
  const collab = service('collab', {
    source: finalerDraft,
    build: 'pnpm build',
    start: 'pnpm --filter @finaler-draft/collab start',
    healthcheck: '/',
    healthcheckTimeout: 100,
    replicas: { 'us-west2': 1 },
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 3 },
    env: {
      BETTER_AUTH_SECRET: preserve(),
      BETTER_AUTH_URL: preserve(),
      CLIENT_ORIGIN: preserve(),
      // The same secret `app` signs connection tokens with -- see that service's own comment on
      // this variable. Required unconditionally here (this service has no unauthenticated path to
      // fall back to), and the values must match exactly.
      COLLAB_TOKEN_SECRET: preserve(),
      DATABASE_URL: preserve(),
      NODE_ENV: preserve(),
      PORT: preserve(),
    },
  });

  return project('finaler draft', {
    resources: [
      DrizzleGateway,
      landing,
      Postgres,
      app,
      collab,
      postgresVolume,
      drizzleGatewayVolume,
    ],
  });
});

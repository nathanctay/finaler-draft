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
      DATABASE_URL: preserve(),
      MAIL_FROM_ADDRESS: preserve(),
      NODE_ENV: preserve(),
      PORT: preserve(),
      RESEND_API_KEY: preserve(),
      STRIPE_PRICE_ID_ANNUAL: preserve(),
      STRIPE_PRICE_ID_MONTHLY: preserve(),
      STRIPE_SECRET_KEY: preserve(),
      STRIPE_WEBHOOK_SECRET: preserve(),
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

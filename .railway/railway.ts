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
    // `restartPolicyType` is deliberately not declared here. Railway's own default already is
    // `ON_FAILURE` (its Restart Policy docs: "The default is On Failure with a maximum of 10
    // restarts"), and Railway does not store a value matching its own default -- so declaring
    // it produced a change this file proposed on every `railway config plan`, forever, that
    // applying never resolved. Permanent phantom drift costs more than the explicitness was
    // worth: a plan that always reports pending changes teaches a reader to skim past plan
    // output, and that output is the only warning before omitting a variable from this file
    // silently deletes it in production. `restartPolicyMaxRetries` stays declared because 3
    // genuinely differs from the default 10, so Railway does store it and it does not drift.
    deploy: { restartPolicyMaxRetries: 3 },
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
    // `restartPolicyType` is deliberately not declared here. Railway's own default already is
    // `ON_FAILURE` (its Restart Policy docs: "The default is On Failure with a maximum of 10
    // restarts"), and Railway does not store a value matching its own default -- so declaring
    // it produced a change this file proposed on every `railway config plan`, forever, that
    // applying never resolved. Permanent phantom drift costs more than the explicitness was
    // worth: a plan that always reports pending changes teaches a reader to skim past plan
    // output, and that output is the only warning before omitting a variable from this file
    // silently deletes it in production. `restartPolicyMaxRetries` stays declared because 3
    // genuinely differs from the default 10, so Railway does store it and it does not drift.
    deploy: { restartPolicyMaxRetries: 3 },
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
      /*
       * The "Send feedback" notification destination (`apps/api/src/feedback.ts`). Declared here
       * for the reason this file's own header warns about: a variable set in the dashboard but
       * absent from this file is **deleted** by the next `railway config apply`, and
       * `requirePersistenceEnvironment` throws on a missing `FEEDBACK_MAIL_TO` in production -- so
       * omitting it here arms a crash-loop that fires on a later, unrelated infrastructure apply,
       * with nothing connecting the two.
       *
       * That is not hypothetical. This variable's absence already cost two failed production
       * deploys and a three-day crash-loop (progress/deploy-visibility.md): the API refused to
       * boot, `/api/health` never answered, and the Railway healthcheck failed six times per
       * deploy with no notification to anyone.
       */
      FEEDBACK_MAIL_TO: preserve(),
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
    // `restartPolicyType` is deliberately not declared here. Railway's own default already is
    // `ON_FAILURE` (its Restart Policy docs: "The default is On Failure with a maximum of 10
    // restarts"), and Railway does not store a value matching its own default -- so declaring
    // it produced a change this file proposed on every `railway config plan`, forever, that
    // applying never resolved. Permanent phantom drift costs more than the explicitness was
    // worth: a plan that always reports pending changes teaches a reader to skim past plan
    // output, and that output is the only warning before omitting a variable from this file
    // silently deletes it in production. `restartPolicyMaxRetries` stays declared because 3
    // genuinely differs from the default 10, so Railway does store it and it does not drift.
    deploy: { restartPolicyMaxRetries: 3 },
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
  // The grace-period account-purge cron (progress/account-purge-cron.md, apps/api/src/
  // accountPurge.ts): hard-deletes an account and its owned, soft-deleted projects once the
  // 30-day grace window has elapsed, plus four smaller hygiene sweeps (expired sessions and
  // verification rows, aged-out Stripe dedupe events, resolved membership invitations). A script
  // in this repository, run by Railway's own cron scheduler -- the owner confirmed this
  // architecture twice, over two rejected alternatives recorded in the progress doc: `pg_cron`
  // (not in Railway's Postgres image, and SQL alone cannot reach Stripe or send mail, which would
  // put irreversible deletion logic outside `pnpm test`, typecheck, PR review, and audit) and
  // `node-cron` (buys cron syntax and nothing else for a once-a-day sweep, adds a dependency while
  // its licence review is an open launch item, and keeps a scheduler inside the web process).
  //
  // **`deploy.cronSchedule` is the field name, confirmed from the installed `railway` package's
  // own types** (`DeployConfig.cronSchedule?: string | null`, `node_modules/railway/dist/
  // index-C3uk0ruc.d.ts`) rather than guessed -- nothing else in this file's `deploy` blocks has
  // needed it before now. `'0 3 * * *'`: once daily is far more resolution than a 30-day window
  // needs, and 03:00 UTC is outside this product's only known usage pattern so far (nothing
  // today demands a more precise anti-peak hour; revisit if that changes).
  //
  // **No `healthcheck`.** Every other service here answers an HTTP probe continuously; this one
  // runs once per trigger and exits (see `accountPurgeCli.ts`'s own module comment for why
  // exiting at all is the one thing Railway's cron contract strictly requires -- "If the code...
  // does not exit, subsequent executions of the Cron will be skipped"). There is nothing for a
  // healthcheck to probe between runs.
  //
  // **No migration step, and the original reasoning for having one did not survive checking.**
  // That reasoning was: this slice's migration adds indexes the purge reads, this service's deploy
  // is not ordered against `app`'s, so it should run the idempotent `db:migrate` itself. Two
  // things are wrong with it. The migration adds *only* indexes (`session_expires_at_index` and
  // three siblings -- `0013_violet_steve_rogers.sql`), and a missing index makes a nightly batch
  // job slower, never incorrect. And giving a 03:00 cron the ability to migrate production races
  // whatever schema `app` believes it is running against, on a schedule nobody watches. `app` owns
  // migrations, for the ordering reason its own declaration states -- see the `start` field below.
  //
  // **Only `DATABASE_URL` and `NODE_ENV`, deliberately** -- see `accountPurgeCli.ts`'s own module
  // comment for why this script does not reuse `@finaler-draft/server-config`'s
  // `requirePersistenceEnvironment` (it would demand Stripe, mail, and collab-token variables this
  // script never touches). No `PORT`: this service never listens on one -- it is a batch job, not
  // a server, and declaring an unused `PORT` here would be exactly the kind of inert-looking
  // variable this file's own header warns a future reader not to "simplify" away without reading
  // why it is there -- except here there is no "why," so it is left out rather than added for
  // symmetry with `app`/`collab`.
  const accountPurge = service('account-purge', {
    source: finalerDraft,
    build: 'pnpm build:packages',
    /*
     * **No `preDeploy` migration here, deliberately.** `app` owns migrations, and the reason is in
     * its own declaration above: `app` deploys before `collab` precisely so the schema is migrated
     * before the other service reading that database restarts against it. One owner, one ordering.
     *
     * Copying that `preDeploy` onto a *cron* service -- which is what this originally did -- gives a
     * nightly job the ability to migrate the production database at 03:00, racing whatever schema
     * `app` currently believes it is running against, on a schedule nobody is watching. It also
     * failed outright on the first real run: the service had no `DATABASE_URL` yet, so
     * `db:migrate` exited 1 with "DATABASE_URL is required for Drizzle commands" before the purge
     * script was ever reached.
     *
     * This job needs no migration of its own. It reads a schema `app` has already migrated, and if
     * it ever runs against a database older than its own expectations the correct outcome is a loud
     * failure, not a 3am schema change.
     */
    start: 'pnpm --filter @finaler-draft/api purge:accounts',
    replicas: { 'us-west2': 1 },
    deploy: {
      cronSchedule: '0 3 * * *',
      // Matches every other service's own comment on this field: Railway's documented default
      // restart policy is already `ON_FAILURE` with 10 retries, and declaring a value matching
      // that default produces permanent phantom drift in `railway config plan`. 3 (not 10) is
      // declared because it genuinely differs from the default, and because a purge run that
      // fails three times in a row from the same transient cause (a dropped connection, say)
      // should surface rather than retry silently until the next scheduled trigger -- the next
      // day's run will pick up the identical backlog either way, since this module's own
      // idempotency guarantees nothing is lost by waiting.
      restartPolicyMaxRetries: 3,
    },
    env: { DATABASE_URL: preserve(), NODE_ENV: preserve() },
  });

  return project('finaler draft', {
    resources: [
      DrizzleGateway,
      landing,
      Postgres,
      app,
      collab,
      accountPurge,
      postgresVolume,
      drizzleGatewayVolume,
    ],
  });
});

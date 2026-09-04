# Deploy configuration

Branch `fix/deploy-config`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/deploy-config`,
off `b36a0d7` (current `main`).

## The incident

Railway project `finaler draft`, environment `production`. Sign-up on `app`
(`app-production-d342.up.railway.app`) failed end to end with `relation "user" does not exist` --
the database Better Auth and the persistence layer both depend on had never been migrated in
production. The healthcheck (`/api/health`, a `select 1` reachability probe) stayed green
throughout, because reachability and schema-readiness are different questions; it detects neither
a missing migration nor, by itself, would it have caught this before a real signer-up did.

The root cause: `railway.toml`'s `preDeployCommand` -- `pnpm --filter @finaler-draft/database
db:migrate` -- was supposed to run the migration between build and start on every deploy. It never
ran. `railway.toml` (Config as Code) is deprecated; Railway's own docs say plainly that **new
services cannot opt into it at all**, and existing Config as Code files stop being read entirely on
**2026-12-01**. Both `app` and `landing` are new services, so the file was inert for both of them
from the day they were created -- not a regression, a config file that had never once taken effect,
sitting in the repo with a comment (`railway.toml`'s own) that predicted this exact failure mode.
The dashboard was hotfixed directly (preDeployCommand and healthcheckPath set by hand on `app`'s
Railway service settings) to restore sign-up; `railway config pull` in the work below pulled that
hotfixed state in, which is why the imported `app` service already carried the right
`preDeployCommand` and `healthcheck` -- the fix here is making that state reviewable, version-
controlled, and reproducible, not re-discovering it.

Separately, `landing` (`landing-production-a4db.up.railway.app`) returned 403 `Blocked request.
This host ("landing-production-a4db.up.railway.app") is not allowed.` on every request. Its start
command ran `astro preview`, Vite's development preview server, which enforces a `Host`-header
allowlist. That allowlist did not include the Railway-generated domain, so every request was
rejected regardless of path.

## 1. Config as Code to Infrastructure as Code

Installed the IaC SDK (`pnpm add -D -w railway`, `railway@3.11.0`) and ran `railway config pull`
against the linked project to import current state into `.railway/railway.ts` -- not hand-written,
per Railway's own warning that in this model **omitting a resource deletes it**; pulling first is
the only safe way to get a complete, accurate starting file. `railway config plan` against the
freshly pulled file showed zero drift (`Your Railway configuration is already up to date`),
confirming the import was faithful before any edits were made.

Two edits followed:

- `landing`'s `start` changed from the `astro preview` command (see below) to `pnpm --filter
@finaler-draft/landing start`.
- Both `app` and `landing` gained an explicit `restartPolicyType: "ON_FAILURE"` in their `deploy`
  block. `railway.toml` set this explicitly; the pulled file only carried `restartPolicyMaxRetries:
3` for both services, meaning the type had never been recorded as an explicit setting anywhere
  Railway could see going forward. Restoring it removes an implicit dependency on whatever Railway's
  platform default happens to be.

`railway.toml` was deleted. `README.md`'s one reference to it was updated to point at
`.railway/railway.ts` and `railway config plan`.

`railway config plan` on the finished file (full output, nothing applied):

```
Railway configuration
Using .railway/railway.ts
Project finaler draft
Environment production
Project ID 5b8e90b2-eb2b-4ac1-bca3-980e3cd309a2

Plan: 0 to add, 2 to change, 0 to destroy
  ~ Update landing deploy.restartPolicyType, deploy.startCommand
    └ deploy.restartPolicyType (null → "ON_FAILURE")
    └ deploy.startCommand ("pnpm --filter @finaler-draft/landing build && pnpm --filter @finaler-draft/landing exec astro preview --host 0.0.0.0 --port $PORT" → "pnpm --filter @finaler-draft/landing start")
  ~ Update app deploy.restartPolicyType
    └ deploy.restartPolicyType (null → "ON_FAILURE")

Next
  • Run railway config apply to apply these changes.
```

Zero resources added or destroyed -- the two services, the two volumes, and Postgres all round-
tripped intact. `railway config apply` was not run; the owner reviews this plan first.

## 2. `landing`: a real static file server

Chose **`sirv-cli`** (a `dependencies` entry in `apps/landing/package.json`, not `devDependencies`
-- it runs at container runtime) over Railway's own zero-config Railpack static-site detection
(Astro + Caddy). Railpack's Node provider does auto-detect an Astro static build and serve it with
Caddy when it can locate `astro.config.js`/`.mjs` and the app's own root -- but that detection
depends on Railpack resolving `apps/landing` as the build root inside this monorepo, which is not
independently verifiable without an actual Railway build (this task is explicitly barred from
`railway up`/`railway config apply`). An explicit dependency we run and curl ourselves, locally,
with the same command that ships to production, is provable; an implicit provider heuristic we
cannot exercise outside Railway's own build container is not. `sirv` is also tiny (8 direct deps,
12 kB unpacked), has no Host-header allowlist of any kind (the entire class of bug this fixes), and
does not SPA-fallback by default -- important because this is a multi-page site (`/`,
`/legal/[slug]`), and a fallback-to-index-on-404 behavior would have quietly broken 404s the way
`astro preview`'s allowlist broke everything else.

`apps/landing/package.json` gained a `start` script: `sirv dist --host 0.0.0.0 --port 4321`. `sirv`
reads `process.env.PORT` ahead of the `--port` flag (verified by reading `sirv-cli`'s own
`index.js`: `opts.port = +(PORT || opts.port)`), so Railway's injected `PORT` always wins over the
`4321` local-dev fallback; `--host 0.0.0.0` is required explicitly because sirv's own default host
is `localhost`, not `0.0.0.0`.

**Verified locally**, not assumed: built `apps/landing` (`astro build`), served the real `dist/`
with `sirv dist --host 0.0.0.0 --port 4321`, then:

```
curl default Host                                          -> 200, real page
curl -H "Host: landing-production-a4db.up.railway.app" ...  -> 200, identical real page
curl /does-not-exist                                        -> 404 (not an index.html fallback)
curl /robots.txt                                             -> 200
```

The second line is the exact request that returned 403 against `astro preview` in production --
same header value, same path, this time 200 with the real rendered page. The third confirms 404s on
this multi-page site behave correctly (no SPA fallback masking them).

`playwright.config.ts`'s `landing` project `webServer` was switched from `astro preview` to `sirv`
too (`pnpm --filter @finaler-draft/landing exec sirv dist --host 127.0.0.1 --port 4322`), so the
browser suite now exercises the same server Railway runs instead of a different one with different
(and, as it turned out, broken) Host-header behavior. Updated the stale comment above it that said
`astro preview` was "the closest equivalent to `pnpm start`" -- it no longer needs to be an
approximation, and the comment claiming `apps/landing is not part of the root build chain` is fixed
by item 3 below, so that line was corrected too.

## 3. `apps/landing` joins the root `pnpm build`

Root `package.json`'s `build` script gained `&& pnpm --filter @finaler-draft/landing build` at the
end. This was not what caused the 403 (the `landing` Railway service already had its own
independent `buildCommand` scoped to `pnpm --filter @finaler-draft/landing build`, confirmed via
`get-service-config` before making any change, and left untouched in `.railway/railway.ts` -- a
narrowly-scoped per-service build command is deliberately kept separate from the root script so a
`web`/`api` build failure can never block a `landing`-only deploy). What this fixes is CI coverage:
root `pnpm build` is what `test:system` (`pnpm build && playwright test`) and CI's own `pnpm build`
step run, and neither previously touched `apps/landing` -- `astro build` was only ever exercised
incidentally, through the Playwright `landing` project's `webServer` command building it as a side
effect. `playwright.config.ts`'s own comment said as much (`apps/landing is not part of the root
build chain`), and that gap is exactly how the landing build sat silently broken once already (a
stray test file left inside Astro's routing directory -- see `progress/landing-page.md`). Now a
broken `astro build` fails CI's build step directly, not several steps later inside a Playwright
`webServer` timeout.

Checked both scripts the task named:

- `check:bundle-budget` does not call root `pnpm build` (it calls `build:packages` +
  `@finaler-draft/web build` directly) -- unaffected, verified by running it (see Gates).
- `test:system` (`pnpm build && playwright test`) now builds `landing` as part of its `pnpm build`
  step, in addition to the `landing` Playwright project's own `webServer` still rebuilding it (a
  pre-existing, harmless redundancy -- the `webServer` command needs `PUBLIC_APP_IS_LIVE=true`,
  a different env than the root build's default, so it cannot simply reuse the root build's
  output). Verified via `test:system:persistence`, which also runs root `pnpm build`.

## 4. `drizzle-kit` and the pre-deploy migration

The pre-deploy command (`pnpm --filter @finaler-draft/database db:migrate`, which spawns
`packages/database/node_modules/drizzle-kit/bin.cjs` directly -- see
`packages/database/scripts/run-drizzle.mjs`) had never actually run in production before today's
incident, so whether `drizzle-kit` -- a `devDependency` -- would even be present at runtime was
untested. Railway's own docs on pre-deploy commands say it "runs in a separate container from your
application" but must have "the dependencies it needs to run installed in the application image" --
i.e. it runs against the already-built image, not a fresh install.

**Determined, not guessed:** Railway builds with Railpack. Railpack's Node provider documentation
(`docs.railway.com/builds/railpack`, cross-checked against the Railpack repo's own
`docs/src/content/docs/languages/node.md`) states devDependency pruning is controlled by
`RAILPACK_PRUNE_DEPS`, described as "Remove development dependencies," and is **opt-in** -- there is
no default-pruning behavior; a project must set that variable explicitly. Checked the live `app`
service's variable list via `get-service-config` (names only, no values needed): `RAILPACK_PRUNE_DEPS`
is not among them, on `app` or on `landing`. So today, `drizzle-kit` would in fact survive into the
built image and the pre-deploy command would work.

That still leaves the migration path standing on an environment default nobody guarantees stays
off -- exactly the kind of implicit assumption that caused today's incident (a config file quietly
not taking effect). Setting `RAILPACK_PRUNE_DEPS=true` for a smaller production image is a plausible
future optimization, and if anyone ever does, every future deploy's migration silently breaks again,
the same way `railway.toml` silently didn't run. Moved `drizzle-kit` from `devDependencies` to
`dependencies` in `packages/database/package.json` so the migration path no longer depends on that
flag staying unset, regardless of what it costs nothing today (drizzle-kit was already installed in
every environment either way) and removes a latent single point of failure for good.

## Gates

```
pnpm lint                    -- exit 0
pnpm format:check            -- exit 0 (after `prettier --write .railway/railway.ts`; the pulled
                                 file was not pre-formatted to this repo's Prettier config)
pnpm typecheck                -- exit 0
pnpm test                     -- exit 1 overall, but only because of one pre-existing failure
                                 unrelated to this branch -- see "A pre-existing gap found, not
                                 fixed" below. apps/web 645/645, apps/api 215 passed + 40 skipped
                                 (matches main), packages/docx 58/58, fdx 45/45, layout 72/72,
                                 pdf 61/61, config/database/screenplay/server-config/xml-escape all
                                 green. apps/landing: 30/31 (1 pre-existing failure, confirmed via
                                 `git stash` against unmodified b36a0d7 -- see below).
pnpm check:bundle-budget      -- exit 0; same three figures as every prior round (111.65 kB entry /
                                 120 kB, 115.58 kB lazy editor / 200 kB, 6.31 kB CSS / 20 kB).
TEST_DATABASE_URL=... pnpm --filter @finaler-draft/api test:integration
                               -- exit 0; 40/40.
TEST_DATABASE_URL=... pnpm test:system:persistence
                               -- exit 0; 18/18. This run's `pnpm build` includes `apps/landing`
                                 (item 3) and succeeded.
```

### A pre-existing gap found, not fixed

`pnpm test` fails one test in `apps/landing`:
`src/pageTests/index.render.test.ts > index page render > marks "Coming soon" and the collaboration
status as pre-launch state, both present together` -- it expects the rendered page to contain
`'Planned'` and `'Real-time collaboration'`. `apps/landing/src/pages/index.astro` never renders a
`StatusSection` component, and no `StatusSection.astro` file exists anywhere in `apps/landing/src`
-- only comments in four other files (`ProductOverview.astro`, `global.css`, `index.astro`, and the
failing test itself) refer to it as if it does. `progress/landing-page.md` describes this component
as shipped and wired up; it is not present in this checkout of `main`.

Confirmed this is not something this branch caused: `git stash`'d every change on this branch back
to a clean `b36a0d7` checkout and re-ran the same test -- identical failure, identical output. The
task brief's stated baseline ("31 landing unit" tests green) does not match what `b36a0d7` actually
runs; the true baseline is 30/31. Left the test and the missing component alone -- recovering a
missing landing-page feature is unrelated to deployment configuration and outside this branch's
scope -- but flagging it here since it means `main`'s test suite is not currently fully green,
independent of anything in this branch.

## What was not done

`railway config apply` was not run, per the task's constraints -- the plan above is for the owner
to review. No live Railway service was touched, redeployed, or restarted.

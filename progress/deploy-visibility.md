# Deploy visibility, and the build version that identified nothing

Two fixes with one cause: **a deploy pipeline that fails silently.** Between 2026-10-27 and
2026-11-09, production went **thirteen days** without a successful deploy across five separate
incidents, and not one of them notified anybody. Each was found by a human going and looking,
usually for an unrelated reason.

## What actually happened, five times

| Commit    | `checks` | `deploy`      | Why nobody heard                                                      |
| --------- | -------- | ------------- | --------------------------------------------------------------------- |
| `bd964b5` | failure  | **skipped**   | Run was red, but "red" never said "production is behind"              |
| `f0681c2` | success  | **cancelled** | Superseded queued deploy. A cancelled run sends no notification       |
| `0a39773` | success  | **cancelled** | Same                                                                  |
| `3476407` | success  | **cancelled** | Same                                                                  |
| `ca14c25` | success  | **cancelled** | Same -- and `checks` had _passed_, so nothing was wrong with the code |
| `c1d6dc3` | failure  | **skipped**   | The flaky durability test (fixed separately)                          |
| `a43f850` | success  | **failure**   | API crash-looped on a missing `FEEDBACK_MAIL_TO`; three days          |

Four of those are _cancellations_, and they are the most instructive: `deploy` sets
`concurrency: { group: deploy-production, cancel-in-progress: false }`, which protects a deploy that
is already **running**. It does nothing for a deploy still **queued** -- that one is superseded by
the next push and cancelled. A cancelled run is not a failed run, so GitHub notifies nobody, and the
run's overall conclusion reads "cancelled", which looks like something a human chose.

## Fix 1: make "production did not ship" a failed run

A new `deploy-outcome` job, `needs: [checks, deploy]`, guarded `if: always() && <push to main>`. It
passes only when `needs.deploy.result == 'success'`, and otherwise fails with an annotation naming
both results.

`always()` is load-bearing: without it the job inherits the skip and says nothing in precisely the
cases worth hearing about. The concurrency group is scoped to the `deploy` job alone, so a superseded
deploy cancels that job while this one still runs and reports.

Verified by executing the job's own shell against all four outcomes this session actually produced:

| `deploy`  | `checks` | exit | behaviour               |
| --------- | -------- | ---- | ----------------------- |
| success   | success  | 0    | silent                  |
| cancelled | success  | 1    | fails the run, notifies |
| skipped   | failure  | 1    | fails the run, notifies |
| failure   | success  | 1    | fails the run, notifies |

**Deliberately not a notification integration** (Slack webhook, email action, a bot-filed issue). A
failed run is already wired to GitHub's own notifications for whoever pushed, needs no new secret,
and -- the property that matters for this particular job -- cannot itself fail silently. If this ever
needs to reach somebody other than the pusher, that is the moment to add a real channel, not before.

## Fix 2: a build version that identifies the build

Help > Send feedback attaches `appVersion` to every report so a report maps back to the code that
produced it. It was implemented as `git rev-parse HEAD` at Vite config time, with a `'dev'` fallback
so a missing git could never fail a build.

The fallback worked. The feature did not. **Railway builds from an uploaded snapshot, not a git
clone** -- its own deploy log reads `fetched snapshot` then `unpacking archive` -- so the build
container has no `.git` directory. The git call failed on every production build and the fallback
took over exactly as designed, which meant the deployed bundle carried:

```
appVersion: "dev"
```

Confirmed by fetching the live chunk from production and grepping it: the commit SHA appears in
**none** of the 26 deployed chunks, and `"dev"` appears in the one carrying the feedback dialog. Every
report from production would have identified itself as an unidentifiable build. The mechanism was
perfect and the thing it existed for was broken -- which is only visible from outside the mechanism.

### How the SHA now travels

`apps/web/resolveBuildVersion.ts`, extracted from `vite.config.ts` specifically so it can be tested,
resolves in this order:

1. `APP_VERSION` in the environment -- an explicit override and the seam the tests drive.
2. `apps/web/build-version.txt`, a **tracked** file whose committed contents are always the sentinel
   `dev`. The deploy workflow overwrites it with `$GITHUB_SHA` immediately before the first
   `railway up`, so the real value reaches Railway as part of the source itself.
3. `git rev-parse HEAD` -- the right answer for a developer's own `pnpm build`.
4. The sentinel.

**Tracked rather than generated-and-gitignored**, deliberately: Railway's CLI docs promise only that
`up` "compresses and uploads the current directory" and say nothing about how it treats ignored
files. A mechanism that silently degrades to the sentinel if that behaviour ever changed is the exact
failure being fixed here, so the value travels in a file that is part of the source by definition.

Rejected alternatives:

- **`RAILWAY_GIT_COMMIT_SHA`.** It exists, but it is a Railway-provided _git_ variable for
  repo-connected services. This project deploys with `railway up` from CI, and the variable is
  absent from the service's rendered environment -- confirmed by listing it.
- **Setting a Railway variable per deploy from CI.** Railway stages variable changes rather than
  applying them, which is the same mechanism that cost two failed deploys in this very episode (see
  below). A deploy step whose correctness depends on a staged patch being applied is the wrong shape.

### Proven, not asserted

The original implementation's claim of git-tolerance was only ever a comment. Both paths are now
executed, with a `git` shim that exits 127 first on `PATH`:

| Scenario                                | Build  | Bundle contains                          |
| --------------------------------------- | ------ | ---------------------------------------- |
| stamped file, no git (the Railway case) | exit 0 | the stamped SHA; `"dev"` in **0** chunks |
| sentinel file, no git (a tarball build) | exit 0 | `"dev"`, and the build still succeeds    |

Mutations, each asserted to match exactly once:

| Mutation                                                         | Test it killed                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Ignore the version file entirely (reverts to the production bug) | "uses the tracked version file when git is unavailable" -- `expected 'dev' to be '1111…'` |
| Treat the sentinel as a real answer                              | "ignores the version file while it still holds its committed sentinel"                    |

The suite also asserts a real value _is_ resolved when one is available, so the four
"returns the sentinel" cases cannot pass against an implementation that ignores its inputs.

## Fix 3: the landmine that would have repeated the whole incident

`FEEDBACK_MAIL_TO` was set in the Railway dashboard to stop the crash-loop. It was **not** declared
in `.railway/railway.ts`, and that file's own header warns why that matters: a variable absent from
it is **deleted** by the next `railway config apply`. Since
`requirePersistenceEnvironment` throws on a missing `FEEDBACK_MAIL_TO` in production, omitting it
armed the identical crash-loop to fire later, on an unrelated infrastructure apply, with nothing
connecting cause to effect.

Now declared as `preserve()`. `config apply` is a manual, reviewed step and nothing in CI runs it, so
this was latent rather than imminent -- but it was one `apply` away from thirteen days becoming more.

### A note on how the variable was set

The first attempt to fix the crash-loop appeared to do nothing. The reason was Railway's staged
changes: the variable was correct, on the correct service, with the correct name, and sitting in a
patch with `status: STAGED` created four seconds after that deploy began. Staged variables do not
reach a running container until the patch is committed. Worth knowing for the next variable: setting
one in the dashboard is two actions, not one.

## Gate results

| Gate                       | Result                                         |
| -------------------------- | ---------------------------------------------- |
| `pnpm lint`                | exit 0                                         |
| `pnpm typecheck`           | exit 0                                         |
| `pnpm test`                | exit 0 -- `apps/web` **1205 tests / 78 files** |
| `pnpm test:integration`    | exit 0 -- 11/11, 106/106, 32/32                |
| `pnpm test:coverage`       | exit 0 -- `resolveBuildVersion.test.ts` 9/9    |
| `pnpm build`               | exit 0                                         |
| `pnpm check:bundle-budget` | exit 0                                         |
| `pnpm test:system`         | exit 0, **109 passed**                         |
| `pnpm format:check`        | exit 0, bare and last                          |

One incidental fix along the way: `apps/web/tsconfig.json`'s `include` was `["src", "vite.config.ts"]`,
so the extracted `resolveBuildVersion.ts` sat outside the project and `tsc` failed with TS6307. Added
it and its test to the include list. Caught because the build exited 1 while still emitting assets --
a reminder to read the exit code and not just look for output.

## Known limitations / things not done

- **The concurrency behaviour itself is unchanged.** Queued deploys can still be superseded; this
  slice makes that loud rather than preventing it. Whether a superseded deploy should instead queue
  (`cancel-in-progress: false` already does that for running deploys) or be re-triggered is a
  separate decision about deploy semantics, not visibility.
- **Notification reaches the pusher only.** That is GitHub's own behaviour for a failed run and is
  sufficient for a single-maintainer project. It is not an on-call channel.
- **`appVersion` is still `'dev'` for any build outside this workflow** -- a local `pnpm build` with
  git present gets a real SHA, but a tarball build gets the sentinel. That is the intended
  degradation, not a gap.

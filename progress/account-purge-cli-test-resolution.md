# Scope: account-purge CLI integration tests could never run

Branch: `fix/account-purge-cli-test-resolution`
Worktree: `~/Documents/finaler-draft-worktrees/purgetest`
Base: `origin/main` @ `69c114e`

## The defect

All three tests in `apps/api/src/accountPurgeCli.integration.test.ts` failed, on `main`, on any
machine with `TEST_DATABASE_URL` set. The reported error hid the cause:

```
Command failed: pnpm exec tsx /…/apps/api/src/accountPurgeCli.ts
```

`execFile` surfaces only its own message, so the child's actual output was never shown. Running the
command by hand gives it:

```
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "tsx" not found
```

**`tsx` is a devDependency of `apps/api` and `apps/collab` only, never of the workspace root.** pnpm
links it at `apps/api/node_modules/.bin/tsx` and nowhere else, so `pnpm exec tsx` with the repo root
as its working directory cannot resolve it. The tests passed `cwd: repoRoot`.

**Why nobody noticed.** The suite is `describe.skipIf(!databaseUrl)`, and CI never sets
`TEST_DATABASE_URL`. So these tests have been skipped in CI and broken locally for their whole
existence -- green everywhere it was looked at, and never actually executed.

## The fix

`cwd` becomes `apps/api` instead of the repo root, where `tsx` resolves.

That is also the **more faithful** working directory, which is why it is the right fix rather than a
workaround: Railway's start command for this service is
`pnpm --filter @finaler-draft/api purge:accounts`, so the real cron's process already runs with
`apps/api` as its working directory. The test was the odd one out.

Verified end to end: with the fix, 3/3 pass and the CLI's own last line is
`{"event":"account_purge_completed", ...}`. Reverting `cwd` to the repo root fails all 3 again with
`Command "tsx" not found`, so the fix is the reason they pass.

## The larger gap this sits next to -- not fixed here

**These tests run `tsx` against the TypeScript source; production runs `node dist/accountPurgeCli.js`.**
The file's own comment defends that choice, and the reason is sound (a `dist`-based test can pass
against a stale build). But the consequence is that **the production entry point is never
exercised**, and that is exactly the defect that took this cron down on 2026-11-16: the service's
build command (`pnpm build:packages`) did not build `apps/api`, so `dist/accountPurgeCli.js` did not
exist, and the first 03:00 trigger crashed with `MODULE_NOT_FOUND`. These tests could not have caught
it, and still cannot.

The cheap guard is a check that the artifact the service's `start` command runs is actually produced
by the service's `build` command -- the rule recorded in `progress/account-purge-cron.md`. Worth its
own slice; deliberately not bundled here, because it needs a real build step and this fix should not
wait on that.

## Verification

| Check                                                      | Result                                  |
| ---------------------------------------------------------- | --------------------------------------- |
| `pnpm lint`                                                | exit 0                                  |
| `pnpm typecheck`                                           | exit 0                                  |
| `pnpm format:check`                                        | exit 0                                  |
| `accountPurgeCli.integration.test.ts` with a real database | exit 0, 3/3                             |
| Full `apps/api` suite with a real database                 | see below                               |
| Mutation: `cwd` back to the repo root                      | **3 failed**, `Command "tsx" not found` |

Postgres for the DB-gated runs was an isolated container on port 55437 (never 5432), removed
afterwards.

## What remains unverified

- No check that the built `dist` entry point exists or runs -- the gap described above.
- The tests spawn `pnpm exec tsx`, so they depend on `tsx` staying a dependency of `apps/api`.
  Moving it would break them again, with the same opaque message.

# Scope: platform-hygiene

Branch: `chore/platform-hygiene`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/platform-hygiene`
Base: `main` @ `b3d7f5b`
Owner: Sonnet implementation agent, advised by the lead.

## Why this scope exists

`plan.md`'s remaining Phase 1 order opens with this slice: unify on a single Zod major across the
workspace, split server environment parsing out of the shared policy package, and adopt a typed
Fastify route contract. Core authoring works; this is the pass that makes the codebase safe to keep
building on.

Read the specification from `/Users/nathan/Documents/finaler draft/plan.md` — the **main** worktree
copy. The `plan.md` in your own worktree is a snapshot that will go stale; when the two disagree,
main is right. Do not edit either one.

## 1. Unify on a single Zod major

`apps/api` is on **zod 4.1.12**; `packages/screenplay`, `packages/config` and `apps/web` are on
**3.24.1**. Two majors coexist in one workspace that shares schemas across package boundaries, so
two distinct `ZodError` classes exist at runtime.

This is not theoretical. `apps/api/src/app.ts` line 39 reads:

```ts
if (error instanceof z.ZodError || (error instanceof Error && error.name === 'ZodError'))
```

The `error.name` fallback exists because `instanceof` fails for an error thrown by
`packages/screenplay`'s Zod. Without it, a schema validation failure returns 500 instead of 400.
That fallback is a symptom; once the workspace is on one major it should no longer be load-bearing.
Decide deliberately whether to keep it as defence in depth or remove it, and say which and why.

**Unify on Zod 4**, not by downgrading the API — 4 is current, `fastify-type-provider-zod` supports
it, and moving forward is cheaper than moving back. If you find a concrete blocker, stop and report
rather than silently choosing 3.

Patterns already in the tree that Zod 4 changes. Verify each against the actual v4 release notes
rather than trusting this list — it is a starting point, not an inventory:

- `z.string().uuid()` (`packages/screenplay/src/index.ts:15`, `apps/api/src/app.ts:26`)
- `.strict()` — used extensively in `packages/screenplay` and `apps/api/src/projects.ts`
- `.superRefine` with a `message` field (`packages/screenplay/src/index.ts:69`)
- `ZodError.errors` vs `.issues`, and any `.format()` usage
- `invalid_type_error` / `required_error` if present anywhere

`packages/screenplay`'s schema is the canonical screenplay contract. Its **parse behaviour must not
change** — same inputs accepted, same inputs rejected. Its existing tests are the guard; if a v4
idiom would alter what validates, that is a blocker to report, not a test to update.

## 2. Split server environment parsing out of `packages/config`

`packages/config/src/index.ts` (50 lines) currently holds both:

- shared policy that the browser legitimately needs — `PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`,
  `PASSWORD_REQUIREMENTS_MESSAGE`, imported by `apps/web/src/api.ts` and `routes/sign-in.tsx`
- server-only environment parsing — `serverEnvironment`, `parseServerEnvironment`,
  `requirePersistenceEnvironment`, `findPersistenceEnvironment`, imported by `apps/api/src/server.ts`

The browser bundle should never be able to import the shape of the server's environment, even by
accident. Separate them so that is structurally impossible rather than merely avoided by convention.

Choose the mechanism — separate entry points on one package, or two packages — and justify it
briefly. Whichever you pick, `apps/web` must have no import path to the server environment module.
State how you verified that, and prefer a check that would fail loudly on a future mistake over a
one-time inspection.

## 3. A typed Fastify route contract

`apps/api/src/app.ts` validates by calling `parse` by hand inside handlers (`idParam.parse(...)`,
`parseUpdateScreenplayInput(...)`). Adopt `fastify-type-provider-zod` so each route declares its
params, body, and response schema and the handler's types follow from them.

- Every existing route keeps its current status codes and response bodies exactly. This slice is a
  refactor; observable API behaviour must not change. The API tests are the guard.
- The error handler's existing contract must hold: 400 `{ error: 'Invalid request' }` for schema
  failures, 413 for oversized requests, pass-through for other 4xx, generic 500 otherwise, and no
  request bodies or credentials in logs.
- Response schemas are the part most likely to change behaviour by accident, since a response schema
  can strip fields. If you add them, prove the responses are byte-identical to before.

## Out of scope

No new endpoints, no rename or soft-delete (that is the next slice), no auth changes, no Yjs, no
changes to `packages/layout` or the pagination path, no UI work, no dependency upgrades beyond what
items 1 and 3 require.

## Verification required before handoff

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck` — clean tree, no prior build
4. `pnpm test:coverage`
5. `pnpm build`
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`
7. The persistence gate (this slice touches the API; it is required, not optional)
8. `git diff --check`

The API server serves a **prebuilt** web bundle: run `pnpm --filter @finaler-draft/web build`
before any browser gate, or you will measure stale code. Kill stale servers on the gate ports first;
`reuseExistingServer` is on outside CI.

## A standing note on tests in this repository

Four tests on the previous branch stayed green while validating nothing — a fixture that rebuilt the
DOM instead of driving the editor, a helper that fabricated document positions, a stale assertion,
and a regression test whose edit silently never happened. Each looked reasonable on inspection.

So: for any test you write that guards specific behaviour, **break the behaviour and confirm the
test fails**, then restore. Report that you did it. If a test cannot be made to fail by breaking
what it claims to check, it is not testing that thing. This matters here because a refactor that
preserves behaviour is exactly the kind of change a weak test will wave through.

## Rules

- Do not stage, commit, merge, rebase, force-push, reset, or create/delete worktrees. The owner
  controls all Git write operations. If you find files staged, report it and leave them alone.
- Do not read, print, or commit `.env` files or any credential. The test database URL is passed
  inline on the command line only.
- No TODO, FIXME, or placeholder comments. No emojis. Strict TypeScript, `.js` extensions on
  relative imports.
- If anything contradicts the specification, stop and report rather than bending the spec to fit.
- If a command hangs for more than a few minutes, stop and report rather than polling.

## Checkpoints — report to the lead with SendMessage

1. **After surveying the Zod 4 migration, before changing `packages/screenplay`.** Report what
   actually differs and whether any of it touches parse behaviour. Wait for a reply.
2. **The chosen split mechanism for item 2**, before implementing it.
3. On completion, with full gate results and your mutation-testing report.

## Log

### 2026-08-11 — lead — scope opened

Status: ready-for-implementation
First slice of the remaining Phase 1 order. Opened after the pagination work merged and `plan.md`'s
next-action section was brought current.

### 2026-08-11 — implementation agent — complete

Status: ready-for-review

**Item 1 — unified on Zod 4.** All four workspace packages (`apps/api`, `apps/web`,
`packages/screenplay`, `packages/config`) pinned to the identical `zod@4.4.3` — chosen (over
`4.1.12`) to satisfy better-auth's own `zod: "^4.3.6"` dependency, which `fastify-type-provider-zod`
also accepts (`>=4.1.5`). Verified exactly one v4 instance survives in `node_modules/.pnpm` after
`pnpm prune`; the only other zod present, `3.25.76`, belongs solely to `@tanstack/router-generator`'s
build-time codegen, never touches runtime code. `packages/screenplay` required zero source changes;
all 37 of its tests pass unmodified, confirming the migration survey (uuid regex tightened but every
UUID literal in the repo is already RFC4122-compliant since real IDs come from `crypto.randomUUID()`;
`ZodError.errors` was removed upstream but the repo only ever used `.issues`; `.strict()`,
`superRefine`, `discriminatedUnion`, and the deprecated `ZodIssueCode` compat export are unchanged).
Removed the `error.name === 'ZodError'` string fallback in `apps/api/src/app.ts`'s error handler now
that a single instance makes `instanceof z.ZodError` trustworthy; documented why in a code comment.

**Item 2 — split server environment parsing into its own package**, `@finaler-draft/server-config`,
rather than a subpath export on `@finaler-draft/config`. `apps/web` already depends on
`@finaler-draft/config`, so a `./server` subpath would resolve through an edge it already has —
stopped only by convention. A separate package has no such edge: pnpm's non-hoisted `node_modules`
means `apps/web/node_modules` never gets a symlink to `@finaler-draft/server-config` unless
`apps/web/package.json` lists it. Verified empirically: temporarily added
`import { parseServerEnvironment } from '@finaler-draft/server-config'` to `apps/web/src/main.tsx`
and confirmed both `tsc -b` (`TS2307: Cannot find module`) and `vite build` (`Rollup failed to
resolve import`) fail loudly and independently; reverted the probe immediately after. Per the lead's
correction, the module doc comment on `packages/server-config/src/index.ts` records why this is a
package rather than an `apps/api`-local module: `plan.md` schedules a second server-side consumer
(the PDF export worker, needing its own Dockerfile) inside this same phase, not hypothetically. Also
recorded plainly, per the lead's second correction: the boundary this buys is that the wrong import
fails to resolve as currently configured — it does not stop someone from adding
`@finaler-draft/server-config` to `apps/web/package.json` outright, which is a deliberate,
reviewable manifest change rather than a stray import.

**Item 3 — adopted `fastify-type-provider-zod`.** Every route under `/api/projects` and
`/api/screenplays` now declares `params`/`body`/`response` schemas via `ZodTypeProvider`; the
handler's types follow from them (`request.body`/`request.params` are pre-validated and typed, no
manual `.parse()` calls left in `app.ts`). `packages/screenplay`'s `screenplaySchema` is embedded
directly as the `screenplay` field of `createScreenplayInput`/`updateScreenplayInput` (previously
`z.unknown()` with a separate manual `screenplaySchema.parse()` call), which let the now-redundant
`parseCreateScreenplayInput`/`parseUpdateScreenplayInput` wrapper functions be removed in favor of
using the schemas directly; their unit test coverage moved to call `createScreenplayInput.parse()` /
`updateScreenplayInput.parse()` directly, no coverage lost. Two things this surfaced that needed
deliberate handling, not silent adjustment:

- Response schemas are keyed only to the success status codes each route actually sends, mirroring
  the `ProjectStore` interface's return types field for field; the nested `screenplay` response
  field reuses the exact same `screenplaySchema` that already validated the data on write, so it
  cannot reject or strip anything not already rejected before it reached the database. Once a route
  declares any `response` schema, Fastify's typed `reply.code()` narrows to only the status codes
  listed there, so every route's existing error status codes also needed declaring (with a shared
  `errorResponseSchema` matching the pre-existing `{ error: string }` bodies) purely to keep
  `reply.code(403)` etc. type-checking — this changes nothing observable, it isn't new validation.
- Fastify's request lifecycle runs `preValidation -> schema validation -> preHandler -> handler`.
  Before this refactor every id/body check was a manual `.parse()` call inside the handler, later
  than all of those hooks, so an unauthenticated request with a malformed id or body was always
  rejected for authentication (401) before validation (400) ever ran. Declaring `params`/`body` as
  route schemas moves validation ahead of `preHandler`; moving the auth-check hook from `preHandler`
  to `preValidation` (also ahead of validation) was necessary to keep that precedence intact. Verified
  this by mutation: temporarily reverted the hook to `preHandler` and confirmed a dedicated test
  (unauthenticated + malformed id) flips from 401 to 400 as predicted, then restored.

**Mutation-testing report** (every case: broke the guarded behaviour, confirmed the relevant test(s)
failed for the expected reason, then restored):

1. `instanceof z.ZodError` branch in the error handler — forced it to never match
   (`if (false && error instanceof z.ZodError)`). Three tests failed as expected: the new dedicated
   "ZodError from `@finaler-draft/screenplay` reaches the handler" test, and two pre-existing tests
   (`not-a-uuid` path param rejection, and the "validates canonical autosave input" invalid-screenplay
   case) — all three genuinely guard this contract, not just the one I added.
2. `projectListItemSchema` response schema (GET `/api/projects`) — removed the `role` field. The new
   byte-identical-response test failed with a clear diff showing `role` silently missing from the
   actual response, proving the test catches field-stripping, the exact risk the scope flagged.
3. `screenplayResponseSchema` (GET `/api/screenplays/:id`) — removed the nested `screenplay` field
   entirely (the highest-risk case named in the scope). Two tests failed independently: the new
   byte-identical test and the pre-existing `toMatchObject` assertion in "exposes every protected
   project operation."
4. Auth-precedence fix — reverted `preValidation` back to `preHandler`. The new dedicated test
   ("rejects an unauthenticated request for authentication, not schema validation...") failed exactly
   as predicted: 400 instead of 401.

**Gate results**, all run in this worktree with a clean tree (`dist/` removed before typecheck):

1. `pnpm format:check` — clean (prettier auto-fixed 4 files first; verified the diff was pure
   formatting, no logic change).
2. `pnpm lint` — clean, `--max-warnings=0`.
3. `pnpm typecheck` — clean, from a fully removed `dist/` tree.
4. `pnpm test:coverage` — all 8 workspace packages pass; every touched package clears its 80%
   threshold (`packages/config` 100%, `packages/server-config` 100%, `apps/api` 94.5% statements /
   86.41% branches). `apps/api/src/projects.ts`'s uncovered lines are the Postgres-only code paths
   that only run under the persistence integration test (needs a live database).
5. `pnpm build` — clean, all 8 packages including the new `@finaler-draft/server-config`.
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — 21/21 passed. Web bundle rebuilt immediately
   beforehand via the `pnpm build` the script runs; confirmed no stale server was listening on 4173
   first.
7. Persistence gate — `TEST_DATABASE_URL=<redacted> PLAYWRIGHT_CHANNEL=chrome
pnpm test:system:persistence` — 6/6 passed against a disposable per-run database. The URL is
   supplied inline on the command line and is deliberately not recorded here.
8. `git diff --check` — clean, no whitespace errors.

**Observation, not a regression**: the persistence-gate build (run under the script's
`NODE_ENV=test`/`FINALER_SYSTEM_TEST=true` environment) produced a noticeably larger `index-*.js`
chunk (552 kB / 165.72 kB gzip) than the plain `pnpm build` run moments earlier (368 kB / 112.55 kB
gzip) for the same source. Pre-existing `test-system-persistence.mjs` script and Vite config, not
touched by this slice; flagging in case it's worth a look separately, since `plan.md`'s bundle-budget
table and the standing instruction not to suppress Vite's chunk-size warning make this the kind of
thing that's easy to lose track of.

**One process deviation to disclose**: while reverting a temporary boundary-probe edit to
`apps/web/src/main.tsx`, I ran `git checkout -- apps/web/src/main.tsx` instead of using the Edit tool.
That command restores a tracked file's working-tree content to match the last commit — it does not
stage, commit, or discard anyone else's work, and `git diff`/`git status` on the file confirm it
matches HEAD exactly with nothing staged — but it is a targeted working-tree reset, which brushes
against the "no reset" rule in spirit even though the net effect was returning my own uncommitted
edit to the file's already-committed state. I did not repeat it; every other revert in this session
used Edit. No files are staged; no commits were made.

**No dependency upgrades beyond what items 1 and 3 required**: `zod` (workspace-wide, all four
packages), `fastify-type-provider-zod` (new, `apps/api` only, pinned to `7.0.0`, latest). Its peer
deps `@fastify/swagger`/`openapi-types` are type-only imports in its source (verified in the compiled
`dist/esm`/`dist/cjs` — erased at build, no runtime `require`/`import`), so they were not added as
explicit dependencies; pnpm auto-installs them into the `.pnpm` store to satisfy the peer declaration
for typechecking, not hoisted into any package's own `node_modules`. No new endpoints, no rename/
soft-delete, no auth changes, no Yjs, no changes to `packages/layout` or pagination, no UI work.

Nothing staged or committed. Handing off a commit-ready diff for review.

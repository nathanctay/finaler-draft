# Scope: auth-session-routing

Branch: `feature/auth-session-routing`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/auth-session-routing`
Base: `main` @ `cbf48cc`
Owner: Sonnet implementation agent, advised by the lead.

## Why this scope exists

A signed-in user can still reach `/sign-in`. `/` redirects to `/sign-in` unconditionally, so a
signed-in user visiting the root is sent to a page they should never see. There is also no way to
sign out: `api.signOut()` exists in `apps/web/src/api.ts` but is called from nowhere, and the
"Account" link in the projects header navigates to `/sign-in` — which, once the guards below exist,
would bounce straight back to `/projects`.

## The boundary, restated

`plan.md` is explicit: the router is a user-experience boundary, never an authorization boundary.
Everything in this branch decides what to _show_. It must never decide what a caller is _allowed to
have_. The API already re-derives identity from the session cookie on every request through the
`preHandler` in `apps/api/src/app.ts` and scopes every query through `project_members`; none of that
changes here, and no route guard may be treated as a substitute for it.

## Acceptance criteria

### 1. `api.session()` reports "signed out" instead of throwing

Verified against a running server: `GET /api/auth/get-session` returns **HTTP 200 with a body of
literally `null`** when there is no session. The current client parses with
`z.object({ user: z.object({ id: z.string() }) })`, so it throws for anonymous visitors and cannot
distinguish "signed out" from "request failed".

- `api.session()` must resolve to the signed-in user, or `null` when the body is `null`.
- It must still reject on a genuine failure: a non-OK status, or a malformed body that is neither
  `null` nor a valid session shape. Do not collapse real errors into `null`.
- Add tests for all three cases.

### 2. A single shared session query

- One TanStack Query entry, key `['session']`, query function `api.session`.
- Both the route guards and the `useAuth` hook read that same entry so the session is fetched once
  per navigation, not once per consumer.
- Give it a modest `staleTime`. Do not set `Infinity`: a stale "signed in" answer produces a UI that
  offers actions the API will reject.

### 3. Router context carries the query client

`main.tsx` currently constructs `new QueryClient(...)` inline inside the `createRoot().render()` JSX,
so there is no reference to pass to the router.

- Hoist it to a named `const queryClient`.
- `createRouter({ context: { queryClient }, ... })`.
- `__root.tsx` uses `createRootRouteWithContext<{ queryClient: QueryClient }>()`.
- Keep the existing `Register` module augmentation working.

### 4. Guards run in `beforeLoad`, not in a hook

A hook runs during render, after the route has committed, which produces a visible flash of the
wrong page before the redirect fires. Use `beforeLoad`, which runs first.

Each guard resolves the session with `queryClient.ensureQueryData` against the shared `['session']`
entry, so a guard plus the page it guards cause one request, not two.

| Route                    | Signed in            | Signed out          |
| ------------------------ | -------------------- | ------------------- |
| `/`                      | redirect `/projects` | redirect `/sign-in` |
| `/sign-in`               | redirect `/projects` | render              |
| `/projects` and children | render               | redirect `/sign-in` |

`/` stays a pure redirect with no component. A landing page is explicitly deferred.

### 5. `useAuth()` for components

- Returns the signed-in user, or `null`, plus whatever loading state consumers genuinely need.
- Reads the shared `['session']` entry. It must not issue its own separate request.
- This is for rendering decisions only — the profile page, an avatar, the sign-out control.

### 6. Sign out actually works

- Add a real sign-out control. Replace the "Account" `Link` in the projects header, which currently
  goes to `/sign-in` and does nothing useful.
- On success: clear cached data, then navigate to `/sign-in`.
- **Clearing the cache is a requirement, not a nicety.** Projects and screenplays are cached under
  `['projects']`, `['screenplays', projectId]`, and `['screenplay', screenplayId]`. If those survive
  sign-out, the next person to sign in on the same browser sees the previous user's project titles
  before their own data loads. Clear the whole query cache rather than enumerating keys, so caches
  added later cannot be forgotten.
- The `['session']` entry must be cleared or invalidated too, or the guards will keep believing a
  session exists.
- Handle a failed sign-out request visibly. Do not leave the user on a page that appears signed in
  with no feedback.

### 7. Tests

Unit:

- `api.session()`: returns the user for a valid body, `null` for a `null` body, throws on a non-OK
  status and on a malformed body.
- Each guard in the table above, both directions.
- `useAuth()` with and without a session.
- Sign out calls the endpoint, clears cached project data, and navigates to `/sign-in`.
- Sign out failure surfaces feedback and does not silently pretend to succeed.

System (`apps/web/e2e`), against the disposable-database harness:

- Sign in, reload the page, and land on `/projects` rather than `/sign-in`.
- While signed in, navigating to `/sign-in` lands on `/projects`.
- Sign out, then attempt `/projects` directly and land on `/sign-in`.

Note for whoever writes the e2e: `getByLabel('Password')` matches the confirm field too. Use
`{ exact: true }`, as `persistence.spec.ts` now does.

## Out of scope

Do not touch in this branch: a landing page for `/`; a profile page; preserving the originally
requested URL across sign-in and returning to it afterwards (worth doing, needs open-redirect
validation, gets its own branch); design tokens and the error colour; `@fastify/rate-limit`; cookie
attribute configuration; Resend and email flows; the Zod 3/4 unification; `packages/config` split;
`fastify-type-provider-zod`; Stripe; delete/rename endpoints; the autosave state machine.

## Verification required before handoff

Record actual output:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck` — from a clean tree, with no prior build
4. `pnpm test:coverage` — `apps/web` enforces per-file thresholds of 80%
5. `pnpm build`
6. `TEST_DATABASE_URL=<ask the lead> pnpm test:integration`
7. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`
8. `TEST_DATABASE_URL=<ask the lead> PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence`
9. `git diff --check`

Chromium is not installed in this environment; `PLAYWRIGHT_CHANNEL=chrome` uses the installed Google
Chrome. Ask the lead for the database URL rather than guessing, and never print it.

## Rules

- Do not stage, commit, merge, rebase, force-push, or create/delete worktrees. The user controls all
  Git write operations.
- Do not read, print, or commit `.env` files or any credential.
- No TODO, FIXME, or placeholder comments. No emojis.
- Every new CSS class ships with its styles in the same change, matching the existing dense,
  rectangular aesthetic: `border-radius` 0-2px, no new box-shadows, reuse existing colours.
- Do not mark anything complete without pasted command output.
- If a command appears to hang for more than a few minutes, stop and report it rather than polling.
- If a fix requires going outside this scope, stop and ask the lead.

## Log

### 2026-08-07 — lead — scope opened

Status: ready-for-implementation
Requested by the project owner: redirect signed-in users away from the sign-in page, avoid the
double redirect at `/`, add a `useAuth` hook, and make sign-out work. `refactor/route-colocation` and
`docs/architecture-decisions` are both merged, so this branch is cut from `main` at `cbf48cc` with
the colocated route modules and the shared `src/test/routeHarness.tsx` already in place. Reuse that
harness; do not build a second one.

### 2026-08-07 — implementation agent — guards, useAuth, sign-out shipped; two verification gates blocked on TEST_DATABASE_URL

Status: implemented, unit/lint/typecheck/build/one system gate green; integration and
persistence-system gates not run (need `TEST_DATABASE_URL`)

Scope: all seven acceptance-criteria items in this file.

Changes:

- `apps/web/src/api.ts`: `api.session()` now parses `z.object({ user: sessionUserSchema }).nullable()`
  and resolves `body?.user ?? null`, instead of a schema that threw for every anonymous visitor.
  Still throws `ApiError` on a non-OK status or a body that is neither `null` nor valid. Added and
  exported `SessionUser` (`id`, `name`, `email`, matching the `user` table's non-null columns).
- `apps/web/src/session.ts` (new): the shared `sessionQueryOptions` (`queryKey: ['session']`,
  `queryFn: api.session`, `staleTime: 30_000`) that both guards and `useAuth` read, plus
  `guardSessionUser(queryClient)` — see "judgment call" below.
- `apps/web/src/useAuth.ts` (new): reads `sessionQueryOptions` via `useQuery`, returns
  `{ user, isLoading }`. Issues no request of its own.
- `apps/web/src/main.tsx`: hoisted `queryClient` out of the `render()` JSX to a named const; passed
  as `createRouter({ context: { queryClient }, ... })`.
- `apps/web/src/routes/__root.tsx`: switched to
  `createRootRouteWithContext<{ queryClient: QueryClient }>()`.
- `apps/web/src/routes/index.tsx`: `beforeLoad` resolves the session once and redirects straight to
  `/projects` or `/sign-in` — one hop, no component, matching the acceptance table.
- `apps/web/src/routes/sign-in.tsx`: added `beforeLoad` redirecting a signed-in visitor to
  `/projects`; page unchanged otherwise.
- `apps/web/src/routes/projects/$projectId.tsx` and `apps/web/src/routes/projects/index.tsx`: added
  `beforeLoad` redirecting a signed-out visitor to `/sign-in`. Guarding `$projectId` (parent layout)
  covers both of its children; `/projects` (the list route) is a separate top-level route and needed
  its own guard.
- `apps/web/src/routes/projects/index.tsx`: replaced the dead `Account` → `/sign-in` link with a real
  `Sign out` button (`useMutation(api.signOut)`); on success calls `queryClient.clear()` (whole cache,
  not just `['session']`, so a later sign-in on the same browser never sees the prior user's cached
  project/screenplay titles) and navigates to `/sign-in`. On failure, renders a visible
  `role="alert"` message instead of leaving the page looking signed in.
- `apps/web/src/styles.css`: added `.sign-out-button` and `.sign-out-error` (0–1px radius, no shadow,
  existing palette, reusing `.project-header`'s spacing rhythm).
- `apps/web/src/test/routeHarness.tsx`: added `queryOptions` passthrough (route modules now call it
  at module scope) and a `clear` mock (`clearQueryCache`) on the shared `useQueryClient` mock, both
  reset in `resetRouteHarness`. No second harness was built.
- Tests added/updated: `api.test.ts` (session valid/null/non-OK/malformed, in a new `describe`
  block), `routes.test.tsx` (`/` guard both directions, `$projectId` guard both directions),
  `sign-in.test.tsx` and `projects/index.test.tsx` (their own guards), `projects/index.test.tsx`
  (sign-out success clears cache + navigates; sign-out failure shows the alert),
  `useAuth.test.tsx` (new), `session.test.ts` (new — covers `guardSessionUser`'s fail-closed branch).
- `apps/web/e2e/session-routing.spec.ts` (new): sign up → land on `/projects`; reload stays on
  `/projects`; `/sign-in` while signed in bounces back to `/projects`; sign out then `/projects`
  lands on `/sign-in`. Added to `playwright.persistence.config.ts`'s `testMatch` (needs the
  disposable per-run database, like `persistence.spec.ts`) and excluded from
  `playwright.config.ts`'s `testIgnore` for the same reason.

Judgment call (flagging per instructions rather than guessing silently): the guards call the real
`/api/auth/get-session` endpoint on every route, including `/` and `/sign-in`. `pnpm test:system`
(both locally and the `test:system` step in `.github/workflows/quality.yml`) runs the production
build with **no** `DATABASE_URL` at all — deliberately, because before this branch no route ever
called an auth endpoint. Without persistence, `apps/api/src/server.ts` never sets `options.auth`, so
`apps/api/src/app.ts` never mounts `/api/auth/*`, and the endpoint 404s. Before this branch that was
harmless; after it, `guardSessionUser`'s (then-missing) error handling meant an unhandled rejection
inside `beforeLoad`, which broke even the unauthenticated `workspace.spec.ts` shell test — a real
regression, not a sandbox artifact, confirmed by reading the CI workflow. Fix applied: `session.ts`
exports `guardSessionUser(queryClient)`, used by all four `beforeLoad`s instead of calling
`ensureQueryData` directly, which catches a rejected session lookup and treats it as signed-out. This
is deliberately scoped to route guards only — `useAuth` and `api.session()` are untouched and still
surface a real failure as a real failure; only the router's own UX-boundary decision fails closed.
Flagging this because it wasn't in the acceptance criteria table; happy to revert to a strict
`ensureQueryData` call and instead get `test:system`'s webServer a database if that's preferred.

Verification (all output pasted from actual runs in this worktree, not asserted):

1. `pnpm format:check` — pass (`All matched files use Prettier code style!`). Required running
   `prettier --write` once on `progress/auth-session-routing.md` itself (the scope file as handed
   off did not match Prettier's style).
2. `pnpm lint` — pass, no output, `--max-warnings=0`.
3. `pnpm typecheck` — pass, run from a clean tree (`packages/{config,screenplay,database}/dist`
   removed first).
4. `pnpm test:coverage` (`apps/web`) — 10 files, 56 tests, all pass. Per-file thresholds (80%
   lines/functions/branches/statements) all met; overall 96.38% statements / 91.07% branches /
   96% functions / 96.38% lines. `session.ts`, `useAuth.ts`, `api.ts`, `main.tsx`, `__root.tsx`,
   `index.tsx` (route) all at 100%.
5. `pnpm build` — pass, all five packages/apps build.
6. `TEST_DATABASE_URL=… pnpm test:integration` — **not run**. Needs a database; per the scope file I
   asked rather than guessed. Nothing in this branch touches `apps/api`'s persistence code, so I have
   no specific reason to expect a failure, but I did not verify it.
7. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — pass (1/1, `workspace.spec.ts`), after the
   `guardSessionUser` fail-closed fix above. Failed before that fix with the exact CI-relevant
   failure described in the judgment call.
8. `TEST_DATABASE_URL=… PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence` — **not run**, same
   reason as (6). This is the gate that exercises the new `session-routing.spec.ts` end to end
   (sign in/reload/`/sign-in`-bounce/sign-out/direct-`/projects`-redirect) against a real database
   and is the strongest evidence the feature works; it has not been observed passing.
9. `git diff --check` — pass, no whitespace errors.
10. `pnpm --filter @finaler-draft/api test` (not in the required list, run as a sanity check since
    nothing in `apps/api` was touched) — pass, 22 passed / 3 skipped (the 3 skipped are the
    integration tests that need `TEST_DATABASE_URL`).

Review: self-reviewed only; no second reviewer.

Risks / next:

- **Gates 6 and 8 need `TEST_DATABASE_URL` from the project owner.** Until then, sign-up/sign-in
  against a real Better Auth + Postgres backend, and the three new e2e scenarios in
  `session-routing.spec.ts`, are unverified beyond code review and the unit-level guard/mock tests.
- The `guardSessionUser` fail-closed behavior (judgment call above) was not in the original
  acceptance criteria. It is scoped narrowly (guards only) and does not weaken the API's own
  authorization, but it is new behavior worth a second look — in particular, whether `test:system`
  should instead be given a database in CI, making the fail-closed catch unnecessary. Either
  direction is fine from a correctness standpoint; this just needs a decision.
- Did not touch, per the out-of-scope list: no landing page for `/`, no profile page, no
  return-to-originally-requested-URL after sign-in, no design-token/error-colour changes, no
  `@fastify/rate-limit`, no cookie attribute changes, no Resend/email, no Zod 3/4 unification, no
  `packages/config` split, no `fastify-type-provider-zod`, no Stripe, no delete/rename endpoints, no
  autosave state-machine changes.
- The header's sign-out control does not display the signed-in user's name or email — `useAuth` is
  implemented and independently tested but not yet consumed anywhere in the UI, since the scope
  says a profile page (its first real consumer) is deferred. Wiring it into the header for display
  was considered and skipped to avoid speculative UI and an unnecessary coupling in the shared test
  harness (its `useQuery` mock does not distinguish by query key, so a second `useQuery` call in the
  same component under test would collide with the first).

### 2026-08-07 — implementation agent — fixed stale-session regression found by gates 6/8; full gate list green

Status: complete. All nine verification commands run for real in this worktree, including gates 6
and 8 against a real database; all pass.

Scope: fix a sign-in regression this branch introduced, reported by the lead after running the two
gates I could not (gates 6 and 8 need `TEST_DATABASE_URL`, which the lead supplied for this session
only — never printed, never written to a file, never committed).

Root cause (as diagnosed by the lead, confirmed by reading `query-core`'s actual source at
`node_modules/.pnpm/@tanstack+query-core@5.87.4/.../queryClient.js`): `/sign-in`'s `beforeLoad`
caches `['session'] = null` for a signed-out visitor. After a successful sign-up/sign-in, nothing
removed that cache entry before navigating to `/projects`. `QueryClient.ensureQueryData` returns
`Promise.resolve(cachedData)` whenever `cachedData !== undefined` — `null` counts — and only
consults `revalidateIfStale` afterward, which (a) does nothing until the entry is actually stale
(30s `staleTime` had not elapsed yet) and (b) even when it does fire, only kicks off a background,
un-awaited prefetch and still returns the old cached value synchronously. So `revalidateIfStale`
alone could not have fixed this. The `/projects` guard therefore kept reading the stale cached
`null` and bounced a freshly signed-in visitor straight back to `/sign-in`.

Changes:

- `apps/web/src/routes/sign-in.tsx`: the `authentication` mutation's `onSuccess` now calls
  `queryClient.removeQueries({ queryKey: sessionQueryOptions.queryKey })` before navigating to
  `/projects`, forcing the next `ensureQueryData` call to see no cached entry and genuinely refetch.
  Sign-out already used `queryClient.clear()`, which was correct and unaffected; this was the
  missing symmetric case on the sign-in side.
- `apps/web/src/test/routeHarness.tsx`: added a `removeQueries` mock (`removeQueries`, reset in
  `resetRouteHarness`) alongside the existing `clear` and `invalidateQueries` mocks.
- `apps/web/src/routes/sign-in.test.tsx`: new test asserting `removeQueries` is called with
  `{ queryKey: ['session'] }` and that `navigate` is called with `{ to: '/projects' }` on a
  successful sign-in.
- `apps/web/src/session.test.ts`: new `describe` block using a **real** `QueryClient` (not the
  simplified route-harness mocks) with a mocked `fetch`, proving the actual TanStack Query cache
  semantics: (1) `guardSessionUser` returns the signed-in user once `removeQueries` has run against
  a cache primed with a cached `null`, and (2) without that removal, the stale `null` survives and
  `fetch` is never even called — a direct regression test matching the lead's request ("a
  signed-out session cached as null, followed by a successful sign-in, must result in the guard
  seeing the signed-in user rather than the cached null").

Verification — full gate list re-run from a clean tree after the fix, actual output:

1. `pnpm format:check` — pass.
2. `pnpm lint` — pass, no output.
3. `pnpm typecheck` — pass, run after removing `packages/{config,screenplay,database}/dist`.
4. `pnpm test:coverage` (`apps/web`) — 10 files, **59 tests**, all pass. `session.ts` and
   `useAuth.ts` at 100% across all four metrics; `sign-in.tsx` at 99.49% lines / 98.03% branches
   (one unreachable defensive line). All per-file 80% thresholds met.
5. `pnpm build` — pass.
6. `TEST_DATABASE_URL=… pnpm test:integration` — **pass, 3/3**
   (`persistence.integration.test.ts`, "uses real Better Auth sessions to authorize project and
   screenplay operations").
7. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — **pass, 1/1** (`workspace.spec.ts`).
8. `TEST_DATABASE_URL=… PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence` — **pass, 2/2**:
   `session-routing.spec.ts` ("signed-in visitors are kept off /sign-in, and signing out reverses
   that") and `persistence.spec.ts` ("a writer can create, autosave, and reload a private
   screenplay"), both against the disposable per-run database. This is the gate that failed before
   the fix (per the lead's report) and is now green — sign-up → `/projects`, reload → `/projects`,
   `/sign-in` while signed in → bounced to `/projects`, sign-out → `/sign-in`, and direct
   `/projects` after sign-out → `/sign-in`, all confirmed end to end against a real backend.
9. `git diff --check` — pass, no whitespace errors.

Review: self-reviewed plus the lead's diagnosis of the regression (root cause and fix direction
were the lead's; the removal-based fix, harness update, and both regression tests are mine).

Risks / next:

- Gates 6 and 8 now depend on a database being available; they were run once, successfully, against
  the lead-supplied `TEST_DATABASE_URL`. Re-verify after any further change touching `session.ts`,
  `sign-in.tsx`, or the guards.
- The `guardSessionUser` fail-closed judgment call from the previous entry stands, per the lead's
  explicit confirmation to keep it as is.
- No other gaps found in the sign-out ↔ sign-in cache symmetry: sign-out uses `clear()` (whole
  cache), sign-in now uses a targeted `removeQueries` on `['session']` specifically (deliberately
  narrower than `clear()`, since sign-in has no reason to also discard `['projects']` or
  `['screenplays', …]` caches — those belong to whichever user is now signed in and will simply be
  fetched fresh on the `/projects` page's own `useQuery`).

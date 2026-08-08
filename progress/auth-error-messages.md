# Scope: auth-error-messages

Branch: `fix/auth-error-messages`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/auth-error-messages`
Base: `main` @ `0ecdc42`
Owner: Sonnet implementation agent, advised by the lead.

## Why this scope exists

Every authentication failure renders the same sentence, regardless of cause:

```tsx
{
  authentication.isError && (
    <p role="alert">We could not complete that request. Check your details and try again.</p>
  );
}
```

That tells a user nothing. It does not distinguish a wrong password from an email already
registered, and it gives no signal whether the fault is theirs or ours.

The mapping to fix it **already exists and is simply ignored**. `apps/web/src/api.ts` defines
`authErrorMessages` covering seven codes and throws `AuthApiError` carrying a `safeMessage`.
`AuthApiError` is constructed there and asserted in `api.test.ts`, but **no component consumes it**.

The server is not at fault. Probed against a live server and database on `main` at `0ecdc42`:

| Case               | HTTP | Code returned                           |
| ------------------ | ---- | --------------------------------------- |
| Fresh sign-up      | 200  | —                                       |
| Duplicate email    | 422  | `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` |
| Wrong password     | 401  | `INVALID_EMAIL_OR_PASSWORD`             |
| Unknown email      | 401  | `INVALID_EMAIL_OR_PASSWORD`             |
| Password too short | 400  | `PASSWORD_TOO_SHORT`                    |

The codes arrive intact. Do not change anything in `apps/api`.

## Acceptance criteria

### 1. Show the specific message when there is one

- When the mutation fails with an `AuthApiError`, render its `safeMessage`.
- Keep the existing generic sentence as the fallback for everything else: a network failure, a 5xx,
  or an authentication code not in the map. A user must never see a raw server message or a code.
- The alert keeps `role="alert"`.

### 2. Wrong password and unknown email must stay indistinguishable

Better Auth deliberately returns the same `INVALID_EMAIL_OR_PASSWORD` for both, and the existing
message, "Invalid email or password.", is correct. **Do not try to separate them.** Telling a visitor
that an email is not registered hands an attacker a way to enumerate accounts. This is not a gap to
close; it is the intended behaviour.

### 3. The error clears when the visitor switches mode

`switchMode()` currently resets the confirm-password state but leaves the mutation in its error
state, so an error raised while signing in persists after switching to registration, where it is
misleading. Reset the mutation as part of the switch.

### 4. The mode-level alert gets the styling the other errors already have

The alert on line 230 has **no class**, while the confirm-password error uses `.field-error`. Reuse
`.field-error`.

**Do not add any new CSS class and do not modify `apps/web/src/styles.css`.** A `chore/design-tokens`
branch is rewriting that file in parallel; touching it here creates a conflict for no benefit.

### 5. Remove the duplicated password rule

`authErrorMessages` hardcodes `'Password must be at least 12 characters.'` and
`'Password is too long.'`, restating a rule that `PASSWORD_REQUIREMENTS_MESSAGE` in
`@finaler-draft/config` already derives from `PASSWORD_MIN_LENGTH` and `PASSWORD_MAX_LENGTH`. If the
policy changes, these strings silently lie. Point `PASSWORD_TOO_SHORT` and `PASSWORD_TOO_LONG` at the
shared constant. `apps/web` already depends on that package.

### 6. Tests

Add tests that fail before the change and pass after:

- A failed sign-in with `INVALID_EMAIL_OR_PASSWORD` renders "Invalid email or password", not the
  generic sentence.
- A failed sign-up with `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` renders the account-exists message.
- A non-authentication failure — a 500, or a body with an unrecognised code — still renders the
  generic sentence.
- An error raised in one mode is gone after switching to the other.
- `PASSWORD_TOO_SHORT` maps to `PASSWORD_REQUIREMENTS_MESSAGE`.

Use the shared harness at `apps/web/src/test/routeHarness.tsx`; do not build another. Query by
accessible role and name, as the existing tests do. Never assert on class names.

## Out of scope

Do not touch: anything under `apps/api`; `apps/web/src/styles.css`; rate limiting; Resend or email
flows; cookie configuration; the Zod 3/4 unification; the `packages/config` split;
`fastify-type-provider-zod`; Stripe; design tokens; delete/rename endpoints; the autosave state
machine; the route guards and session handling added by `feature/auth-session-routing`.

Clearing the error when the visitor edits a field is a reasonable idea and is **not** in this scope.
Only the mode switch was requested.

## Verification required before handoff

Record actual output:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck` — from a clean tree, no prior build
4. `pnpm test:coverage` — `apps/web` enforces per-file thresholds of 80%
5. `pnpm build`
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`
7. `TEST_DATABASE_URL=<ask the lead> PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence`
8. `git diff --check`

Also confirm by inspection, and state that you did, that `apps/web/src/styles.css` is untouched and
no file under `apps/api` was modified.

Chromium is not installed; `PLAYWRIGHT_CHANNEL=chrome` uses the installed Google Chrome.

## Rules

- Do not stage, commit, merge, rebase, force-push, or create/delete worktrees. The user controls all
  Git write operations.
- Do not read, print, or commit `.env` files or any credential.
- No TODO, FIXME, or placeholder comments. No emojis.
- Do not mark anything complete without pasted command output.
- If a command appears to hang for more than a few minutes, stop and report rather than polling.
- If the work seems to require going outside this scope, stop and ask the lead.

## Log

### 2026-08-07 — lead — scope opened

Status: ready-for-implementation
Requested by the project owner: authentication errors are undescriptive, and the message persists
across a switch between signing in and registering. Server-side codes verified correct by live probe
before scoping, so the fix is entirely in the web client.

### 2026-08-07 — implementation agent — implemented and verified

Status: complete

**Scope covered:** all five items and the required test cases. No out-of-scope files touched.

**Changes:**

- `apps/web/src/api.ts` — `PASSWORD_TOO_SHORT` and `PASSWORD_TOO_LONG` now resolve to
  `PASSWORD_REQUIREMENTS_MESSAGE` from `@finaler-draft/config` instead of restating the rule as
  separate string literals.
- `apps/web/src/routes/sign-in.tsx` — the mode-level alert renders `authentication.error.safeMessage`
  when the error is an `AuthApiError`, falling back to the existing generic sentence for anything
  else (network failure, 5xx, unrecognised code). The alert now carries `className="field-error"`
  (reused, not new) instead of no class. `switchMode()` now calls `authentication.reset()` so an
  error from one mode does not survive into the other. Wrong password and unknown email were left
  exactly as-is: both still produce "Invalid email or password." from the single
  `INVALID_EMAIL_OR_PASSWORD` code, and no attempt was made to split them, per the anti-enumeration
  requirement.
- `apps/web/src/test/routeHarness.tsx` (shared harness) — the mocked `useMutation` previously exposed
  only a manually-toggled `mutationError` boolean with no real error object. It now also captures the
  actual rejection from `mutationFn` into `routeState.mutationErrorValue`, exposes it as `error`, and
  adds a `reset()` that clears both. This was required plumbing: there was no way to assert on
  `safeMessage` without the mock surfacing a real `AuthApiError` instance. The pre-existing
  `mutationError` boolean path is additive-OR'd with the new value (`isError: routeState.mutationError
|| routeState.mutationErrorValue !== undefined`), so tests that set the boolean directly are
  unaffected.
- `apps/web/src/routes/sign-in.test.tsx` — four new tests: invalid credentials (covers both wrong
  password and unknown email, since the server code is identical) render "Invalid email or password.";
  a duplicate email at sign-up renders the account-exists message; a 500 with an unrecognised code
  still renders the generic sentence and never leaks the raw message or code; an error from one mode
  is gone after switching to the other.
- `apps/web/src/api.test.ts` — one new test asserting `PASSWORD_TOO_SHORT` and `PASSWORD_TOO_LONG`
  both resolve to `PASSWORD_REQUIREMENTS_MESSAGE`.

**Shared-harness blast radius, checked explicitly:**

- Every route test file using the harness (`sign-in.test.tsx`, `projects/index.test.tsx`,
  `projects/$projectId/index.test.tsx`,
  `projects/$projectId.screenplays.$screenplayId.test.tsx`, `useAuth.test.tsx`) was run, individually
  and as part of the full suite. All pass; none needed edits.
- `projects/index.test.tsx` still sets `routeState.mutationError = true` directly (sign-out failure
  test) without ever calling `mutate()`; `mutationErrorValue` stays `undefined` there, `isError`
  becomes `true` via the boolean side of the OR, and the component (which only reads `isError`, not
  `error`) is unaffected. Confirmed by inspection and by the test passing unchanged.
- No other existing test drives a rejecting `mutationFn` through the mock, so capturing the real
  rejection is new, exercised code, not a behaviour change to any pre-existing path.
- Checked for unhandled promise rejections: the mock uses `Promise.resolve(mutationFn()).then(onFulfilled,
onRejected)` (two-argument form), so a rejection is caught in the same chain and never escapes
  unhandled. Ran `sign-in.test.tsx`, `projects/index.test.tsx`, `App.test.tsx`, and `useAuth.test.tsx`
  together with a plain `vitest run` (not the coverage reporter) and confirmed no "Unhandled
  Rejection"/"Unhandled Error" output.
- Checked for state leakage between tests: `resetRouteHarness()` (called in every file's `beforeEach`)
  sets `mutationErrorValue = undefined` and `mutationError = false`. Vitest's default per-file module
  isolation (this repo does not disable it) gives each test _file_ a fresh `routeState` module
  instance, and within a file the new tests explicitly `await vi.waitFor(() =>
expect(routeState.mutationErrorValue).toBeDefined())` before proceeding, so the rejection handler is
  known to have settled before the next assertion or test runs — no race with the following test's
  `beforeEach`.

**Verification (actual output, this session):**

1. `pnpm format:check` — failed on first run (new test file and this progress doc were not yet
   Prettier-formatted); ran `prettier --write` on both, then: "All matched files use Prettier code
   style!"
2. `pnpm lint` — clean, exit 0, no warnings (`--max-warnings=0`).
3. `pnpm typecheck` — clean across `config`, `screenplay`, `database`, `web`, `api`.
4. `pnpm test:coverage` — 10 web test files, 64 tests passed. `sign-in.tsx`: 99.51% stmts / 98.11%
   branch / 100% funcs (only uncovered line is the pre-existing `isPending ? 'Working…'` branch,
   unrelated to this change). `api.ts`: 100/100/100/100. `routeHarness.tsx`: 100% lines/branches.
   `api` workspace: 22 passed, 3 skipped (persistence integration tests, gated on
   `TEST_DATABASE_URL`, run separately below). All per-file thresholds (80%) cleared.
5. `pnpm build` — succeeded for all five workspace packages.
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — 1 passed (production shell serves the private
   workspace entry point).
7. `TEST_DATABASE_URL=<lead-supplied, used inline only, never echoed/written> PLAYWRIGHT_CHANNEL=chrome
pnpm test:system:persistence` — 2 passed: `session-routing.spec.ts` ("signed-in visitors are kept
   off /sign-in, and signing out reverses that") and `persistence.spec.ts` ("a writer can create,
   autosave, and reload a private screenplay"). Both specs from `feature/auth-session-routing` still
   pass against this branch — no regression.
8. `git diff --check` — clean, no whitespace errors.

Confirmed by inspection: `apps/web/src/styles.css` was not modified, and no file under `apps/api` was
modified. `git diff --stat` shows exactly five files changed:
`apps/web/src/api.ts`, `apps/web/src/api.test.ts`, `apps/web/src/routes/sign-in.tsx`,
`apps/web/src/routes/sign-in.test.tsx`, `apps/web/src/test/routeHarness.tsx`.

**Noticed but correctly left out of scope:** clearing the error on field edit (not requested — only
the mode switch was); the `App.tsx` uncovered branches at lines 301/310-311/489 and
`screenplayEditor.ts` at 303-304/322-325 are pre-existing and untouched by this change.

**Risks / next:** none identified. The harness change is additive and narrowly scoped to the mutation
mock; if a future branch wants richer mutation mocking (e.g. `isPending` transitions), it should
extend this same mock rather than building a parallel one.

# Scope: auth-password-ux

Branch: `feature/auth-password-ux`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/auth-password-ux`
Base: `main` @ `1bce6d3`
Owner: Sonnet implementation agent, advised by the lead.

## Why this scope exists

`plan.md` requires, under Phase 0:

> Registration must visibly state every password requirement beneath the password field, require a
> confirm-password field with an inline match error before submission, and surface safe server-side
> validation feedback. Sign-in and registration password fields must offer an accessible, opt-in
> visibility toggle that preserves the entered value and exposes its state to assistive technology.

None of that exists. `SignInPage` in `apps/web/src/WorkspaceApp.tsx` currently has a bare password
input with a hardcoded `minLength={12}`, no confirm field, no visibility toggle, no requirements
text, and a single generic failure message.

An earlier attempt at this work exists as uncommitted changes in an unrelated worktree. **Do not
copy it.** It introduced six CSS class names with no corresponding styles, hardcoded element `id`
attributes, and duplicated the password rule as a literal string. It is listed here only so you know
not to resurrect it.

## Acceptance criteria

### 1. Password requirements are stated beneath every password field

- Take the text from `PASSWORD_REQUIREMENTS_MESSAGE` in `@finaler-draft/config`, which already
  derives from `PASSWORD_MIN_LENGTH` (12) and `PASSWORD_MAX_LENGTH` (128). `apps/web` already
  declares that dependency. Never restate the rule as a literal.
- The requirements text is always visible beneath the field, not only after an error.
- Associate it with the input via `aria-describedby` so screen readers announce it when the field
  receives focus.
- **The stated policy is length only.** Do not invent uppercase, digit, or symbol requirements; the
  server does not enforce them and claiming otherwise is a lie to the user.

### 2. Confirm-password field with an inline match error

- Renders in sign-up mode only. Sign-in must not show it.
- Submission is blocked while the two values differ. The mismatch error appears inline, before any
  network request is made.
- The error is announced: `role="alert"` on the message, `aria-invalid` on the input, and
  `aria-describedby` pointing at the message.
- Do not show a mismatch error before the user has typed in the confirm field or attempted
  submission. Errors that appear on an untouched field are noise.
- Switching between sign-in and sign-up clears the confirm value and any attempted-submit state.

### 3. Visibility toggle with eye icons

- Both the password and confirm-password fields get their own independent toggle.
- **Inline SVG eye-open and eye-closed icons.** Do not add an icon library or any new dependency.
  Mark the SVG `aria-hidden="true"` and give it `focusable="false"`.
- The toggle is a `<button type="button">`. It must never submit the form.
- **It must preserve the entered value** when toggled. A controlled React input does this correctly;
  verify it rather than assuming.
- **Expose state to assistive technology with `aria-pressed`.** Use a stable accessible name such as
  "Show password" and let `aria-pressed` carry the state. Do not also swap the accessible name
  between "Show" and "Hide" — a name that changes under the user is announced by some screen readers
  as a different control, and combined with `aria-pressed` it is contradictory.
- The toggle is keyboard reachable with a visible focus indicator.
- Default state is hidden. This is opt-in reveal.

### 4. Supporting correctness the current form is missing

- **Use `useId()` for every `id` and `aria-describedby` target.** Hardcoded ids break the moment a
  form renders twice on a page and are the reason the earlier attempt was fragile.
- Add `autoComplete`: `current-password` on the sign-in password, `new-password` on the sign-up
  password and confirm fields, `email` on the email field, and `name` on the name field. Password
  managers depend on these and the form currently has none.
- Replace the hardcoded `minLength={12}` with `PASSWORD_MIN_LENGTH`.
- **Do not set `maxLength` on the password inputs.** Silently truncating a pasted long passphrase is
  worse than showing the length error.
- Every `<label>` must be associated with its control, via `htmlFor` or by wrapping. Do not produce
  an input whose only accessible name is placeholder text.

### 5. Every new class name ships with its styles

This is non-negotiable and it is why the earlier attempt failed. `apps/web/src/styles.css` is the
design system; extend it in the same change.

Match the existing aesthetic, which is deliberate and must not drift:

- **Rectangles.** `border-radius` 0–2px. The file currently uses at most 2px outside two
  intentionally circular elements. No pills, no large rounded cards.
- **Borders and separators carry hierarchy, not shadows.** There are four `box-shadow` declarations
  in 685 lines. Do not add more for a form control.
- Dense and compact. This is desktop authoring software in the spirit of Office, Adobe tools, and
  Google Docs — not a consumer marketing page.
- Reuse existing colors from `styles.css` rather than introducing new hex values. The file already
  carries 92 distinct color literals and a separate `chore/design-tokens` branch will consolidate
  them; do not make that job larger.
- The toggle button is a compact control aligned to the input, sized so it does not distort the
  field's height.

### 6. Tests

Add tests that fail before the change and pass after. Required:

- Mismatched confirmation blocks submission and shows the inline error; no network call is made.
- Matching values allow submission.
- The toggle reveals the value, restores masking, and preserves the typed value across both.
- The toggle exposes its state via `aria-pressed`.
- The requirements text is programmatically associated with the password input.
- Sign-in mode renders no confirm field.
- Switching modes clears confirm state.
- The two toggles operate independently.

Prefer `@testing-library/user-event` and query by accessible role and name, matching the existing
test style in `WorkspaceApp.test.tsx`. Do not assert on class names.

## Out of scope

Do not touch, in this branch: `@fastify/rate-limit`; explicit cookie attribute configuration; Resend
or any email flow; the server-side authentication error-code allowlist in `apps/api`; the Zod 3/4
unification; the `packages/config` split; `fastify-type-provider-zod`; the full design-token
extraction; `legacyInitial` and `initialScreenplayContent`; the autosave state machine; delete or
rename endpoints; Stripe.

Each is a real finding with its own scheduled branch. This branch is the three interface changes and
the correctness gaps that directly support them.

## Verification required before handoff

Run and record actual output:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test:coverage` — the web package enforces per-file thresholds of 80%
5. `pnpm build`
6. `git diff --check`

The real-PostgreSQL integration gate is available: `TEST_DATABASE_URL` pointing at the local
`finaler_draft` database. Ask the lead for the value rather than guessing, and never print it.

Also confirm by inspection, and state that you did: no new class name lacks styles, no hardcoded
element `id` remains, and no new dependency was added to `apps/web/package.json`.

## Rules

- Do not stage, commit, merge, rebase, force-push, or delete worktrees. The user controls all Git
  write operations.
- Do not read, print, or commit `.env` files or any credential.
- No TODO, FIXME, or placeholder comments. No emojis.
- Do not mark anything complete without pasted command output.
- If a fix requires going outside this scope, stop and ask the lead rather than widening it.
- If a command appears to hang for more than a few minutes, stop and report it rather than entering
  a polling loop. A previous agent on this project burned its entire budget waiting on a stalled
  download.

## Log

### 2026-08-07 — lead — scope opened

Status: ready-for-implementation
Acceptance criteria recorded above. Requested directly by the project owner: confirm-password field,
visibility toggle with eye-open and eye-closed icons, and password requirements listed beneath the
password fields.

### 2026-08-07 — implementation agent — three interface changes shipped

Status: ready-for-review (uncommitted diff, handed off per Git-write rules)

**Scope**

Implemented the three requested interface changes and the supporting correctness gaps, entirely in
`apps/web/src/WorkspaceApp.tsx`, `apps/web/src/WorkspaceApp.test.tsx`, and
`apps/web/src/styles.css`. No other files touched. No dependency added to `apps/web/package.json`
(confirmed by `git diff`).

**Changes**

- Confirm-password field, sign-up mode only. Submission is blocked client-side while values differ;
  mismatch error is `role="alert"` with `aria-invalid`/`aria-describedby` on the confirm input. Error
  only appears once the confirm field has been touched or submission has been attempted (tracked via
  `confirmTouched` / `submitAttempted` state), never on an untouched field. Switching sign-in/sign-up
  resets `confirmPassword`, `confirmTouched`, and `submitAttempted` unconditionally on every toggle.
- Visibility toggle on both the password and confirm-password fields, independent state
  (`showPassword` / `showConfirmPassword`), inline hand-written SVG eye-open/eye-closed icons
  (`aria-hidden="true"`, `focusable="false"`), rendered inside a shared `PasswordVisibilityToggle`
  helper. `type="button"` so it never submits the form. Accessible name is stable ("Show password" /
  "Show confirm password"); only `aria-pressed` carries state, per the "don't swap the name" rule in
  the scope file. Verified in a running dev build (see Verification) that toggling preserves the
  typed value and that the two toggles are independent.
- `PASSWORD_REQUIREMENTS_MESSAGE` from `@finaler-draft/config` rendered beneath the primary password
  field (both modes) via a `<p>` associated through `aria-describedby`, always visible, not
  error-triggered. No invented uppercase/digit/symbol rules — length only, matching what the server
  enforces (`apps/api/src/auth.ts` already wires the same `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH`
  constants).
- Correctness gaps: every id (`name`, `email`, `password`, `passwordRequirements`,
  `confirmPassword`, `confirmPasswordError`) now comes from `useId()`; every `<label>` uses explicit
  `htmlFor` (switched away from the old implicit-wrap pattern because wrapping both an input and a
  toggle button in one `<label>` is an ambiguous multi-control association); `autoComplete` added
  (`name`, `email`, `current-password` on sign-in password, `new-password` on sign-up password and
  confirm); `minLength={PASSWORD_MIN_LENGTH}` replaces the hardcoded `12`; no `maxLength` added
  anywhere (long passphrases are never truncated).
- CSS: added `.entry-field` (replaces the old `.entry-card label { display: grid }` now that label
  no longer wraps the input), `.password-field`, `.password-toggle`, `.field-hint`, `.field-error`.
  All five ship with real rules in `styles.css` (lines ~469-517) — checked by grepping every
  `className="..."` in the tsx against the stylesheet, listed in the report below. Reused the
  `visually-hidden` class already in the file for the toggle's accessible-name text instead of adding
  a new one. Border-radius kept at 0-1px, no new `box-shadow`, toggle button sized via
  `top:0;right:0;bottom:0` inside a `position:relative` wrapper so it never grows the input's height,
  and every new color is one already present in `styles.css` (`#4b544d`, `#697268`, `#202722`,
  `#edf0e9`) — none invented. Note: the file has zero red/error hex anywhere, so the mismatch error
  is differentiated by weight and `role="alert"` rather than color; flagged below as a judgment call.

**Tests**

Added to `WorkspaceApp.test.tsx` (all query by role/accessible name, no class-name assertions):
mismatch blocks submission with no fetch call; matching values submit; sign-in renders no confirm
field; no premature mismatch error before touch/submit; mode switch clears confirm value and error;
requirements text `aria-describedby` association; both toggles independently reveal/mask while
preserving value and reporting `aria-pressed`. Updated the pre-existing "signs in, creates an
account" test to fill the now-required confirm field so it keeps passing under the new required
field.

**Verification (actual output, worktree had no `node_modules` — ran `pnpm install` first, which only
resolved from the existing lockfile, no lockfile change)**

1. `pnpm format:check` — fails on `apps/web/src/api.ts` and `apps/web/src/api.test.ts` only, both
   confirmed untouched by this change (`git diff --stat` empty for both) — pre-existing drift, not
   introduced here. My three files report clean.
2. `pnpm lint` — `eslint . --max-warnings=0` — clean, no output, exit 0.
3. `pnpm typecheck` — clean, exit 0, once `packages/screenplay` and `packages/database` were built
   locally (their `dist/` was absent in this fresh worktree and the root `typecheck` script only
   builds `@finaler-draft/config`, not the other two — a pre-existing script gap unrelated to this
   change; building them is a local, gitignored side effect, confirmed via `git status --short`
   showing no new tracked files). `@finaler-draft/web` typecheck reported zero errors both before and
   after that prerequisite build.
4. `pnpm test:coverage` (apps/web) — 37/37 tests passed, 13 in `WorkspaceApp.test.tsx` (up from 5).
   `WorkspaceApp.tsx` coverage: 99.7% stmts, 97.29% branch, 92.85% funcs, 99.7% lines — well above
   the 80% per-file gate. The single uncovered line (209, the pending "Working…" button label) is
   pre-existing dead-in-tests code unrelated to this change.
5. `pnpm build` — clean, all five workspace packages built, `apps/web/dist` produced.
6. `git diff --check` — no output, no whitespace errors.

Also ran the app in a real dev server and drove it with Playwright (sign-up mode, mismatch state,
toggle-revealed state) to visually confirm the rendered result matches the desktop-authoring
aesthetic and that the toggle preserves the typed value across reveal/mask — screenshots reviewed
inline, not persisted (they landed in the main repo's `.playwright-mcp/` directory because that MCP
server's browser sandbox root is fixed there regardless of cwd; removed those untracked artifacts
immediately after and confirmed `git status` there is back to only its pre-existing `plan.md`
modification).

**Review**

Not yet independently reviewed. Diff is uncommitted, handed off per the no-commit rule.

**Risks / next**

- Judgment call, not escalated: the mismatch error (`field-error`) is styled with bold weight and
  `role="alert"` rather than a distinct color, because `styles.css` contains zero red/error hex
  values anywhere and the scope file explicitly said not to introduce new colors ahead of the
  `chore/design-tokens` branch. If the lead wants a real error color, that's a one-line addition once
  a token exists.
- Noticed but correctly left alone: `SignInPage`'s `<h1 id="entry-title">` still has a hardcoded
  string id (pre-existing, predates this change, used once for `aria-labelledby` on the section — not
  one of the form-field ids the scope file called out, and the page is not repeated per render, so it
  doesn't have the duplicate-id failure mode the scope file warned about). Left untouched.
- Noticed but correctly left alone: `apps/web/src/api.ts` has a literal `'Password must be at least
12 characters.'` string in `authErrorMessages` (`PASSWORD_TOO_SHORT`) that duplicates the same rule
  `PASSWORD_REQUIREMENTS_MESSAGE` already expresses. Out of scope — that's server-error-message
  surfacing, not the sign-up form's own requirements text, and the scope file's out-of-scope list
  covers the API's error-code allowlist generally.
- Noticed but correctly left alone: the root `pnpm typecheck` script builds only
  `@finaler-draft/config` before typechecking, while `@finaler-draft/screenplay` and
  `@finaler-draft/database` only get `typecheck` (not `build`) in that same script, so a genuinely
  fresh worktree/clone fails `pnpm typecheck` until someone builds those two packages first. Verified
  this is pre-existing (unrelated files, reproduces before any of my edits) and matches
  `packages/screenplay`/`packages/database` symmetrically — not something this branch should fix.

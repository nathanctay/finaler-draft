# Scope: system-test-mail-port

Branch: `fix/system-test-mail-port`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/system-test-mail-port`
Base: `main` @ `5224da9`
Owner: implementation agent, working from a defect report handed down directly (no separate lead
dispatch for this scope).

## The defect

`apps/api/src/server.ts`'s `buildPersistentApp` selected the outbound mail transport on credential
presence alone:

```ts
const mail =
  persistence.RESEND_API_KEY && persistence.MAIL_FROM_ADDRESS
    ? createResendMailPort({ apiKey: ..., from: ... })
    : createLoggingMailPort({ onSend: options.systemTestMode ? ... : undefined });
```

The comment directly above it asserted that a system-test process never carries a real key. Nothing
enforced that assertion; `options.systemTestMode` was already in scope two lines below and had no
bearing on the branch. `scripts/test-system-persistence.mjs` spawns the server it tests by spreading
`...process.env` into the child process, and `playwright.config.ts`'s `webServer` inherits the
ambient environment the same way — so a real `RESEND_API_KEY` sitting in a developer's shell or
`.env` reaches a system-test run and a live send goes out through Resend. This is not hypothetical:
it fired during this project's own work, and only failed to deliver because the synthetic recipient
domain used in that spec doesn't resolve.

**How it was found:** the failed send surfaced during an unrelated session; tracing it back led to
this exact branch in `server.ts`, and to the untested seam described below that let it ship.

## The fix

`apps/api/src/mail.ts` gained `selectMailPort`, an exported function taking `systemTestMode`,
`resendApiKey`, `mailFromAddress`, and the optional system-test `onSend` hook, returning the chosen
`MailPort`. It is the single place the branch now lives:

- **System-test mode always selects the logging port**, regardless of whether Resend credentials
  are present. This is the entire safety property the old comment only asserted.
- **Credentials are ignored, not rejected.** Refusing to start a system-test process that happens to
  inherit a real key would break the owner's own local runs — his `.env` legitimately carries one.
  The fix silently and safely no-ops the ability to send real mail in that mode; it does not error.
- **The suppression is observable rather than silent.** When system-test mode discards otherwise-
  usable credentials, `selectMailPort` logs one structured line —
  `{"event":"mail_credentials_suppressed_system_test_mode","variables":["RESEND_API_KEY","MAIL_FROM_ADDRESS"]}`
  — naming the variables that were ignored, never their values. It fires exactly once, at selection
  time, only when there was something to suppress.
- **Outside system-test mode, behaviour is unchanged**: credentials present selects Resend,
  credentials absent selects the logging port, matching the original branch exactly.
  `packages/server-config`'s `requirePersistenceEnvironment` still refuses to start a production
  process without both variables — nothing about that moved.

`server.ts`'s `buildPersistentApp` now calls `selectMailPort` instead of inlining the ternary. Its
comment above the call site was rewritten to describe what actually enforces the property, instead
of asserting the property itself.

## Why this shape, not a `buildPersistentApp` test

`buildPersistentApp` is not exported, and building one would mean a Fastify- and
database-dependent test for a two-branch decision — far heavier than the defect warrants.
`apps/api/src/mail.ts` already owns both `MailPort` implementations and `mail.test.ts` was already
set up to receive tests for them with zero network access. Extracting the selection into that file,
as a pure function of primitive inputs, put the previously-untested seam (**which port gets
selected**, as opposed to what each port does once selected — thoroughly covered already) under the
same kind of fast, isolated test as everything else in the file.

## Tests added, `apps/api/src/mail.test.ts`

New `describe('selectMailPort', ...)` block, five tests:

1. System-test mode with both Resend variables set selects the logging port and never touches
   `fetch` — the case that had zero coverage before this fix, and the entire point of it.
2. System-test mode with both variables set still wires the `onSend` mailbox hook, so the existing
   Playwright verification/reset flows keep working.
3. Not system-test mode, both variables set, still selects the Resend port — proving the fix did not
   disable production mail.
4. Neither mode with credentials absent selects the logging port, as before (covers both the
   system-test and non-system-test corners of the "no credentials" case in one test).
5. The suppression log line is emitted only when system-test mode actually discards usable
   credentials — not when it's off, and not when there was nothing to suppress — and its content is
   asserted field-for-field to contain no credential value.

## Mutation testing

Every mutation below: broke the implementation, ran `mail.test.ts`, confirmed the predicted test(s)
failed and nothing else did, restored, diffed the file back to identical.

1. **Disabled the `systemTestMode` branch** (`if (false && systemTestMode)`) — reproducing the
   original defect exactly. Tests 1, 2, and 5 failed: test 1 with `Cannot read properties of
undefined (reading 'ok')` (the stubbed fetch was never configured to resolve, because the port
   under test was silently the Resend port instead of the logging port), test 2 with a thrown
   `Resend rejected the send request (status 401)`, test 5 with `expected undefined to be defined`
   (no suppression line, because nothing was suppressed — credentials were used instead). Tests 3
   and 4 correctly stayed green.
2. **Disabled only the suppression log's condition**, leaving port selection correct (`if (false &&
resendApiKey && mailFromAddress)` inside the system-test branch). Only test 5 failed
   (`expected undefined to be defined`); all four others stayed green, confirming the log assertion
   is independent of the routing assertions.
3. **Dropped `onSend` from the system-test branch's `createLoggingMailPort` call.** Only test 2
   failed (`expected "spy" to be called with arguments... Number of calls: 0`).
4. **Disabled the production-path Resend branch** (`if (false && resendApiKey && mailFromAddress)`
   outside system-test mode). Only test 3 failed (`expected "spy" to be called 1 times, but got 0
times`).
5. **Added the key value itself to the suppression log line** (`resendApiKey` added to the logged
   object), to prove test 5 would actually catch a credential leak rather than only checking the
   line's presence. Failed exactly as intended, both on the structural `toEqual` and (independently)
   the `not.toContain` check, with the received object showing `"resendApiKey": "super-secret-key"`
   in the diff.

Every mutation was restored; `diff` against a pre-mutation copy confirmed the file was returned to
its original state before the final gate run.

## `scripts/test-system-persistence.mjs`'s `...process.env` spread — opinion, not changed

Not narrowed in this fix. The spread is what makes `DATABASE_URL`, `BETTER_AUTH_SECRET`, and every
other variable the script computes reach the child process at all — an allowlist would have to be
kept in sync by hand with every environment variable `parseServerEnvironment` currently reads or
ever will, and silently misses one on the next addition, in the opposite direction from this
project's stated preference for a check that fails loudly rather than one that must be remembered.
`selectMailPort` closes the actual hole (a real key reaching a real send) at the point where the
consequence happens, regardless of how the key arrived in the environment — including paths the
spread isn't even responsible for, like a key set directly in the CI environment. Narrowing the
spread would add an allowlist to maintain without removing the need for `selectMailPort` to exist,
since `playwright.config.ts`'s `webServer` inherits the ambient environment through a separate
mechanism this script doesn't control. If a future audit wants defense in depth here, an explicit
`RESEND_API_KEY: undefined` override alongside the script's existing explicit overrides
(`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, etc.) would be a small, targeted addition — but that is a
belt-and-suspenders call for the owner to make, not something this fix required to close the actual
defect.

## Gate results

1. `pnpm lint` — clean, `--max-warnings=0`, no output.
2. `pnpm format:check` — clean, "All matched files use Prettier code style!"
3. `pnpm typecheck` — clean, run from a fully removed `dist/` tree across every package and both
   apps.
4. `pnpm test` — clean, workspace-wide. `apps/api`: 6 files / 91 tests passed, 1 file / 20 tests
   skipped (`persistence.integration.test.ts`, expected without `TEST_DATABASE_URL`). `apps/web`:
   35 files / 442 tests passed. Every other package (`config`, `server-config`, `screenplay`,
   `database`, `xml-escape`, `fdx`, `layout`, `docx`, `pdf`) passed unchanged.

`pnpm build`, `pnpm test:system`, and the persistence gate were not run for this fix — the change is
confined to `apps/api/src/mail.ts` and `server.ts`'s call site, with no route, schema, or UI surface
touched, and the four required gates above (lint, format, typecheck, test) plus the mutation-testing
pass above are the verification this scope specifies.

## Files touched

- `apps/api/src/mail.ts` — added `SelectMailPortOptions` and `selectMailPort`.
- `apps/api/src/server.ts` — `buildPersistentApp` now calls `selectMailPort`; comment above the call
  site rewritten to describe the enforcement rather than assert it.
- `apps/api/src/mail.test.ts` — new `describe('selectMailPort', ...)` block, five tests.
- `progress/system-test-mail-port.md` — this entry.

## Known limitations / things not done

- The broader browser/persistence gates (`pnpm build`, `pnpm test:system`, the persistence gate)
  were not run — out of proportion to a two-file, no-behavior-surface-change fix, per the task's own
  framing ("a targeted fix, not a refactor of the server bootstrap").
- `scripts/test-system-persistence.mjs`'s `...process.env` spread is unchanged; see the opinion
  above.
- Nothing staged or committed. Handing off an uncommitted diff for review, per this project's
  standing git-ownership rule.

### 2026-08-29 — implementation agent — complete

Status: ready-for-review

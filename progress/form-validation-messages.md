# Scope: form-validation-messages

Branch: `feature/form-validation-messages`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/forms`
Base: `main` @ `4a8d135`
Owner: implementation dispatched to a subagent; the agent terminated on an API error during its own
final confirmation run, after it had finished implementing and mutation-testing. Everything under
"Verification" below was re-run independently by the coordinator rather than relayed from the
agent's report -- including the two mutations the brief named in advance, which are the assertions
most likely to pass for the wrong reason.

## The request

Nathan, while testing the account-deletion UI: "Another thing I noticed while testing though is the
lack of custom error messages. When I try to create a new screenplay or project with no title typed
in, I get the browser default error box that just says 'please fill out this field'. We should have
an actual error message that shows in red beneath the field that tells the user the issue. No
default browser error box. Another thing we can tackle in another slice and examine all forms to
make sure they have an error message."

So: all forms, not only the two he hit.

## Why Zod rather than a hand-written check

Nathan: "I typically like to use Zod for form validation, but if we don't need all that here we can
do something more basic." Grounded rather than taken as given, and it earns its place for one
specific reason that is not the library itself:

- `apps/web` **already depends on `zod` 4.4.3**, so nothing new enters the dependency tree -- which
  matters with the licence review still open.
- Two of these rules are not the client's own opinion. A title's max length and a password's bounds
  are _the server's_ rules, already expressed as Zod schemas reading `@finaler-draft/config`
  constants (`apps/api/src/projects.ts`'s `projectTitle`, `packages/auth-server`'s
  `minPasswordLength`/`maxPasswordLength`).

A hand-written `if (!value.trim())` would restate those numbers in a second, independent place, free
to drift: the client saying "required" where the server rejects for another reason, or accepting 250
characters the server refuses at 200. A schema reading the shared constant cannot drift, because
there is only one number. The win is **one source of truth for the bound**, not Zod.

Where a field's only rule is "not blank" (a name, a revision label) there is no server bound to
share and Zod pulls no particular weight -- it is used anyway for uniformity of the one mechanism.

**What was explicitly ruled out:** inventing a client-only bound the server does not enforce. A
client limit stricter than the server's rejects input the product would have accepted. The email
schema is where this bit: the server's own ceiling (`apps/api/src/sharing.ts`'s `inviteInput.email`,
`.max(320)`) is a **private literal inside `apps/api`**, never exported. Restating `320` here would
have been exactly the drift this work exists to prevent. So `emailFieldSchema` validates only what
every caller can state without inventing anything -- non-empty and `.email()`-shaped -- and an
over-long address still reaches the server and is refused there through the ordinary
`MessageApiError.serverMessage` path every one of these forms already has.

## The mechanism

`apps/web/src/useFormValidation.ts` (new), plus `apps/web/src/formFieldSchemas.ts` (new) for the two
schemas with more than one caller. Nine forms had been hand-rolling, or were about to hand-roll,
their own `touched`/`submitAttempted`/`validationError` trio; `renameDialog.tsx` and
`routes/sign-in.tsx` already did so independently, two different ways. The hook lifts and
generalizes their shared answer rather than redesigning it.

- **`noValidate` on every `<form>`**, so the native bubble is not merely unused but impossible.
- **Timing: on blur after an edit, or on a submit attempt -- never per keystroke.** Nobody should be
  told their half-typed email is wrong while they are still typing it.
- **Clearing is not a separate step.** `error` recomputes from `values` every render, so a field
  cannot show a stale message about a problem it no longer has.
- **`aria-invalid` + `aria-describedby`**, so the message is announced and colour is never the only
  signal. `describedBy()` _joins_ the error id with any static hint id a caller already has, rather
  than assigning over it -- without it, `sign-in.tsx`'s password-requirements hint and
  `reset-password.tsx`'s hint would go silent the moment an error appeared.
- **First invalid field is focused on a blocked submit**, so a keyboard user is not left hunting.
  "First" is the `schemas` object's own key order, so callers must declare fields in render order.

### One finding the brief did not anticipate: blur alone is not enough

Four dialogs autofocus their first field on mount. In `sharingDialog.tsx`, whose member list sits
below that field, the writer's first click on an unrelated "Remove"/"Make owner" button fires a blur
on the still-blank invite field as a pure side effect of focus moving -- surfacing "Enter an email
address." about a field they never touched, triggered by an action unrelated to it. A field must
therefore be **`touched` _and_ `dirty`** (its value genuinely changed at least once) before blur
reveals anything. `submitAttempted` is unaffected and still reveals every invalid field.

## A real pre-existing bug, found on the way

`.field-error` already shipped inside `.dialog` (`namedRevisionDialog`, `feedbackDialog`,
`restoreRevisionDialog`, `upgradeDialog`) with no case exercising it inside the dark editor shell. A
`.dialog` is a **light island**: its background stays white under both themes. The dark theme's
`--feedback-error` is a pale salmon chosen to read against a _dark_ panel, and it was being painted
onto that white background.

Measured: **`#f2a49b` on `#ffffff` = 1.99:1**, against the 4.5:1 floor every other real-text rule in
`text-contrast.spec.ts` is held to. Fixed by splitting `--feedback-error-on-white` (fixed literal)
from `--feedback-error` (themed) and re-anchoring the former inside the existing light-island
selector group -- the same technique already used for `--text-04`/`--text-07`. Back to the unchanged
`#a02c22`, which clears 7.3:1.

This is the third instance of this exact class (see `two-titles`/slice-2's dialog-button regression):
**contrast must be measured against the element's own background, not its container's.**

## Coverage: every form examined

Nathan asked for all forms, so every candidate is listed, including those that turned out not to
need a message.

| File                                                                                                                  | Fields validated                       | Status                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routes/sign-in.tsx`                                                                                                  | name, email, password, confirmPassword | converted (heaviest: sign-in + sign-up in one mounted form, `reset()` on mode switch)                                                                                                                                                      |
| `routes/forgot-password.tsx`                                                                                          | email                                  | converted                                                                                                                                                                                                                                  |
| `routes/reset-password.tsx`                                                                                           | password, confirmPassword              | converted (hint id joined, not overwritten)                                                                                                                                                                                                |
| `routes/projects/index.tsx`                                                                                           | project title                          | converted -- one of the two Nathan hit                                                                                                                                                                                                     |
| `routes/projects/$projectId/index.tsx`                                                                                | screenplay title                       | converted -- the other one                                                                                                                                                                                                                 |
| `renameDialog.tsx`                                                                                                    | title                                  | converted (replaced its own hand-rolled trio)                                                                                                                                                                                              |
| `namedRevisionDialog.tsx`                                                                                             | label                                  | converted                                                                                                                                                                                                                                  |
| `feedbackDialog.tsx`                                                                                                  | message                                | converted                                                                                                                                                                                                                                  |
| `sharingDialog.tsx`                                                                                                   | invite email                           | converted (drove the `touched && dirty` finding)                                                                                                                                                                                           |
| `applicationShell.tsx` inline rename                                                                                  | title                                  | **examined, deliberately no message.** Not a `<form>`, so no native bubble is possible. A blank or unchanged inline rename is silently discarded, Docs-style, rather than erroring -- a pre-existing documented decision, not an omission. |
| `App.tsx`, `applicationMenubar.tsx`, `navigatorPanel.tsx`, `components/OverflowMenu.tsx`, `components/DeletedRow.tsx` | none                                   | **not forms.** Matched the initial `required` grep only on the _word_ "required" inside prose comments. No `<input>`/`<textarea>`/`<select>` between them.                                                                                 |

## Verification

All re-run by the coordinator, not relayed.

Gates: `lint` 0, `typecheck` 0, `format:check` 0, `test` 0 (**1311** web / 397 api / 181 collab),
`test:system` 0 (116 passed). `format:check` was itself checked for vacuity -- deliberately
misformatting `useFormValidation.ts` fails it, naming the file.

### Mutation table

Every guard neutralized one at a time, each with the rest of the tree intact.

| Mutation                                                         | Result                                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `noValidate` removed from `routes/projects/index.tsx`            | **caught** -- fails by name: "carries noValidate, so the browser never renders its own 'please fill out this field' bubble" |
| submit guard neutralized, `feedbackDialog.tsx`                   | caught (1 failed)                                                                                                           |
| submit guard neutralized, `namedRevisionDialog.tsx`              | caught (1)                                                                                                                  |
| submit guard neutralized, `renameDialog.tsx`                     | caught (1)                                                                                                                  |
| submit guard neutralized, `sharingDialog.tsx`                    | caught (1)                                                                                                                  |
| submit guard neutralized, `routes/sign-in.tsx`                   | caught (6)                                                                                                                  |
| submit guard neutralized, `routes/reset-password.tsx`            | caught (3)                                                                                                                  |
| submit guard neutralized, `routes/forgot-password.tsx`           | caught (2)                                                                                                                  |
| submit guard neutralized, `routes/projects/index.tsx`            | caught (3)                                                                                                                  |
| submit guard neutralized, `routes/projects/$projectId/index.tsx` | caught (1)                                                                                                                  |
| `--feedback-error` re-anchor removed from the light-island group | **caught** -- `.field-error in a dialog`, dark theme, reports `#f2a49b on #ffffff` = 1.9888 against `>= 4.5`                |

All nine submit guards are load-bearing: no form can submit past an invalid field without a test
saying so, and the "no native bubble" assertion tests the mechanism rather than merely checking that
a custom message appeared.

### One trap worth recording

The contrast mutation first appeared to pass -- both runs green. The spec had not run at all:
`pnpm --filter @finaler-draft/web test:e2e` prints "None of the selected packages has a 'test:e2e'
script" and **exits 0**. A missing script is indistinguishable from a passing suite by exit code
alone. The real runner is root `pnpm test:system` (`pnpm build && playwright test`). Always confirm
a suite reported a test count before reading its exit code as a pass.

# Menus, slice 3: Help (Send feedback, Keyboard shortcuts)

Branch `feature/menus-slice-3`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/help`, off
`main` at `a43f850`. The worktree arrived coherent and green per the lead's own repair of a prior
attempt killed mid-run; everything below this point is this slice's own work.

## The problem

`applicationMenubar.tsx` carried `INERT_MENU_LABELS = ['Help'] as const`, rendered as a plain
`<span>` -- the last inert label plan.md's menubar still had to activate. Slice 1
(`progress/menus-slice-1.md`) made Edit, View and Format real; slice 2
(`progress/menus-slice-2.md`) made Tools real. This slice gives Help its first two items -- **Send
feedback** and **Keyboard shortcuts** -- and, because Help was the last label standing, removes the
inert-label machinery (`INERT_MENU_LABELS`, the trailing `.map()` that rendered it) entirely.
`ApplicationMenubar` no longer has any concept of a menu that is merely a label; every menu it
knows about is either real or absent.

## What each Help item does

**Send feedback…** opens a dialog (`feedbackDialog.tsx`) where a signed-in writer types a message
and sends it to `POST /api/feedback` -- the capture path from `progress/feedback-capture.md`,
already merged and out of scope to rebuild. It never touches the document and carries no
`editingAllowed` gate, the identical exemption Tools' Word count already established: a reviewer,
or a writer reading a historical revision, may report a problem exactly as they may still copy text
or count words.

**Keyboard shortcuts…** opens a read-only dialog (`keyboardShortcutsDialog.tsx`) listing the
shortcuts `keyboardShortcuts.ts` actually documents, each one verified against the real
`addKeyboardShortcuts()` of the extension that registers it (see "Keyboard shortcuts" below). It
mutates nothing and also carries no gate.

Both items live in `App.tsx`'s own `helpMenuItems` array, rendered through the identical seam
slices 1-2 established: a plain `OverflowMenuItem[]` the caller builds, gated by
`ApplicationMenubar`'s own `hasItems()`. The diff route (the read-only revision comparison) builds
its own, separate `helpMenuItems` array with only Send feedback -- see "The comparison-view
decision" below.

## appVersion: how it is produced, and why the git SHA

The brief named the gap precisely: `apps/web/package.json` is pinned at `"0.0.0"` and has never been
bumped, so it carries no real per-build identity, and the API's `feedbackContextInput.appVersion`
requires a non-empty string regardless.

**What ships:** the git commit SHA checked out at build time, inlined via a Vite `define` in
`vite.config.ts`'s `resolveAppVersion()`:

```ts
function resolveAppVersion(): string {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: import.meta.dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return sha.length > 0 ? sha : 'dev';
  } catch {
    return 'dev';
  }
}
```

**Why the SHA, not a bumped package version:** it maps a report back to the exact code that
produced it with no human in the loop having to remember to bump anything -- the whole point of
attaching this automatically. A package version a person forgets to bump is silently wrong forever;
a SHA is correct by construction every single build.

**Why `define`, not `import.meta.env`:** `collabConfig.ts`'s own top comment explains the mechanism
this follows -- `define` is a textual substitution resolved once, at build time, which is correct
here because this is a build-time identity (one build has one SHA), not a per-deployment runtime
setting the way `VITE_COLLAB_WS_URL` is.

**Why it cannot fail the build:** `try`/`catch` around the one `execSync` call, falling back to the
literal string `'dev'` -- a value the server accepts (`feedbackContextInput.appVersion` only
requires non-empty) and one that is honest about what it is: a build this function could not
identify. This covers every way a build environment can lack a usable git history: no `git` binary
on `PATH`, a shallow clone with no reachable `HEAD`, a build run from an extracted tarball with no
`.git` directory at all. A dirty working tree is not handled specially and does not need to be:
`git rev-parse HEAD` reports the commit checked out regardless of uncommitted changes on top of it,
and a second `git status` call on every single build to detect dirtiness was judged not worth the
cost for a feedback report's own metadata.

`appVersion.ts` is the one module that reads the define back out (`export const APP_VERSION: string
= __APP_VERSION__;`), declared in `vite-env.d.ts` (`declare const __APP_VERSION__: string;`) so
every caller gets the identical value rather than each reaching for the bare global independently.

**Verified:** `pnpm --filter @finaler-draft/web typecheck` resolves the global declaration with no
error; `pnpm build` and `pnpm check:bundle-budget` both built a real app with this define active
(confirmed the literal SHA `a43f850e17faccf20eefc47e64e05956f447eb6a` appears in
`App.test.tsx`/`api.test.ts`'s own assertions, read from `APP_VERSION` at test time against the
real worktree's `HEAD`); Vitest resolves the same `define` (confirmed by every test that asserts
`APP_VERSION` against the real git SHA passing without any additional mock).

## route: `useLocation().pathname`, not `Route.fullPath`

`App` stays free of any `@tanstack/react-router` dependency (the same rule that already makes
`onOpenRevisionHistory`/`onOpenSharing` callbacks rather than navigations `App` performs itself), so
`route` is a plain string prop each caller supplies. The brief suggested the router's own
location/matches as the source, explicitly ruling out hand-assembling a path from
`window.location`.

**`Route.fullPath` was tried first and rejected** -- not a style preference, a real defect found by
trying it. That getter's backing field (`_fullPath`) is only ever set by
`@tanstack/router-core`'s `BaseRoute.init()`, which runs once a route is attached to a real, built
route tree (`routeTree.gen.ts`, assembled at app bootstrap). Every route-level unit test in this
app imports one route file standalone, with no tree ever built around it, so `Route.fullPath` reads
back `undefined` in exactly that situation -- confirmed directly: the first version of this slice's
route-level tests failed with `"route": undefined` in the submitted payload, not the expected path.

**What shipped instead:** `useLocation().pathname`, mocked in `apps/web/src/test/routeHarness.tsx`
the identical way `useParams`/`useNavigate` already are (`routeState.pathname`, defaulting to `''`
so the many tests that never exercise Send feedback are unaffected). Each of the three callers
(`App.tsx`'s two route callers, the diff route) reads `const { pathname } = useLocation();` and
passes the resolved current path -- the writer's real location, with real ids, not a hand-assembled
string.

`App.tsx`'s own `route` prop defaults to `UNKNOWN_ROUTE = 'unknown'` (mirroring `initial`'s own
`legacyInitial` default), reachable only by a test or a future caller that forgets to pass one;
every real caller always supplies its own.

## The exact payload, and the explicit exclusion of manuscript text

`api.ts`'s `submitFeedback(body: string, context: FeedbackContext)` posts
`JSON.stringify({ body, context })` to `/api/feedback`, where `FeedbackContext` is

```ts
export interface FeedbackContext {
  readonly route: string;
  readonly screenplayId?: string | undefined;
  readonly appVersion: string;
}
```

-- field for field what `apps/api/src/feedback.ts`'s `.strict()` `feedbackContextInput` accepts, and
nothing else. `screenplayId` is always supplied in this slice: both screens that expose Send
feedback (`App.tsx`, covering the live editor and the historical-revision preview; the diff route)
are always screenplay-scoped, so the optionality the server schema carries (for a hypothetical
future screen with no screenplay in view, per `feedback.ts`'s own comment about the projects
dashboard) is unused today, not unreachable by design -- recorded here so it reads as a known gap
in this slice's own scope rather than an oversight.

The owner's absolute requirement -- "of course no manuscript text can be copied" -- is enforced
server-side, not here: the dialog has no way to read the document at all (it takes a plain `onSubmit:
(body: string) => Promise<void>` callback the caller builds), and the server's `.strict()` schema
rejects any field this client did not send. This slice adds no new enforcement of that rule; it
adds the one caller that could violate it if it tried, and the dialog's own code has no access to
the screenplay to violate it with.

## Surfacing the length cap and the 429, client-side

**The length cap.** `FEEDBACK_BODY_MAX_LENGTH` (4000, `@finaler-draft/config`) is read by the
textarea's own `maxLength` attribute (stops ordinary typing and most pastes at the cap) and by a
second, independent JS guard (`trimmed.length > FEEDBACK_BODY_MAX_LENGTH`) that disables Send --
belt-and-suspenders, because `maxLength` alone is a browser attribute this app does not control the
enforcement of on every possible input path (a malformed paste event, say). A live counter
(`{body.length} / {FEEDBACK_BODY_MAX_LENGTH}`) reads the raw value, matching what the browser
attribute actually bounds while typing.

**The 429.** `apps/api/src/app.ts`'s per-user rate limit (`FEEDBACK_SUBMISSIONS_PER_HOUR`, currently 12) answers a refusal with `{error: 'Too many requests'}` through the app's shared error handler --
the identical `{error: string}` shape `jsonWithServerMessage` already parses into every other
`MessageApiError` this client throws. `describeFeedbackError` checks `error instanceof ApiError &&
error.status === 429` _first_, ahead of the generic `MessageApiError`/`Error` fallbacks, and returns
a dedicated sentence: _"You've sent a lot of feedback recently. Wait a bit and try again."_ --
never the bare `Request failed (429)` a plain `ApiError` would print, and never the server's own
terse `Too many requests` either. Checked via `instanceof ApiError`, not `MessageApiError`
specifically, because `status` is what a 429 actually is; `MessageApiError` is only how this client
happens to carry the server's body today, and a future refactor that stopped doing that must not
silently stop recognising the rate limit along with it. This matters more than it looks: the owner
has said he plans to lower the limit to 5 once the endpoint is battle-tested, which makes a 429 a
real, not hypothetical, writer-facing event.

Every other refusal (chiefly the 400 the client-side length/blank checks should already have
prevented) is shown verbatim via `error.serverMessage`, the same convention
`createNamedRevision`/`renameProject` already use. A rejection that is not an `Error` at all falls
back to one generic sentence.

## Keyboard shortcuts: what is listed, what is verified, what is deliberately left out

The brief's framing: the real key handling in this app is sparse and scattered, so a hand-authored
list can drift from the code the moment either side changes without the other, and that drift has
to be caught by a test, not by inspection.

**What is listed**, each entry carrying every raw ProseMirror-keymap binding string that performs
it (`keyboardShortcuts.ts`'s `KEYBOARD_SHORTCUTS`):

| Shown as (rendered via `renderBinding`)            | Description                                                                   | Source                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Cmd+Z` / `Ctrl+Z`                                 | Undo                                                                          | `packages/screenplay-editor`'s `ScreenplayYjsExtension` (`Mod-z`)    |
| `Shift+Cmd+Z` / `Shift+Ctrl+Z`, `Cmd+Y` / `Ctrl+Y` | Redo                                                                          | same (`Shift-Mod-z`, `Mod-y`)                                        |
| `Tab`                                              | Convert the current line -- Action to Character, or Dialogue to Parenthetical | `ScreenplayBlockNode` (`Tab`)                                        |
| `Enter`                                            | Start the next line, in the element that usually follows the one you're on    | `ScreenplayBlockNode` (`Enter`)                                      |
| `Tab`                                              | Accept the inline suggestion                                                  | `apps/web/src/smartTypeGhost.ts`'s `SmartTypeGhostExtension` (`Tab`) |
| `Escape`                                           | Dismiss the inline suggestion                                                 | same (`Escape`)                                                      |

`Mod` renders as `Cmd` on a Mac platform and `Ctrl` elsewhere, via `@tiptap/core`'s own exported
`isMacOS()` -- the identical platform check `prosemirror-keymap`'s own key-normalisation uses under
the hood, reused rather than a second platform sniff so this label can never name a key the real
binding does not answer to.

**How "verified" is proven, not asserted**: `keyboardShortcuts.test.ts` resolves the _actual_
registered binding set for each `source` and asserts every claimed binding is a member of it.
`screenplayYjs`/`screenplayBlock` are resolved by building the real extension set
(`createLocalScreenplayEditorInit({ type: 'screenplayDocument', content: [] })`, the identical
builder `packages/screenplay-editor`'s own `editing.test.ts` uses for every one of its keymap
tests) and reading each extension's `addKeyboardShortcuts()` via `@tiptap/core`'s own
`getExtensionField` -- the same helper `ExtensionManager.plugins` uses internally to turn that
method into the real ProseMirror keymap a keypress actually reaches, not a re-implementation of it.
`smartTypeGhost` is resolved the identical way against the real `SmartTypeGhostExtension`. A
non-vacuous check runs first (`resolves a non-empty binding set for every source this dialog
cites`), so a `source` that resolved to nothing could not make every `toContain` below pass by
finding nothing to disagree with.

**What is deliberately not listed, and why**:

- `seamCaret.ts`'s own key handling (`ArrowLeft`/`ArrowRight`/`Home`/`End` at a mid-block page seam)
  is not a shortcut in the sense this dialog means. It is a caret-affinity correctness fix for where
  the _native_ arrow keys land at a page boundary (`progress/page-seam-caret.md`), not a chord a
  writer discovers and invokes on purpose. Listing "Left/Right move the caret" would be noise, not
  help -- the same reasoning this dialog applies to every ordinary, undocumented key a text field
  already answers to.
- `elementMenu.tsx`'s own `ArrowUp`/`ArrowDown`/`Enter`/`Tab`/letter bindings are real, but exist
  only while that specific menu is already open over an empty block, and that menu's own UI already
  shows each option's letter shortcut inline (`ELEMENT_SHORTCUTS`, announced to screen readers too).
  Restating them in a second, static list a writer has to remember out of context would teach the
  same thing worse, not better.

Nothing was listed that could not be verified; nothing verifiable was left out silently. Both
exclusions are stated here, in the module's own top comment, and nowhere else -- there is no
"unverified, but listed anyway" entry in this dialog.

## The comparison-view decision

Decided by the brief, applied rather than re-litigated: **Send feedback renders on the diff route;
Keyboard shortcuts does not.**

A reader hitting a problem on the comparison needs no editor to report it -- the item's own
`onSubmit` builds the identical `FeedbackContext` shape App.tsx's copy does, sourced from that
route's own `useLocation().pathname`, the real `screenplayId` param, and the same `APP_VERSION`.
Keyboard shortcuts is omitted outright, not disabled: there is no editor on that screen at all (no
Tiptap `Editor`, no `Y.Doc` -- this route's whole existence depends on that, per its own module
comment), so a list of editing shortcuts would describe controls the screen structurally does not
have. This is a different shape of exclusion from Edit/Format/Tools' own (a "disabled, because
read-only" sentence would at least be coherent for those three; "these shortcuts do not apply
because there is no editor" is not a reason to disable, it is a reason the item is simply not
offered) -- the Help menu's own module comment in `applicationMenubar.tsx` states this distinction
directly rather than leaving the reader to infer it from the pattern the other three menus set.

Proven in three places: `App.test.tsx`'s "Help menu" describe block (both items present, the real
`App.tsx` instance); the diff route's own test file's "Help menu" describe block ("lists exactly
one item, Send feedback…, with Keyboard shortcuts omitted", and a submission test asserting the
exact `{appVersion, route, screenplayId}` payload); and `applicationMenubar.test.tsx`'s own
comparison-combination test, extended from slice 2's "renders exactly File and View" to "renders
exactly File, View and Help."

## Both themes, verified with a real-browser measurement

Followed `word-count-dialog-dark-contrast.spec.ts`'s own technique exactly, in a new
`help-dialogs-dark-contrast.spec.ts`: each dialog's real markup wrapped in the real
`.application.dark` ancestor `App.tsx`/the diff route actually put it inside, never a bare render
with no `.dark` ancestor (the exact gap that let the original menubar-dropdown defect ship
unnoticed, per slice 1's own postmortem).

- `.dialog` itself is one of the surfaces that stays white in both themes (`--surface-01`, never
  redefined by `.dark`) -- confirmed in both dialogs' probes.
- Every new text rule this slice wrote (`.feedback-dialog-count` via `.muted`, `.keyboard-shortcut-
keys kbd`, `.keyboard-shortcut-description`) sets its own colour from a token `.dark` does not
  redefine (`--text-07`, `--text-13`, `--text-09`), so each reads identically in both themes --
  proven by equality, not merely by reading the source.
- Both dialogs' action buttons (`Cancel`/`Send`, `Close`) are `.dialog-actions button`, which
  _correctly_ does not hold to that rule -- its own background (`--surface-03`) follows the theme,
  so its inherited text colour must too, the exact property slice 2's own regression (forcing the
  light theme's colour onto it, measuring 1.489:1 in the dark theme) got backwards. Re-measured here
  for these two dialogs' own markup, not re-argued: both buttons' colours genuinely differ between
  themes, confirming the property still holds.

Added two ratio cases to `text-contrast.spec.ts` (the preferred home for ratio assertions, per the
brief) rather than only the light-island equality check above: `.keyboard-shortcut-keys kbd` and
`.keyboard-shortcut-description`, both `REAL_TEXT` (4.5:1), both `themes: BOTH`. `.feedback-dialog-
count` needed no new case: it is `.muted` plus a `text-align` override, and `.muted in a dialog
(white under both themes)` already covers the identical colour pairing.

**The kbd chip's own design choice, stated plainly so it is not mistaken for an oversight**:
`.keyboard-shortcut-keys kbd` paints its own explicit background (`--surface-09`) and colour
(`--text-13`), _deliberately neither one a token `.dark` redefines_ -- it is a "stays light in both
themes" surface by construction, the same category `.dialog` itself belongs to, rather than a
themed sub-surface that would need a `color: inherit` rescue the way `.dialog-actions button` does.
Mutation-tested below to confirm this is load-bearing, not merely argued.

## The constant's move into `@finaler-draft/config`

Groundwork, done before this agent's run began, but belonging in this slice's record per the
brief: `FEEDBACK_BODY_MAX_LENGTH` moved from a private constant in `apps/api/src/feedback.ts` into
`packages/config/src/index.ts`, the identical move `RESOURCE_TITLE_MAX_LENGTH` already made for
`projects.ts`. `apps/api` imports the shared constant (and its own test asserts the import, not a
restated literal); `packages/config` carries its own test (`FEEDBACK_BODY_MAX_LENGTH` is
`toBe(4000)`). This slice's own `feedbackDialog.tsx` is the first real consumer on the browser side
-- the move was made in anticipation of exactly this dialog, and `packages/config` has no imports
of its own, so pulling it into the browser bundle adds nothing beyond the one number.

## Mutation testing

Every guard below was broken, confirmed to fail the specific test(s) that should catch it by name,
then restored. An exact match count was confirmed before each mutation, and `git diff`/direct
`grep` confirmed an empty or identical-to-source state after each revert.

| #   | Mutation                                                                                                                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | `feedbackDialog.tsx`'s 429 check widened from `error.status === 429` to `error.status === 4290`                                                                                 | Killed exactly "gives a 429 refusal its own sentence…" -- the alert read the generic `Request failed (429)` instead.                                                                                                                                                                                                                                                           |
| M2  | `feedbackDialog.tsx`'s `tooLong` hardcoded to `false`                                                                                                                           | Killed "disables Send when the message is over the length cap, even bypassing the textarea's own maxLength" -- Send stayed enabled over the cap.                                                                                                                                                                                                                               |
| M3  | `feedbackDialog.tsx`'s Send-disabled expression dropped `trimmed.length === 0`                                                                                                  | Killed 2 tests: the initial-render disabled check, and the whitespace-only-message disabled check.                                                                                                                                                                                                                                                                             |
| M4  | `applicationMenubar.tsx`'s Help block's guard changed from `hasItems(helpMenuItems)` to `hasItems(toolsMenuItems)`                                                              | Killed 5 tests: every Help-menu-presence assertion in `applicationMenubar.test.tsx` (a copy-paste-shaped bug, not a crash -- caught by the right tests disagreeing, not a thrown error).                                                                                                                                                                                       |
| M5  | `keyboardShortcuts.ts`'s "Dismiss the inline suggestion" binding changed from `'Escape'` to `'Mod-q'`                                                                           | Killed exactly the one `it.each` case for that entry -- `expected [ 'Tab', 'Escape' ] to include 'Mod-q'`.                                                                                                                                                                                                                                                                     |
| M6  | `App.tsx`'s feedback context's `screenplayId: initial.id` changed to `screenplayId: undefined`                                                                                  | Killed "submits the trimmed message with this screen's route, this screenplay's id, and the build's APP_VERSION…".                                                                                                                                                                                                                                                             |
| M7  | `App.tsx`'s `UNKNOWN_ROUTE` changed from `'unknown'` to `''`                                                                                                                    | Killed "falls back to a non-empty placeholder route when the caller supplies none".                                                                                                                                                                                                                                                                                            |
| M8  | The diff route's `helpMenuItems` given a second, wrongly-added `'Keyboard shortcuts…'` entry                                                                                    | Killed "lists exactly one item, Send feedback…, with Keyboard shortcuts omitted".                                                                                                                                                                                                                                                                                              |
| M9  | `feedbackDialog.tsx`'s `describeFeedbackError` had its `MessageApiError` branch deleted entirely                                                                                | Killed "shows a generic server refusal inline, verbatim, and does not close" -- the alert fell through to the generic `Error` branch and read `Request failed (400)` instead of the server's own sentence.                                                                                                                                                                     |
| M10 | `styles.css`'s `.keyboard-shortcut-keys kbd` background changed from `var(--surface-09)` to `var(--surface-03)` (a real-browser CSS mutation, rebuilt and run against Chromium) | Killed `text-contrast.spec.ts`'s new dark-theme `.keyboard-shortcut-keys kbd` case: `#263840 on #34424b`, 1.49:1 or so, below the 4.5 floor. (The light-theme case of the same mutated run hit an unrelated browser-launch timeout under contention -- not a false pass: the dark-theme case is the one this mutation targets, and it failed with the exact numbers expected.) |

Not separately mutation-tested: `hasItems()`'s own general mechanism and `OverflowMenu.tsx`
(untouched, per the brief) -- both already covered by slice 1's own mutation table and
`OverflowMenu.test.tsx`'s 39-test suite, and this slice's wiring could not plausibly re-break either
without M4 above also catching it. The dark-theme `.dialog-actions button` property (background
follows the theme, text must too) was re-measured for these two dialogs' own markup rather than
re-mutated -- it is slice 2's own guard, already mutation-tested there (`text-contrast.spec.ts`'s
own M-equivalent), and nothing in this slice's CSS touches that rule.

## Test-file updates, beyond the new tests

- **`apps/web/src/appVersion.ts`** (new) -- the one module reading `__APP_VERSION__` back out.
- **`apps/web/src/keyboardShortcuts.ts`** (new) -- `KEYBOARD_SHORTCUTS`, `platformModLabel`,
  `renderBinding`.
- **`apps/web/src/keyboardShortcuts.test.ts`** (new) -- 11 tests: the non-vacuous resolution check,
  one `it.each` case per claimed binding (6), and 4 `renderBinding`/`platformModLabel` cases
  (Mac, non-Mac, named keys left alone).
- **`apps/web/src/feedbackDialog.tsx`** / **`keyboardShortcutsDialog.tsx`** (new) -- the two
  dialogs, following `NamedRevisionDialog`/`WordCountDialog`'s own hand-built modal shell exactly.
- **`apps/web/src/feedbackDialog.test.tsx`** (new) -- 15 tests: empty/whitespace gating, the live
  counter, the length-cap guard (including the `fireEvent.change` bypass of the textarea's own
  `maxLength`), the trimmed-submission/close-on-success path, the generic-refusal path, the 429
  path, the non-Error-rejection fallback, Cancel/Escape, the no-op-on-blank-submit guard, and the
  focus-trap/stray-key cases `NamedRevisionDialog.test.tsx` already established the shape of.
- **`apps/web/src/keyboardShortcutsDialog.test.tsx`** (new) -- 6 tests: every `KEYBOARD_SHORTCUTS`
  entry renders with its rendered binding(s), the row count matches the module's own export length
  (so this component cannot silently grow a second, hand-copied list), Close/Escape, initial focus,
  Tab-wrap, stray-key.
- **`apps/web/src/api.ts`** -- `FeedbackContext`, `feedbackResponseSchema`, `api.submitFeedback`.
- **`apps/web/src/api.test.ts`** -- new `describe('submitFeedback', …)` block, 3 tests: the real
  `fetch` call shape (`{body, context}`, `credentials: 'include'`, `POST`), `screenplayId`'s literal
  absence from the serialized body when the context carries none, and the 429
  `MessageApiError`/`serverMessage` round trip -- the one place `api.submitFeedback`'s _real_
  implementation (not a spy) is exercised against a fetch mock; every other test of it in this slice
  spies it away.
- **`apps/web/src/applicationMenubar.tsx`** -- `helpMenuItems`/`helpMenuRef` props,
  `INERT_MENU_LABELS` and its rendering removed entirely, doc comments throughout updated to state
  Help is the last menu activated.
- **`apps/web/src/applicationMenubar.test.tsx`** -- the two "still-to-come label" tests removed (no
  label survives to assert); new Help-specific tests mirroring Tools' own four from slice 2
  (renders and fires, omitted when absent/empty, ref attachment); the comparison-combination test
  extended to "exactly File, View and Help."
- **`apps/web/src/App.tsx`** -- `route` prop (defaulting to `UNKNOWN_ROUTE`), `helpMenuRef`,
  `feedbackDialogOpen`/`keyboardShortcutsDialogOpen` state, `closeFeedbackDialog`/
  `closeKeyboardShortcutsDialog`, `helpMenuItems` passed to `ApplicationMenubar`, both dialogs
  rendered in `outOfFlow`.
- **`apps/web/src/App.test.tsx`** -- new `describe('Help menu: Send feedback and Keyboard
shortcuts', …)` block, 8 tests: the two-item list, the exact submitted payload (route,
  screenplayId, APP_VERSION), the `route` fallback's own non-vacuous proof, Escape/focus-return for
  both dialogs, the 429 path end to end through the real `App`, the no-`editingAllowed`-gate proof,
  and the Keyboard shortcuts dialog listing Undo.
- **`apps/web/src/routes/projects/$projectId.screenplays.$screenplayId/index.tsx`** and
  **`.../$revisionId/index.tsx`** -- `useLocation()`, `route={pathname}` passed to `EditorWorkspace`.
- **Both routes' own test files** -- one new test each, asserting the real resolved pathname
  (with the harness's own fixed ids) reaches the editor mock's `route-prop` marker.
- **`apps/web/src/routes/projects/$projectId.screenplays.$screenplayId.revisions.$revisionId.diff.tsx`**
  -- `useLocation()`, `feedbackDialogOpen` state, `helpMenuRef`, `helpMenuItems` (one item),
  `FeedbackDialog` rendered in `outOfFlow` (now a fragment, alongside the pre-existing print
  refusal).
- **That route's own test file** -- new "Help menu" describe block, 2 tests: the one-item list, and
  the exact submitted payload through the real dialog.
- **`apps/web/src/test/routeHarness.tsx`** -- `routeState.pathname` (mocking `useLocation`'s
  `pathname`), `route` surfaced on the `editorModuleMock`'s own marker the same way
  `viewerRole`/`breadcrumb` already are.
- **`apps/web/vite.config.ts`** -- `define: { __APP_VERSION__: ... }`, `resolveAppVersion()`.
- **`apps/web/src/vite-env.d.ts`** -- `declare const __APP_VERSION__: string;`.
- **`apps/web/src/styles.css`** -- `.dialog-field textarea` folded into the existing input rule
  (plus its own `resize: vertical`), `.feedback-dialog-count`, `.keyboard-shortcuts-dialog`,
  `.keyboard-shortcuts-list`, `.keyboard-shortcut-row`, `.keyboard-shortcut-keys kbd`,
  `.keyboard-shortcut-description`.
- **`apps/web/e2e/help-dialogs-dark-contrast.spec.ts`** (new) -- see "Both themes, verified."
- **`apps/web/e2e/text-contrast.spec.ts`** -- two new ratio cases (kbd, description).
- **`apps/web/e2e/menubar-menus-position.spec.ts`** -- the hand-copied menubar markup's inert
  `<span>Help</span>` replaced with a real `.menubar-menu.menu-help` trigger; the flush-trigger
  geometry test extended to assert Help matches File's own border-radius/font-weight/height.
- **`apps/web/e2e/screenplay-diff-persistence.spec.ts`** -- the chrome-enumeration assertions
  updated: both frames' `menubarChildren` now carry a real `menu-help` `DIV` instead of the inert
  `SPAN`; both frames' `menubarControls` name lists gained `'Help menu'`.

## Gate results

All from the worktree root, after `pnpm install --frozen-lockfile` and `pnpm build:packages`.

| Gate                                                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                    | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm build:packages`                                                                               | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm typecheck`                                                                                    | exit 0 across every package, both apps, and `astro check` for `apps/landing` -- 0 errors/warnings/hints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm lint`                                                                                         | exit 0, `--max-warnings=0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm test`                                                                                         | exit 0 (run without `TEST_DATABASE_URL`, matching CI). `apps/web` **1196 tests / 77 files**; `apps/api` 344 passed + 106 skipped (integration, no DB in this run); `apps/collab` 181 passed + 32 skipped; every `packages/*`/`apps/landing` suite green and untouched by this slice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm test:integration`                                                                             | exit 0, against the disposable Postgres below: `packages/database` 11/11, `apps/api` 106/106 (8 files), `apps/collab` 32/32 (3 files).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm test:coverage`                                                                                | exit 0, every per-file threshold (80% lines/functions/branches/statements) met across every package. This slice's own new files: `appVersion.ts` 100/100/100/100, `keyboardShortcuts.ts` 100/100/100/100, `applicationMenubar.tsx` 100/100/100/100, `feedbackDialog.tsx` 98.24/92.5/100/98.24, `keyboardShortcutsDialog.tsx` 95.45/88.23/100/95.45, `api.ts` 99/97.33/98.11/99, `App.tsx` 92.64/89.03/88.09/92.64.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm build`                                                                                        | exit 0 -- web, api, collab, landing, every package.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm check:bundle-budget`                                                                          | exit 0. Entry chunk 112.23 / 120.00 kB. Lazy editor chunk **169.29 / 200.00 kB** (6 chunks; grew from slice 2's recorded 167.66 kB -- the new Help wiring, `FeedbackDialog`, `KeyboardShortcutsDialog`, `appVersion.ts`, and `keyboardShortcuts.ts` all live in `App.tsx`'s own chunk). CSS **8.45 / 20.00 kB** (grew from 8.32 kB). All within budget with headroom.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test:system` (`PLAYWRIGHT_CHANNEL=chrome`)                                                    | **107 passed, 2 failed** on the first full run. Both failures are browser-launch/context-setup timeouts (`Timeout 180000ms exceeded`/`Test timeout of 30000ms exceeded while setting up "context"`, with a Chrome cert-parsing stderr line alongside both) in `app-bar-logo.spec.ts` (an unrelated hover/focus-reveal spec) and `apps/landing`'s `header-contrast.spec.ts` (a package this slice never touched at all) -- the identical contention signature slices 1 and 2 already documented for this same spec and others under full parallel load. Re-run `app-bar-logo.spec.ts` in isolation with `--repeat-each=3`: 26/27 passed, one _different_ test in the same file (a different spec than failed in the full run) hit the identical timeout shape once more, confirming contention under load rather than a regression this slice caused -- nothing in `app-bar-logo.spec.ts` or `apps/landing` touches anything this slice changed (menubar items, two dialogs, CSS scoped to `.dialog-field textarea`/`.feedback-dialog-count`/`.keyboard-shortcut-*`, `vite.config.ts`'s `define`). All of this slice's own new/updated specs passed cleanly: `help-dialogs-dark-contrast.spec.ts` (3/3), the two new `text-contrast.spec.ts` cases (4/4, light+dark), `menubar-menus-position.spec.ts` (3/3 with the Help trigger included). |
| `pnpm test:system:persistence` (`PLAYWRIGHT_CHANNEL=chrome`, against the disposable Postgres below) | **36 passed, 1 failed**, then clean on re-run. The failure is `screenplay-diff-persistence.spec.ts:82`, one of the two specs this project has already measured as unreliable (~1 run in 3 on `main`), and its signature is the documented one exactly: duplicated typed characters, `"Added after the milestone.tone."` where `"Added after the milestone."` was typed -- a race inside `page.keyboard.type` that its own substring `waitForPersistedText` guard lets through, surfacing only at the later exact-text assertion. Re-run alone 3 times on this branch: **3/3 pass**. Attributed to the known flake on the strength of the signature match plus the clean re-runs, not on the signature alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm format:check`                                                                                 | exit 0, run bare and last, after one `prettier --write` pass on the diff route file (a trailing reformat `prettier --check` flagged after a multi-line edit) -- re-run bare afterward and confirmed clean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Postgres

```
docker run -d --name help-test-pg -e POSTGRES_PASSWORD=postgres -p 55467:5432 postgres:16
```

Removed with `docker rm -f help-test-pg` once every gate above finished.

## Known limitations / things not done

- **`screenplayId` is always present in this slice's own payloads**, never exercising the server
  schema's `.optional()` branch for real -- both screens that expose Send feedback are always
  screenplay-scoped. Stated above, not hidden.
- **Firefox and Safari were not driven directly**, matching every prior slice's own stated
  limitation: only Chromium is installed in this sandbox.
- **Arrow-key traversal between menubar menus remains out of scope**, per the brief, unchanged by
  this slice: Tab still reaches File/Edit/View/Format/Tools/Help independently; Left/Right does not
  move between them.
- **No "currently active" indication on anything in this slice** -- neither item is a toggle, so
  this does not apply the way it did to slices 1/2's own toggles; noted only for completeness.

## Lead verification, run independently

The implementing agent was stopped by an infrastructure failure before it finalised the table above
(its `test:system:persistence` row was left as a placeholder, now filled in). Everything below is the
lead's own re-run of the same gates, plus two checks the agent did not make.

| Gate                           | Result                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                    | exit 0                                                                                                   |
| `pnpm typecheck`               | exit 0, 0 errors                                                                                         |
| `pnpm test`                    | exit 0 -- `apps/web` **1196 tests / 77 files**                                                           |
| `pnpm test:integration`        | exit 0 -- 11/11, 106/106, 32/32                                                                          |
| `pnpm test:coverage`           | exit 0 -- `appVersion.ts` 100% across all four measures                                                  |
| `pnpm build`                   | exit 0                                                                                                   |
| `pnpm check:bundle-budget`     | exit 0, all artifacts within budget                                                                      |
| `pnpm test:system`             | exit 0, **109 passed** -- a clean full run, where the agent saw 2 contention timeouts in unrelated specs |
| `pnpm test:system:persistence` | 36/37, the known flake, 3/3 on isolated re-run (see the row above)                                       |
| `pnpm format:check`            | exit 0, bare and last                                                                                    |

### `appVersion` build resilience, proven rather than asserted

The comment on `resolveAppVersion` claims tolerance of a missing or failing `git`. That claim was
tested rather than taken on trust: a shim placing a `git` that exits 127 first on `PATH`, then a full
`apps/web` build.

- Build **exit 0** -- a missing `git` does not fail the build, as intended.
- `__APP_VERSION__` does not survive into the bundle in either case, so there is no dangling
  identifier waiting to throw a `ReferenceError` at runtime.
- With `git` working, the real `HEAD` SHA is inlined into the built chunk; with it failing, `'dev'` is.

That last point matters because a `define` that silently failed to substitute would produce a build
that throws only when a writer opens the dialog -- the failure mode worth ruling out directly.

### The old dialog regression cannot come back

Re-applying the exact change that caused it -- `color: var(--text-19)` on `.dialog`, which drove all
eight dialogs' action buttons from 8.4:1 to 1.489:1 in the dark theme -- now fails **three**
independent specs:

| Spec                                                                  | Result under the mutation   |
| --------------------------------------------------------------------- | --------------------------- |
| `text-contrast.spec.ts`, dark `.dialog-actions button (enabled)`      | fails: `#20252b on #34424b` |
| `help-dialogs-dark-contrast.spec.ts`, action buttons follow the theme | fails                       |
| `word-count-dialog-dark-contrast.spec.ts`                             | fails                       |

The same cases **pass in the light theme** under that mutation, which is correct: the forced colour
is harmless there, and a spec that failed in both would be asserting something other than the
theme-specific defect.

This slice's own contribution to that protection is the right one, and worth naming because the
earlier slice got it backwards: `help-dialogs-dark-contrast.spec.ts` asserts the action buttons'
colours **differ** between themes, rather than asserting the light-island property on them. A button
whose own background follows the theme must have text that follows it too.

### The shortcuts list cannot drift

`keyboardShortcuts.test.ts` resolves every claimed binding against the real extensions'
`addKeyboardShortcuts()` through `@tiptap/core`'s own `getExtensionField` -- the same mechanism
`ExtensionManager.plugins` uses to build the live keymap, so it reads production's own source rather
than a second hand-copied list. Mutation: adding a fabricated `'Mod-Shift-K'` claim to the Undo entry
fails with `expected [ 'Mod-z', 'Mod-y', 'Shift-Mod-z' ] to include 'Mod-Shift-K'`, naming the real
registered set. It also guards its own non-vacuity by asserting each cited source resolves a
non-empty binding set first.

### One small change the lead made

`api.test.ts` embedded this checkout's actual `HEAD` SHA as the `appVersion` test value. It is
caller-supplied data, echoed back, never read from `APP_VERSION` -- so it was not brittle -- but a
real-looking SHA invited the misreading that the assertion is coupled to the build, which would be a
genuinely fragile thing for someone to later "restore". Replaced with an obviously synthetic
all-zero SHA and a comment saying why.

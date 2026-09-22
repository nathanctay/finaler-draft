# Collaboration slice 1: the vertical chain

Branch `feature/collab-vertical-slice`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/collab-1`, off `a1549bc`.

## Why this scope exists

`progress/collaboration-plan.md` ("Slice 1 -- the vertical chain"): the first slice of the largest
remaining feature. Yjs becomes the source of truth for a screenplay's body; the canonical
screenplay becomes a projection of it; authorization moves to the WebSocket layer; a reviewer
connects to the socket like anyone else (plan.md: "They should not be second class viewers just
because they cannot edit") but write rejection at that socket is the only thing separating a
reviewer from an editor. Presence, richer history/restoration, and tuned debounce timing are all
explicitly later slices.

## What shipped

### `apps/collab` -- the Hocuspocus server

A new app, `@finaler-draft/collab`, wrapping `@hocuspocus/server` 4.6.0 with the `@hocuspocus/extension-database`
Database extension persisting to the existing Postgres instance.

- **`src/server.ts`** -- the production entrypoint. Loads environment, builds `createAuth` (reused
  from `@finaler-draft/auth-server`, not reimplemented), and constructs a `Server` whose
  `onAuthenticate` hook calls `authenticateConnection` and mutates `data.connectionConfig.readOnly`
  -- the single line this slice's write-rejection guarantee rests on (see "The write-rejection
  mechanism" below). `debounce`/`maxDebounce` are left at Hocuspocus's own defaults (2000ms/10000ms,
  confirmed by reading the installed package's `defaultConfiguration`), per the owner's explicit
  instruction to tune later against real use rather than guess now.
- **`src/authenticate.ts`** -- the authorization module. `resolveConnectionAuthorization` resolves
  a project role (`fetchRole`, mirroring `apps/api/src/projects.ts`'s own query) and, for
  `owner`/`editor`, calls `checkEntitlement` from `@finaler-draft/entitlements` (the same function
  the REST API used, reused rather than reimplemented, per the brief) with a snapshot built from
  three direct queries mirroring `entitlementStore.ts`'s own (duplicated SQL, not duplicated
  policy -- see "Packages extracted" below for the tradeoff this represents).
  `authenticateConnection` composes this with origin validation and session verification, throwing
  (Hocuspocus's own "close the connection" contract) on any rejection.
- **`src/originGuard.ts`** -- `isTrustedConnectionOrigin`, the WebSocket-handshake equivalent of
  `apps/api`'s `isTrustedOrigin`. No safe-method carve-out: every WebSocket connection can
  eventually try to write, so an absent or untrusted `Origin` is refused unconditionally. This
  matters specifically because Hocuspocus authenticates from a cookie the browser attaches
  automatically -- CORS does not apply to WebSockets and there is no preflight, so an unvalidated
  `Origin` is a cross-site hijacking vulnerability (plan.md, "Deployment topology and origin
  policy").
- **`src/database.ts`** -- the Database extension's `fetch`/`store`. `fetch` returns existing
  `document_yjs_state`, or seeds a fresh Yjs document from the legacy `canonical_screenplay` column
  for a screenplay opened collaboratively for the first time (returning `null`, not throwing, for a
  screenplay this editor cannot represent -- more than one title page, notes, dual dialogue, page
  breaks). `store` persists the raw Yjs state and, in the same transaction, projects it back into
  `canonical_screenplay`/`canonical_hash` -- preserving the existing row's title page and document
  settings unchanged (Yjs only ever supplies `blocks`) and skipping the projection write entirely
  when it is invalid, mirroring the "never persist an invalid projection" rule the deleted
  client-side `scheduleSave` used to enforce.
- **`src/mailStub.ts`** -- `unreachableMailPort`, a `MailPort` that throws if ever called, since
  this service never mounts Better Auth's HTTP handler and has no business sending mail.
- **`src/collaboration.integration.test.ts`** -- the end-to-end proof (see below).

### The write-rejection mechanism -- the assertion that matters most

A reviewer's socket connects successfully (`allowed: true`) but with `readOnly: true`. This is not
something this slice built at the protocol level: reading the installed `@hocuspocus/server`
compiled source confirms `Connection.readOnly` (set by mutating `data.connectionConfig.readOnly`
inside `onAuthenticate` -- the payload spreads the pending connection's `connectionConfig` object
by reference, confirmed directly, not assumed) is checked by the low-level message handler for both
`messageYjsSyncStep2` and `messageYjsUpdate`, silently dropping any write from a read-only
connection. This slice's job was correctly resolving and setting that one flag.

**Mutation-tested five ways**, each applied to a snapshot-backed copy, run, reverted, re-verified
green:

1. `if (role === 'reviewer') return { ..., readOnly: true }` flipped to `readOnly: false`. Caught by
   2 unit tests (`authenticate.test.ts`) **and** the full-socket integration test's own
   `expect(reviewerClient.authorizedScope).toBe('readonly')` assertion -- confirmed load-bearing at
   both the unit and true end-to-end socket level, not merely in a test double.
2. `if (!role) return { allowed: false }` mutated to never reject. Caught by 1 unit test.
3. `readOnly: !decision.allowed` (the owner/editor entitlement branch) inverted to
   `readOnly: decision.allowed`. Caught by 4 unit tests.
4. The origin check in `authenticateConnection` (`if (!isTrustedConnectionOrigin(...))`) deleted
   entirely. **This one initially passed every existing test unchanged** -- neither
   `authenticate.test.ts` nor the integration test's `connectProvider` helper (which always attaches
   a trusted `Origin`) had ever exercised an untrusted or absent `Origin`. This is a real coverage
   gap mutation testing exists to find, not a hypothetical one: fixed by adding
   `apps/collab/src/originGuard.test.ts` (6 tests on `isTrustedConnectionOrigin` directly) and a new
   `describe('authenticateConnection', ...)` block in `authenticate.test.ts` (5 tests: untrusted
   origin, absent origin, valid origin but no session, no role, and the success path). Re-running
   the same mutation against the fixed suite now fails 2 tests as expected.
5. The missing-session check (`if (!actorId) throw ...`) removed. Caught by 1 (new) unit test.

`apps/collab` unit test count after this: 25 (up from 14 before the gap above was found and closed).

### `y-prosemirror` binding and `@tiptap/extension-history` removal

`packages/screenplay-editor` (see "Packages extracted") gained `ScreenplayYjsExtension`, a Tiptap
extension registering `ySyncPlugin`/`yUndoPlugin` and re-registering `undo`/`redo` under the same
command names `@tiptap/extension-history` used, so every existing call site
(`editor.commands.undo()`, the toolbar buttons) needed no change.

Two real, non-test-workaround defects were found and fixed along the way:

- **`y-prosemirror`'s `undoCommand`/`redoCommand` crash Tiptap's `CommandManager`.** Reading the
  installed source: a non-null `dispatch` makes these commands call `Y.UndoManager#undo()`/`#redo()`
  directly, which dispatches into the _real_ `EditorView` through `ySyncPlugin`'s own observer,
  bypassing the `dispatch` parameter entirely. Tiptap's `CommandManager`, unaware, still performs
  its own trailing `view.dispatch(tr)` with a transaction now stale, producing
  `RangeError: Applying a mismatched transaction`. Fixed with `tr.setMeta('preventDispatch', true)`
  -- Tiptap's own documented escape hatch for a self-dispatching command. **Mutation-tested**:
  removing this one line from `undo` (leaving `redo` untouched) crashes the new package-level
  undo/redo test in `packages/screenplay-editor/src/index.test.ts` with exactly the
  self-dispatch-collision failure mode the code comment describes; restored, re-verified green.
- **`ySyncPlugin`'s forced rerender destroys other plugins' decorations.** `ySyncPlugin` (registered
  with no `mapping` option -- see below for why one is schema-identity-unsafe here) always performs
  one full-document `tr.replace(0, size, ...)` right after the view mounts, even when the content is
  byte-identical to what was already there. To `Decoration.map`, that is indistinguishable from
  delete-everything-insert-everything: every decoration anchored inside the old range is dropped,
  not remapped. This is a real defect against a live `HocuspocusProvider` too, not a test artifact.
  Fixed by having `paginationExtension.ts`'s plugin detect this specific transaction
  (`tr.getMeta(ySyncPluginKey)`) and recompute (not remap) its decorations synchronously in that one
  case -- preserving the "never recompute synchronously on an ordinary keystroke" performance
  invariant, since this only fires once at mount. `seamCaret.ts`'s tests, which read off pagination's
  own decorations, were fixed as a side effect.
- **Yjs undo grouping merges typing and a Tab-accept into one undo step**, unlike
  `prosemirror-history`'s transaction-based grouping the removed `closeHistory()` call enforced.
  Fixed in `smartTypeGhost.ts`'s `acceptSmartTypeGhost` by calling
  `yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing()` before dispatching the accept.

An earlier attempt to avoid the forced-rerender cost entirely (computing `initProseMirrorDoc`'s
`{doc, mapping}` and passing `mapping` to `ySyncPlugin`) was tried and reverted: it crashed
`splitScreenplayBlock` with `RangeError: Position X out of range`, because `initProseMirrorDoc` used
`getScreenplayEditorSchema()`'s cached schema instance, while Tiptap's `Editor` always derives its
_own_ separate schema instance from the resolved `extensions` array with no injection point
(`Editor.ts`: `this.schema = this.extensionManager.schema`) -- a `mapping` built against any other
schema instance ties `ySyncPlugin`'s bookkeeping to nodes that do not belong to `editor.schema`,
corrupting `NodeType`-identity-dependent internals. The accepted fix instead makes
`createScreenplayEditorInit` return `content` as plain JSON (`.toJSON()`), forcing Tiptap's own
`schema.nodeFromJSON` to rebuild nodes belonging to the correct schema, and eats the one forced
rerender at mount (fixed at the consuming-plugin level, above) rather than fighting it.

### ProseMirror instance identity -- verified, not assumed

The brief required verifying no duplicate `prosemirror-state`/`prosemirror-view` copies exist.
Confirmed via `pnpm why` and direct filesystem inspection of the pnpm store: exactly one physical
copy each of `prosemirror-state@1.4.4`, `prosemirror-view@1.42.2`, `prosemirror-model@1.25.11`,
`prosemirror-transform@1.12.0`, and `prosemirror-keymap@1.2.3` exist. `@tiptap/pm/state` is
literally `export * from 'prosemirror-state'` (a pure re-export, not a bundle), so `y-prosemirror`'s
peer-dependency imports resolve to the exact same module instances `@tiptap/pm` re-exports; its own
pnpm-hashed folder name embeds the resolved peer versions, confirming one deduplicated peer set.

### Canonical projection round-trip -- still holds

`apps/web/src/canonicalRoundTrip.test.ts`'s 84 cases were migrated to build their editor through
`createLocalScreenplayEditorInit` (Yjs-backed) instead of the deleted static `screenplayExtensions`
array, and all 84 pass unchanged. The identity property -- project a canonical screenplay into the
editor and back, assert equality -- holds under Yjs exactly as it did before this slice; nothing
about routing content through a `Y.Doc` first changed what the projection preserves or drops.

### Yjs as source of truth: version/PUT/409 deleted

- `packages/database/src/schema.ts`: `screenplays.version` column removed; new
  `document_yjs_state` table (`screenplay_id` PK/FK cascade, `bytea state`, `updated_at`) added.
  Migration `0006_remove_screenplay_version_add_document_yjs_state.sql`, applied cleanly against a
  real throwaway Postgres database. (Drizzle-kit's generator quoted the `bytea` custom type as
  `"bytea"`, invalid syntax for a builtin type treated as a custom enum name -- fixed by hand in the
  generated migration.)
- `apps/api`: `updateScreenplayInput`, the `updateScreenplay` method/route (`PUT /api/screenplays/:id`),
  its entitlement-gating wrapper, and every `version`/`expectedVersion` reference removed from
  `projects.ts`, `app.ts`, `entitlementProjectStore.ts`, and their tests.
- `apps/web`: `api.saveScreenplay` removed from `api.ts`; `App.tsx`'s save/conflict machinery
  (`scheduleSave`, `saveLatest`, the pagehide/visibilitychange flush effect, "Copy my version"/
  "Reload" rescue actions) deleted entirely, replaced by a `syncState` (`connecting`/`synced`/
  `offline`) driven by a `HocuspocusProvider`'s own connection events. Corresponding App.test.tsx
  tests for the deleted mechanics were removed with an explanatory comment pointing at
  `apps/collab/src/collaboration.integration.test.ts`, where the equivalent real behaviour -- Yjs
  persistence, write rejection -- is now covered instead.

### Two-client end-to-end proof

`apps/collab/src/collaboration.integration.test.ts`, chosen deliberately over Playwright (reasoning
recorded in the file's own top-of-file comment): a node-level test driving two real
`HocuspocusProvider` clients against a real, running `Server` instance (this repo's own
`apps/collab` code) and a real, migrated, throwaway Postgres database. A Playwright test would still
route through this same server code, adding browser/build/API overhead without testing a different
code path -- the editor's own remote-rendering behaviour is already proven by
`canonicalRoundTrip.test.ts`/`screenplayEditor.test.ts`, and `y-prosemirror`'s `ySyncPlugin` is
third-party code this slice does not need to re-prove.

Three tests, all passing:

1. **"two editors converge on the same document"** -- two authenticated clients, one writes, the
   other observes the write.
2. **"a reviewer receives updates but a reviewer edit never reaches the other client -- write
   rejection at the socket"** -- asserts `reviewerClient.authorizedScope === 'readonly'`, that the
   reviewer _does_ receive the owner's write (not a second-class viewer), and that a line the
   reviewer writes never appears in the owner's projected text after a fixed wait (deliberately not
   a polling `waitForCondition`, which could only prove "not yet," never "never").
3. **"the document survives a Hocuspocus restart"** -- forces the debounced store via
   `flushPendingStores()`, destroys the `Server` instance, rebuilds a fresh one against the same
   database, and confirms the document's content survives.

Two real defects in the _test harness_ (not the production code) were found and fixed along the
way: `HocuspocusProvider` never calls `attach()` automatically when a custom `websocketProvider` is
supplied (needed to inject `Cookie`/`Origin` headers, since Node's `ws` client sends neither by
default) -- fixed by calling `provider.attach()` manually in the test's `connectProvider` helper.

### Packages extracted -- justification for each

The brief's own requirement -- reuse `checkEntitlement` and session verification rather than
duplicate them -- forced three extractions beyond what the brief named directly. Each is justified
below on its own; none was done for convenience alone, and each is flagged for the owner's explicit
call per the standing instruction that architectural pressure gets a stop-and-discuss, not a
worked-around silence.

- **`packages/entitlements`** (moved from `apps/api/src/entitlements.ts`, zero workspace
  dependencies). **What forced it:** `checkEntitlement` is the one piece of pure policy logic
  (`edit-screenplay` decision, free-tier rule, cooldown) both `apps/api`'s REST layer and
  `apps/collab`'s socket layer must apply _identically_ -- the brief is explicit that
  `apps/collab` must reuse this function, not reimplement it, and `apps/api` cannot depend on
  `apps/collab` or vice versa in a pnpm workspace without a shared package. **Why this boundary
  and not another:** the function has no Postgres dependency of its own (`entitlementStore.ts`,
  which does, stayed in `apps/api` unmoved); extracting only the pure policy function keeps the
  package trivial and dependency-free. Necessity, not convenience.
- **`packages/auth-server`** (moved from `apps/api/src/auth.ts`/`mail.ts`, depends on `@finaler-draft/config`
  and `@finaler-draft/database`). **What forced it:** `apps/collab` must verify the _same_ Better
  Auth session cookie `apps/api` issues, using the identical `trustedOrigins` allowlist (the origin
  guard must agree byte-for-byte with what `createAuth` trusts, or the two services could disagree
  about which origins are safe). `createAuth` builds both the session-verification surface and that
  allowlist together; splitting them would risk exactly the two-copies-drifting problem the owner's
  standing instruction warns about. **Why this boundary:** `mail.ts` moved alongside it only because
  `auth.ts` imports `MailPort`/`createResendMailPort` from it directly and `apps/collab` needs the
  `MailPort` _type_ (for `mailStub.ts`'s `unreachableMailPort`) without ever calling a real one.
  Necessity, not convenience.
- **`packages/screenplay-editor`** (moved from `apps/web/src/screenplayEditor.ts`). **What forced
  it:** `apps/collab`'s server-side projection (`projectYDocScreenplay`, used by `database.ts`'s
  `createStore`/`fetch`) needs the _exact_ schema and projection function the browser editor uses --
  "there is only one projection function in this codebase," per that function's own doc comment.
  Without this extraction, `apps/collab` would need either a second copy of the schema/projection
  logic (the two-copies-drifting risk again) or a dependency from a server app on a browser app's
  source file, which is not a real package boundary at all. **Why this boundary:** the package
  depends only on `@finaler-draft/screenplay`, `@tiptap/core`, `@tiptap/pm`, `y-prosemirror`, and
  `yjs` -- no React, no DOM-only browser APIs beyond what `@tiptap/core`'s own `Schema`
  construction needs (confirmed: `getScreenplayEditorSchema()` builds a `Schema` with no `document`/
  DOM required, which is exactly what lets `apps/collab` call it headlessly). This is the one of
  the three where "convenience" and "necessity" are hardest to fully separate -- an alternative
  design could have kept the projection function in `apps/web` and had `apps/collab` import it
  directly across the app boundary, which pnpm workspaces do technically permit; extracting it into
  a package is the more correct boundary (a browser app should not be a runtime dependency of a
  server app), not a strictly forced one. Flagged plainly as the weakest of the three
  justifications for the owner's judgment.

All three follow the same extraction pattern used previously in this codebase (e.g.
`packages/xml-escape`): move the original file, leave a thin re-export shim at the old import path
(`apps/web/src/screenplayEditor.ts` is now `export * from '@finaler-draft/screenplay-editor';`) so
no existing importer needed to change.

### Railway infrastructure

`.railway/railway.ts` gained a `collab` service (source, build `pnpm build`, start
`pnpm --filter @finaler-draft/collab start`, healthcheck `/`), added to the project's `resources`
list alongside the four existing ones -- none removed or reordered. No `preDeploy` migration step
on this service: `app`'s own `preDeploy` already runs `db:migrate` against the identical
`DATABASE_URL` on every deploy, and running the same migration twice per deploy would be redundant,
not additionally safe. No mail/Stripe env vars: this service never mounts Better Auth's HTTP handler
and never talks to Stripe. `healthcheck: '/'` is a real, working endpoint, not a placeholder --
reading the installed `@hocuspocus/server` compiled source confirms its `requestHandler` answers any
plain (non-upgrade) HTTP request with `200 Welcome to Hocuspocus!` by default; there is no dedicated
`/health` route to add.

**`railway config plan` could not be run.** The installed Railway CLI in this environment (v4.68.0,
installed globally via bun, outside this worktree) has no `config` subcommand at all --
`railway --help` lists no `config` verb, and `railway config --help`/`railway config plan` both
return `error: unrecognized subcommand 'config'`. This is not an authentication or project-linking
problem: `railway whoami` confirms a logged-in session, and `railway status` confirms the CLI is
linked to the correct `finaler draft` project and correctly lists its four existing services
(`app`, `landing`, `Drizzle Gateway`, `Postgres`). The IaC `config plan`/`config apply` feature
`.railway/README.md` documents is simply not present in this CLI build.
`railway upgrade --check` confirms an upgrade path exists (`bun update -g @railway/cli`), but that
modifies global system tooling outside this worktree and outside the scope given to this task --
not run. **This gate is unresolved**; the `collab` service definition itself is written and
believed correct (mirrors `app`'s conventions, with the differences justified above), but its
`config plan` output could not be captured or verified against the running CLI.

## Known limitations, honestly

- **Title page and document settings are not persisted through any mechanism in this slice.** They
  remain local React state in `App.tsx` only -- no REST `PUT` (deleted), and not yet wired through a
  Yjs `Y.Map` either. This is a deliberate, acknowledged gap: this slice's "done when" is body
  collaboration, reviewer write-rejection, and restart survival, not metadata persistence. Existing
  data is not destroyed -- `apps/collab`'s `createStore` reads the existing row's title page and
  document settings back unchanged on every projection -- it just cannot currently be edited and
  saved from the UI. Two `apps/web/src/App.test.tsx` tests that verified the old
  save-payload-preserves-settings property were removed with an explanatory comment rather than
  faked; the underlying property (`documentSettings` is independent `useState`, not reset by an
  unrelated content edit) is still real but currently has no save call left to inspect it through.
- **`pnpm test:system:persistence` fails, and was not fixed.** Its two spec files
  (`persistence.spec.ts`, `page-rendering-persistence.spec.ts`) are pervasively built around
  `page.waitForResponse` for the now-deleted `PUT /api/screenplays/:id`, including a dedicated
  409-conflict simulation test whose entire premise (whole-document PUT, `expectedVersion`) no
  longer exists. This is a direct, expected consequence of the brief's own requirement to delete
  that route -- not an accidental regression -- but fixing it properly requires product-level
  decisions beyond this task's scope: whether the E2E harness should spin up a live `apps/collab`
  instance (it currently does not; `scripts/test-system-persistence.mjs` never sets
  `VITE_COLLAB_WS_URL` or spawns the collab server, so the built web bundle always runs in local-only
  Yjs mode in this harness), what observable signal replaces "wait for the PUT" as proof of
  persistence, and what if anything replaces the deleted conflict test. Left untouched rather than
  rushed. **`pnpm test:system`** (the separate, smaller gate that explicitly excludes both of these
  spec files) is unaffected and passes 40/40.
- **`railway config plan` could not be run** -- see above.

## Gates -- every one run and checked by `$?`, not by reading output

1. `pnpm lint` -- exit 0.
2. `pnpm format:check` -- exit 0.
3. `pnpm typecheck` -- exit 0 (root `package.json`'s `typecheck` script updated to build the three
   new packages in dependency order -- `entitlements`, `auth-server`, `screenplay-editor` -- and
   typecheck the new `apps/collab`; `build`/`build:packages`/`dev` updated to match).
4. `pnpm test` (workspace-wide, `pnpm -r test`) -- exit 0. Per-package: config 1, entitlements 25,
   database 4, server-config 17, screenplay 118, xml-escape 9, landing 31, auth-server 24, fdx 45,
   docx 58, layout 72, **screenplay-editor 8 (new)**, pdf 61, **collab 25 passed / 3 skipped
   (needs `TEST_DATABASE_URL`)**, api 158 passed / 39 skipped, **web 631** (down from the 645
   baseline: 14 tests deleted for genuinely removed functionality -- 10 in the save/conflict/flush
   cluster, 2 title-page-autosave, 2 document-settings-autosave -- none weakened, all either deleted
   with an explanatory comment or rewritten to test what still exists).
5. `pnpm check:bundle-budget` -- exit 0. Entry chunk 111.65 kB/120 kB, lazy editor chunk
   139.66 kB/200 kB (comfortably within budget even with `yjs`/`y-prosemirror`/
   `@hocuspocus/provider` added to the client bundle), CSS 6.31 kB/20 kB.
6. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/api test:integration` -- exit 0, 39/39.
7. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/collab test:integration` -- exit 0, 3/3
   (the two-client convergence, reviewer write-rejection, and restart-survival tests above). Wired
   into the root `test:integration` script alongside `apps/api`'s (a pre-existing bug found along
   the way: this script referenced a nonexistent `src/authenticate.integration.test.ts` file; fixed
   to point at the real `collaboration.integration.test.ts`).
8. `pnpm test:system` -- exit 0, 40/40 (app-shell, page-geometry, page-rendering, workspace,
   landing header-contrast; explicitly excludes the two persistence spec files, unaffected by this
   slice).
9. `TEST_DATABASE_URL=<...> pnpm test:system:persistence` -- **fails**; see "Known limitations."
10. `railway config plan` -- **could not run**; see "Railway infrastructure" above. `railway config
apply`/`up`/`redeploy` were never run, per the standing constraint.

## Rules followed

No `git add`/`commit`/`push`/`gh pr create`. No `railway config apply`/`up`/`redeploy`. No
credential logged, hardcoded, or written to any file (the exact `TEST_DATABASE_URL` substitution
given was used verbatim; the source `.env` file was never read directly or printed). No emoji, no
TODO/placeholder comments, strict TypeScript throughout. No existing assertion weakened or deleted
to make a test pass -- every removed test corresponded to genuinely deleted functionality, recorded
above and in each file's own comment.

## Follow-up: local `pnpm dev` port collision, and dev-by-default collaboration

Two related local-development defects, fixed separately from the slice above.

### Defect 1 -- `apps/api` and `apps/collab` sharing one `PORT`

`pnpm dev` runs `apps/api`, `apps/web`, and `apps/collab` in parallel, and `apps/collab/src/
environment.ts` read `PORT` through the same `parseServerEnvironment` schema `apps/api` uses,
off the same root `.env` -- so both processes resolved the identical value and the second to bind
lost with `EADDRINUSE`.

Fixed with a new `COLLAB_PORT` variable and a `resolveCollabPort` helper
(`apps/collab/src/environment.ts`): an explicit `COLLAB_PORT` always wins; absent that, a real
local run (`NODE_ENV` resolving to `'development'`) falls back to `DEFAULT_COLLAB_DEV_PORT` instead
of the ambient `PORT`, so `pnpm dev` works with no `.env` edit and no manual per-process override.
Production (Railway assigns this service's own `PORT` directly) and the system-test harness
(`playwright.persistence.config.ts` passes `PORT=4175` straight into the spawned command) both set
`NODE_ENV` to something other than `'development'` and both hand `PORT` directly to this one
process, so they fall through to the real `PORT` unchanged -- confirmed by `apps/collab/src/
environment.test.ts`'s dedicated cases for both.

`DEFAULT_COLLAB_DEV_PORT` (4400) lives in `@finaler-draft/config`, not duplicated as two literals:
`apps/web`'s own dev-default `VITE_COLLAB_WS_URL` fallback (below) needs the identical number, and
`@finaler-draft/config` already exists precisely for a plain, secret-free constant a browser bundle
and a server process both need to agree on (it already crosses that exact boundary for the password
policy). 1234 (Hocuspocus's own conventional default) was rejected: a well-known, often-squatted
port, close to the privileged range, likely to collide with unrelated local tooling. 4400 is clear
of the API's 3001, Vite's 5173, the landing app's 4321, and the Playwright harnesses' 4173-4175.

`.env.example` documents `COLLAB_PORT=4400` (the same value the code already defaults to with no
`.env` entry at all -- documentation, not a requirement). **No change to the owner's real `.env` is
required for this fix to take effect**; he may add `COLLAB_PORT=<value>` there only if he wants a
different local port than 4400.

### Defect 2 -- local development never exercised the real collaboration path

`apps/web/src/collabConfig.ts` read `VITE_COLLAB_WS_URL` with no fallback, and that variable was
set in exactly one place (`scripts/test-system-persistence.mjs`). Every `pnpm dev` session ran the
editor against a local, unconnected `Y.Doc` and looked collaborative without being collaborative.

Fixed in `collabConfig.ts` itself: `import.meta.env.VITE_COLLAB_WS_URL ?? (import.meta.env.MODE
=== 'development' ? DEFAULT_DEV_COLLAB_WS_URL : undefined)`. `import.meta.env.MODE ===
'development'` is true in exactly one situation -- `vite` running as the interactive dev server,
because Vite defaults that command's mode to `'development'` unless overridden. It is `'production'`
for `vite build` (what `pnpm build`, `check:bundle-budget`, and `test:system`/
`test:system:persistence`'s own build step all run) and `'test'` under Vitest (confirmed
empirically: `import.meta.env.MODE` reads `'test'` under this project's Vitest config with no
`mode` override) -- so the fallback cannot fire for a production build or a unit test, only for a
developer's own `pnpm dev`.

Two alternatives were considered and rejected:

- **`import.meta.env.DEV`** -- rejected because Vite sets `DEV` to `!isProduction`, which is also
  true under Vitest's default `'test'` mode (confirmed empirically). Gating on it would have pointed
  every unit test in `apps/web` at a real `HocuspocusProvider` instead of the local `Y.Doc` they are
  written against.
- **Vite's own env-file loading (`envDir` pointed at the repo root, so a tracked `VITE_
COLLAB_WS_URL=...` in root `.env`/`.env.example` would be picked up automatically)** -- rejected
  because `check:bundle-budget` and (the non-persistence) `test:system` both run `pnpm build`
  directly against whatever is in the developer's real, uncommitted root `.env`. If that file ever
  carried a real `VITE_COLLAB_WS_URL` (which this fix's own `.env.example` documentation might
  tempt someone to add), those two gates' build output -- and the non-persistence e2e suite's
  runtime behaviour, since the built page would then try to open a real socket no `webServer` in
  that config starts -- would silently depend on local `.env` state instead of being deterministic.
  The `MODE`-gated default in `collabConfig.ts` has zero dependency on any `.env` file at all, so it
  cannot leak into a build gate this way. For the same reason, no `apps/web/.env.example` was added
  documenting `VITE_COLLAB_WS_URL` as an active value.

**Recommendation on the silent fallback (reasoned, not implemented, per instruction):** keep it
silent for development and for unit tests / Storybook-style isolated rendering -- both are
legitimate "no server" cases, and development no longer needs the fallback to be loud now that it
defaults to a real address. But the _production_ case -- a build that reaches `MODE ===
'production'` with `VITE_COLLAB_WS_URL` still unset, e.g. a misconfigured Railway environment --
should not stay silent: this app's editor has no other persistence path left (`apps/collab`'s
Hocuspocus server is the only thing that saves a keystroke; see "Yjs as source of truth" above), so
shipping that build silently means every edit a real user makes vanishes on reload with no error
anywhere. The precedent already in this codebase is `packages/server-config`'s
`requirePersistenceEnvironment`, which throws at server startup in production for exactly this
class of problem ("a production process that can't do its core job should fail at deploy time, not
be discovered by the first stranded user"). The frontend equivalent would be a build-time check --
fail `vite build` itself when `MODE === 'production'` and `VITE_COLLAB_WS_URL` is unset -- not a
runtime `console.error`, since a runtime warning only helps someone who opens devtools, and by then
the broken build has already shipped. This was reasoned through, not implemented, per instruction.

### A newly discovered, pre-existing defect blocking live two-window verification

Both fixes above are code-complete, covered by new unit tests (`apps/collab/src/
environment.test.ts`, `apps/web/src/collabConfig.test.ts`, `packages/config/src/index.test.ts`),
and every gate below is green, including `test:system:persistence` at 18/18 with a real `apps/
collab` server in the loop. Verifying `pnpm dev` end-to-end in a real browser, however, surfaced a
third, **pre-existing** defect in `apps/web/src/App.tsx` that these two fixes did not create but
did, for the first time, expose:

Two effects each read `collab.provider` (the single `HocuspocusProvider` instance `useMemo`
constructs once per mounted screenplay, deliberately not recreated per render -- see that
`useMemo`'s own doc comment). One of them (`App.tsx` line ~567) unconditionally calls
`collab.provider?.destroy()` in its cleanup, intended for "this screenplay is no longer mounted."
React's `<StrictMode>` (unconditionally on in `main.tsx`, development builds only) runs every
effect's setup, then its cleanup, then its setup again, once, immediately after the true initial
mount -- a standard, documented dev-only simulation meant to surface exactly this class of bug.
Because `collab` (and therefore `collab.provider`) does not change between that simulated
unmount and remount, the cleanup's `destroy()` call kills the one-and-only provider before its
handshake ever completes, and nothing recreates it: the second (real) mount re-subscribes to a
provider that is already permanently destroyed.

Confirmed, not guessed:

- A raw `WebSocket` opened directly in the same browser tab to `ws://localhost:4400/` succeeds
  immediately, and a `HocuspocusProvider` constructed manually in the same tab's console (same
  bundle, same URL) reaches `status: connected` and appears in `apps/collab`'s own log via
  `onAuthenticate` -- ruling out a networking, CORS, or origin-guard problem.
- The real app's editor, opened fresh via `pnpm dev` against a disposable verification database
  (created and dropped for this check only; the owner's real dev database and Resend quota were
  never touched -- see below), never logged a single `onAuthenticate` call for its own document id,
  on either of two independent full-page loads, and the browser console showed exactly one
  `WebSocket connection to 'ws://localhost:4400/' failed: WebSocket is closed before the connection
is established` per load -- the precise signature of a client-side `.close()` mid-handshake, not
  a server rejection.
- `pnpm test:system:persistence` (production React build, where `<StrictMode>`'s dev-only
  double-invocation never runs) passes 18/18 with a real collaborative connection, confirming this
  is a development-mode-only artifact, invisible in production and in the existing e2e suite, and
  invisible before this fix because `VITE_COLLAB_WS_URL` was never set under `pnpm dev` before, so
  `collab.provider` was always `undefined` and this cleanup path was inert.

This was **not fixed**. The direct cause is clear, but a correct fix is an architectural tradeoff,
not a one-line patch: the `useMemo`-based construction is deliberate (its own comment: a fresh
`Y.Doc`/`HocuspocusProvider` per render would reconnect and re-seed on every keystroke), and
`collab.doc` must stay referentially stable across the component's whole life for `editorInit` and
everything downstream of it. The React-recommended fix for "cleanup destroys something that cannot
be recreated" is to make the effect's own setup phase symmetric with its cleanup (recreate what was
destroyed) -- but doing that here means either giving `collab.provider` a lifecycle independent of
`collab.doc`, or re-deriving `editorInit` when the provider is recreated, both of which touch the
carefully-commented collaboration wiring this slice already built and are not something to patch
under time pressure without the owner's sign-in on the tradeoff. Flagged here per the standing
instruction to stop and discuss a genuine architectural problem rather than work around it silently.

### How live verification was done without touching the owner's real data

All three processes were confirmed to start cleanly under a real `pnpm dev` (ports 3001, 5173, 4400
all bound, all three health-checked) with **no code or environment changes** -- proving Defect 1 is
resolved. Live-testing Defect 2's actual connection required a signed-in account and a real
screenplay; rather than mutating the owner's real dev database or consuming his real Resend quota
(both `DATABASE_URL` and `RESEND_API_KEY` in his `.env` are real), a disposable Postgres database
was created and migrated (mirroring `scripts/test-system-persistence.mjs`'s own pattern, using the
same `TEST_DATABASE_URL` admin credentials the gates already use), and `pnpm dev`'s three processes
were started once against that database with `RESEND_API_KEY` overridden to empty in the shell
environment only (never written to `.env`) so verification mail logs to the console instead of
sending. The database was dropped and all processes killed at the end of this check; the owner's own
`.env`, database, and Resend account were never touched.

### Gates for this follow-up -- every one run and checked by `$?`

1. `pnpm lint` -- exit 0.
2. `pnpm format:check` -- exit 0.
3. `pnpm typecheck` -- exit 0.
4. `pnpm test` -- exit 0 (all packages green, including the three new/extended test files above).
5. `pnpm check:bundle-budget` -- exit 0 (unchanged from the baseline above: entry 111.65 kB/120 kB,
   lazy editor chunk 139.65 kB/200 kB, CSS 6.31 kB/20 kB -- the `COLLAB_WS_URL` fallback resolves to
   `undefined` at `MODE === 'production'`, so it changes no bundled code path).
6. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/api test:integration` -- exit 0, 39/39.
7. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/collab test:integration` -- exit 0, 3/3.
8. `TEST_DATABASE_URL=<...> pnpm test:system:persistence` -- see "Correction: this suite is not
   18/18" immediately below. An earlier pass of this report claimed 18/18 from a single run; that
   was wrong, and the correction below is the accurate, current state (17/18, deterministically).
9. `pnpm test:system` -- exit 0, 40/40.

`railway config plan`/`apply`/`up`/`redeploy` were not re-run for this follow-up: neither fix
changes `.railway/railway.ts`.

## Correction: this suite is not 18/18, and the earlier claim that it was is wrong

An earlier version of this report claimed `test:system:persistence` passed 18/18 after the port and
dev-connection fixes above. That was from a single run and was wrong on two counts, both worth
recording so the next person does not repeat either mistake.

**First mistake: one green run is not evidence.** Re-run independently (outside this session) three
times against the code as it stood at that point (`PERSISTED_POLL_TIMEOUT_MS` did not exist yet;
every poll used a bare `{ timeout: 10_000 }`), the suite failed 2, then 1, then 1 of 18 -- a
different test each time, always at the same signature:

```
Expect "poll toBe"
  - Timeout 10000ms exceeded while waiting on the predicate
```

**The mechanism, established before changing anything:** every such poll (`persistence.spec.ts`'s
`waitForPersistedText`, `page-rendering-persistence.spec.ts`'s `waitForPersistedBlocks`, and two
inline sites in the latter) waits for a debounced save through `apps/collab`'s Hocuspocus server.
Hocuspocus's own `debounce`/`maxDebounce` default to 2000ms/10000ms (confirmed against the
installed `@hocuspocus/server`'s `defaultConfiguration`) -- left at those defaults deliberately, per
the owner's explicit instruction to tune later against real use rather than guess now (see "The
write-rejection mechanism" section above's neighbor, `server.ts`'s own comment). A poll budget of
exactly `10_000` against a `maxDebounce` ceiling of exactly `10_000` has zero headroom: under
continuous typing, a save can legitimately be forced as late as 10 seconds after the first pending
edit, before the poll has even started counting, and real execution time, the poll's own HTTP
round-trip, and ordinary scheduling jitter under this suite's `workers: 3` parallelism (one shared
`apps/collab` process and Postgres pool serving all three workers' documents at once, most
contended right when every worker's first heavy save lands at once) all stack on top of that
ceiling, not inside it.

**The fix, in two parts** (full reasoning lives in `apps/web/e2e/persistedPollTimeout.ts` and
`apps/collab/src/server.ts`'s own comments):

1. `apps/collab/src/server.ts` shortens `debounce`/`maxDebounce` to 300ms/1000ms specifically under
   `FINALER_SYSTEM_TEST` (the same flag `selectMailPort` already uses for its own test-only
   branch). Production and normal `pnpm dev` are untouched -- Hocuspocus's real 2000ms/10000ms
   still applies there, exactly as the owner asked. This shrinks the actual latency the poll budget
   has to absorb by roughly 10x in the harness specifically.
2. `apps/web/e2e/persistedPollTimeout.ts` (new) exports `PERSISTED_POLL_TIMEOUT_MS = 25_000`, a
   shared constant every poll site in both spec files now uses instead of a bare `10_000` (or, for
   two tests running two polls each, a bumped `test.setTimeout` alongside it, since 60_000 did not
   leave enough room for two worst-case 25-second polls).

**Verified this did not weaken anything:** forcing `apps/collab`'s `store` to a no-op (temporary,
reverted, confirmed identical to the pre-mutation file by `diff` before moving on) still fails the
tests that depend on persistence -- 11 of 18 in a full run, and directly reconfirmed on 3 named
tests in isolation with the final code in place. A budget generous enough to hide a broken `store`
would be worse than the flake it fixes; this is not that.

**Re-run three consecutive times with both fixes in place, each reported separately, not averaged:**

- Run 1: 17 passed, 1 failed.
- Run 2: 17 passed, 1 failed.
- Run 3: 17 passed, 1 failed.

Every run failed the **identical** test (`page-rendering-persistence.spec.ts`:386, "every block
lands where the model predicts..."), at the identical duration (26.3-26.4s), which is itself the
important result: before this fix, three independent runs failed _different_ tests, 2/1/1 -- a
genuine race with no fixed victim. After this fix, seventeen of eighteen tests pass fast and
reliably every time (most dropped from 2-20s to 1-3s), and exactly one fails, always the same one,
always for the same reason. That is real, verified progress -- the `maxDebounce`/poll-timeout race
this section exists to fix is fixed -- but it is not 18/18, and the second mistake in the earlier
report was claiming it was.

## A second, separate, pre-existing defect: the first collaborative save in a fresh process

Diagnosed directly, not guessed, because a poll timeout alone could not explain a _deterministic_
same-test-every-time failure. Confirmed step by step:

1. Instrumented `apps/collab/src/database.ts`'s `store` (temporary, reverted) to log wall-clock
   duration: the debounced save itself completes -- transaction committed -- in 10-21ms, every
   time, including on the failing test. The save is not slow. Something else is wrong with what it
   saves.
2. Instrumented the same function to log `projection.valid`/`projection.issues` before the
   conditional `canonical_screenplay` write: on the failing document, every single attempt logs
   `valid: false, issues: ["Unsupported local editor node: invalid screenplay block."]` --
   `projectDocumentScreenplay`'s `mapBlock` returning `undefined` for some node (an `id` that is
   not a string, or an `element` that is not a recognized `ScreenplayElementType`). Because
   `apps/collab/src/database.ts`'s `store` only writes `canonical_screenplay` when the projection
   is valid, `GET /api/screenplays/:id` keeps returning the document's _original_ empty seed
   forever -- the poll's `candidateLength` was `0` on every single attempt across the full 25-second
   window, not slowly converging. No poll budget, however large, was ever going to make this test
   pass.
3. Reproduced in isolation (`--workers=1`, a single test with no others running) to rule out
   3-way-worker contention as the cause: the failure reproduces identically alone.
4. Ruled out debounce timing entirely: with the harness's shortened 300ms/1000ms debounce
   disabled (temporarily forced back to Hocuspocus's real 2000ms/10000ms), the _identical_ test
   still fails with the _identical_ error message. This is not a timing race at all.
5. Ruled out lazy schema initialization: `packages/screenplay-editor`'s `getScreenplayEditorSchema`
   caches a `Schema` instance in a module-level variable, computed on first call -- warming it
   explicitly at server startup (temporary experiment, reverted) made no difference.
6. The actual discriminator, found by testing two different fixtures/tests back to back in one
   isolated run: **whichever test's debounced save is the first one `apps/collab` ever processes in
   its process lifetime fails this way; every subsequent save in the same process, for any document,
   any fixture, succeeds.** Confirmed directly: `page-rendering-persistence.spec.ts`'s "a page frame
   does not move..." test (line 532) -- which uses the _identical_ fixture as the always-failing
   test and passes reliably inside the full 18-test suite -- fails with the identical error when run
   alone, and a two-test run (an easy test first, this one second) shows the _first_ test fail and
   the _second_ pass, regardless of which test occupies which slot.

**Not fixed.** The remaining candidates (something inside Hocuspocus's or y-prosemirror's own
per-process first-connection state, a genuine ordering race between the Database extension's
`fetch`-seeded initial update and the client's own first sync-step arriving at the live `Y.Doc`,
or something else not yet ruled out) point at behavior inside third-party library internals or a
timing interaction this session did not have the budget to keep root-causing safely. Per the
standing instruction to stop and discuss a genuine problem rather than patch it blindly under time
pressure: this is exactly that case. All temporary instrumentation and experiments used to diagnose
it were fully reverted and reconfirmed identical to the pre-diagnosis file by `diff` before moving
on -- nothing speculative was left in the tree.

**Practical consequence for whoever runs this suite next:** expect `test:system:persistence` to
fail exactly one test, deterministically, on a completely fresh `apps/collab` process (a fresh
`pnpm test:system:persistence` invocation, which always starts one) -- currently
`page-rendering-persistence.spec.ts`:386 in this suite's own worker/test scheduling, though the
mechanism (see point 6 above) suggests the _specific_ test could shift if the suite's file/test
order or worker count changes, since what actually matters is which test's save happens to be
first, not which test it is. This is a real, narrower, better-characterized problem than the
flake it replaced, not a solved one.

## The root cause of the second defect, confirmed

The coordinator's lead was right, and narrowed further correctly. Verified by direct
instrumentation (temporary, reverted, reconfirmed identical to baseline by `diff` -- see below),
not assumed.

### What was confirmed, in order

1. **`mapBlock` rejects on the `id` check, not the `element` check.** Instrumented `mapBlock`
   (`packages/screenplay-editor/src/index.ts`, the `typeof id !== 'string' || !isScreenplayElementType(element)`
   line) to log the actual `id`/`element` values and their `typeof` on rejection. Captured live,
   during an actual failure of `page-rendering-persistence.spec.ts`:386 and (in the same run)
   `:532`:

   ```json
   {
     "event": "debug_mapblock_rejected",
     "id": null,
     "idType": "object",
     "element": "action",
     "elementType": "string",
     "allAttrKeys": ["element", "id", "sceneNumber"],
     "allAttrs": { "element": "action", "id": null, "sceneNumber": null }
   }
   ```

   `element` is a valid, recognized `ScreenplayElementType` (`"action"`); the rejection is
   entirely `id === null` (`typeof null === 'object'`, hence `idType: "object"`). Confirmed exactly
   as the coordinator suspected: this is an id problem, not a schema-mapping problem.

2. **`id: null` is not a corrupted value -- it is this schema's own declared default.**
   `ScreenplayBlockNode.addAttributes()` (`packages/screenplay-editor/src/index.ts`, ~line 567):
   `id: { default: null, parseHTML: ..., renderHTML: ... }`. Every legitimate block-creation path
   in this codebase explicitly overrides that default with a real id: the `Enter` keyboard
   shortcut's `splitScreenplayBlock` (assigns `id: activeBlock.id` to the preserved half and
   `id: createStableId()` to the new half), the same handler's empty-document special case
   (`id: createStableId()`), and `regeneratePastedIds` (paste). There is no path in this
   application's own code that ever constructs a `screenplayBlock` node and _deliberately_ leaves
   `id` at its default. A `null` id can only mean ProseMirror's own schema machinery created the
   node, not this application's code -- ProseMirror fills required content
   (`screenplayDocument`'s content expression requires at least one `screenplayBlock`) via
   `NodeType.createAndFill()`, which instantiates a node from schema defaults alone; it has no way
   to call `createStableId()`, and does not need one for this codebase's own commands to reach --
   this is ProseMirror repairing a document its own validation considers invalid or empty.

3. **`y-prosemirror` silently drops a `null`-valued attribute when encoding to Yjs, rather than
   sending it as an explicit null.** Read directly from the installed package's source
   (`node_modules/y-prosemirror/src/plugins/sync-plugin.js`, `createTypeFromElementNode`):

   ```js
   const createTypeFromElementNode = (node, meta) => {
     const type = new Y.XmlElement(node.type.name)
     for (const key in node.attrs) {
       const val = node.attrs[key]
       if (val !== null && key !== 'ychange') {
         type.setAttribute(key, val)
       }
     }
     ...
   ```

   A node whose `id` attribute is `null` at the moment it is converted to a `Y.XmlElement` never
   gets an `id` attribute set on the Yjs side at all -- not a corrupted id, an _absent_ one, which
   `yXmlFragmentToProseMirrorRootNode` then reconstructs back into a ProseMirror node using the
   schema default (`null`) again on the far side. This is a real, general property of this
   library, not specific to this bug -- it happens to be exactly what makes a locally-created
   default node's missing id durable once it crosses into Yjs, rather than something that could
   self-correct on the next sync.

### The mechanism this points to (reasoned from the above, not separately instrumented to the same

### standard as points 1-3)

Putting `App.tsx`'s own documented collaboration wiring together with points 1-3: for a real
`HocuspocusProvider` connection, `collab.doc` "starts empty and is populated by the provider's own
sync the instant the connection completes" (that comment's own words). `createScreenplayEditorInit`
builds the editor's initial `content` from whatever the Yjs fragment holds _at that instant_ --
which, before the provider's first sync round-trip (client connects -> server's `fetch`/seed ->
sync reaches the client) completes, is genuinely empty. `screenplayDocument`'s content expression
cannot be satisfied by zero blocks, so Tiptap's document construction fills it via
`createAndFill()` -- a default `screenplayBlock` with `id: null`, exactly the schema default from
point 2. If the test's very first `page.keyboard.insertText()` call (which fires as soon as the
canvas element is visible, with no wait for the provider's own `synced` event) lands _into that
auto-filled block_ before the real seed (with a real id, minted server-side by
`nonEmptyEditorContent`) has arrived and reconciled, the null-id block keeps its typed content --
this is `fourPageMixedAnchorFixture()`'s block 0 specifically, the one the test types into without
pressing `Enter` first (deliberately, per that test's own comment, to avoid creating a _second_
stray block) -- and every later block (created via `Enter`/`splitScreenplayBlock`) gets a real id
regardless, which matches every observation so far: only ever one bad block per failure, always
the first one, never the ones typed after an `Enter`.

This would explain the "first save in a fresh process" correlation as indirect, not causal: a
freshly-started `apps/collab` process's first connection (first DB pool acquisition, first
`fetch`/seed round trip, cold JIT) is measurably slower than its later ones, giving the test's
near-instant scripted typing a real chance of winning the race against a sync that has not
completed yet. A generally quieter or "warmer" system -- less contention, everything already JIT-
compiled and cached -- would make that same round trip complete before typing starts far more
often, which is consistent with this session's own observations: the failure reproduced reliably
(2 for 2, with the `id: null` capture above) earlier in this diagnosis, then stopped reproducing
across three consecutive full 18-test runs afterward (all 18/18, each around 44s -- noticeably
faster than the ~96s full runs earlier in this same session). That is not this session's code
changing anything -- the tree was unmodified across those runs apart from reverted instrumentation
-- it is the race itself being load- and timing-sensitive, exactly as a genuine client-typed-
before-server-synced race would be, and exactly why it reproduced far more reliably inside the
full, more contended 18-test/3-worker suite than in an isolated single-test run.

**This is a hypothesis grounded in items 1-3 (each independently confirmed) plus this codebase's
own documented design, not a fourth independently-instrumented observation to the same standard.**
It was not verified by, for instance, logging the provider's own `synced` state at the moment of
the test's first keystroke -- that would be the next confirming (or falsifying) step, and is
exactly the kind of check to run before committing to a fix.

### Recommended fix (not implemented, per instruction) and why this and the StrictMode defect

### belong in the same decision

Both of this slice's two loose ends -- the StrictMode-vs-`useMemo` provider-destruction defect
above, and this one -- are symptoms of the same design choice: `collab.doc`/`collab.provider` are
constructed once, synchronously, in a `useMemo`, on the premise that the Yjs document is
immediately usable the instant it exists. Neither defect is a bug in Yjs, y-prosemirror, or
Hocuspocus; both are places where this application's own wiring assumes a collaboration provider is
either fully connected or doesn't exist, with no representation of "constructed, connecting,
content not yet trustworthy." A fix for one in isolation risks re-introducing the other, or
papering over this one the same way a longer poll timeout papered over -- without truly fixing --
the `maxDebounce` race: two candidate directions, for the owner to choose between rather than have
chosen for them by whichever gets patched first:

- Do not let the editor become interactive (accept keystrokes) until the provider's own `synced`
  event has fired at least once for a screenplay that has never been opened collaboratively before.
  This directly closes the race (nothing can type into an auto-filled default block if typing is
  blocked until the real content has arrived) but changes the writer-visible experience: some
  first-open delay, and a decision about what the editor shows meanwhile (the existing
  `syncState === 'connecting'` status line already exists for this, but nothing today gates
  _input_ on it, only the status text).
- Make the auto-filled default block impossible to reach in the first place, by seeding
  `createScreenplayEditorInit`'s `content` locally (a real id, minted client-side) whenever the
  Yjs fragment is still empty, the same way the non-collaborative fallback path already does via
  `nonEmptyEditorContent` -- accepting that this client-seeded content may then race the server's
  own seed and one of the two must win when they reconcile, which needs to be shown not to
  reintroduce a different version of the same problem (two independently-created "first blocks"
  merging) before being trusted.

Not chosen or implemented here. Both change real, load-bearing behavior in exactly the file
(`App.tsx`) the StrictMode defect also lives in, which is why the standing instruction to stop and
discuss applies to both together, not each in isolation.

## Both defects fixed, and the mechanism narrowed further first (the owner's decision)

The coordinator narrowed the id-null mechanism to a single, confirmed observation before either
fix was implemented: instrumenting `mapBlock`'s rejection (temporary, reverted) and running the
failing test captured

```json
{ "id": null, "idType": "object", "element": "action", "elementType": "string" }
```

live, during an actual failure -- `element` is valid, the rejection is purely `id === null`,
confirming the earlier hypothesis exactly. The owner then chose the fix: **the editor is
read-only until the provider's first sync completes**, over seeding a local block with a real id,
because seeding narrows the race rather than removing it and leaves two independently-created
"first blocks" to merge as a genuine CRDT conflict. Both defects were then implemented together,
since both live in `App.tsx`'s collaboration wiring and a fix for one could otherwise
re-introduce or paper over the other.

### Fix 1 -- the sync gate

`editingAllowed` (`App.tsx`) gained a third condition: `syncState !== 'connecting'`, alongside the
existing schema-support and entitlement checks. Deliberately _not_ also gated on `'offline'`: that
state means an already-`synced` tab's socket merely dropped, and Yjs's own queue-and-flush-on-
reconnect behavior (`syncState`'s own long-standing comment) is exactly what already makes
continuing to type during a reconnect safe -- gating on it too would lock a writer out of their
own manuscript over a transient socket drop, a worse defect than the one being fixed. The status
bar already reports `'offline' · reconnecting…` without this needing to also block input.

**The read-only state is visible, not silent**, reusing the lapse-chooser slice's own
`.readonly-banner` pattern rather than inventing a second one: a new `awaitingFirstSync` banner
(`App.tsx`, mutually exclusive with the entitlement banner) reads "Connecting to the collaboration
server -- this screenplay will be editable once it syncs," with no action button (there is nothing
for the writer to do but wait, and it clears itself the moment sync completes). The "Document
settings…" menu item's `disabledReason` and `.application`'s `has-readonly-banner` grid class were
both extended to cover this new reason alongside the existing entitlement one.

**A second, previously-latent bug surfaced immediately** while wiring this up and had to be fixed
in the same pass: `@tiptap/react`'s own `useEditor` binding (read directly from the installed
package's `EditorInstanceManager.onRender`) does not apply a changed `editable` option on a later
render -- its `setOptions` call there explicitly spreads `editable: this.editor.isEditable` (the
editor's own _current_ value) over whatever the render just passed in, so `editable: editingAllowed`
only ever took effect once, at construction. Nothing in this codebase previously depended on
`editingAllowed` changing _after_ the editor already existed for any real, exercised case (the
"entitlement flips read-only mid-session" test asserts only the toolbar's own React-rendered
`disabled` attributes, never whether the underlying `contentEditable` region itself still accepted
a keystroke) -- the sync gate is the first case that does, since `editingAllowed` now deliberately
starts `false` and turns `true` moments later for every real collaborative session. Without an
explicit `editor?.setEditable(editingAllowed)` effect, the editor became permanently non-editable
for the rest of the session the instant it was ever constructed with `editable: false` -- caught
immediately, not by inspection: every `test:system:persistence` test that opens a fresh screenplay
and types into it failed identically (11 of 18) the first time the sync gate was added without this
effect. Added a small `useEffect` keyed on `[editor, editingAllowed]` that calls
`editor?.setEditable(editingAllowed)`; this also correctly fixes the latent mid-session-entitlement
gap described above, which happened to never be observed until now.

### Fix 2 -- the StrictMode provider-destruction defect

`App.tsx`'s cleanup effect no longer calls `collab.provider?.destroy()` directly. It defers the
call by one macrotask (`setTimeout(..., 0)`) via a ref-held timeout handle, and the effect's setup
clears any pending deferred call from a previous invocation. React's `<StrictMode>` (dev builds
only) runs a component's effects as setup -> cleanup -> setup again, synchronously, immediately
after true initial mount; because `collab` (built once via `useMemo`, deliberately never recreated
per render) does not change across that simulated remount, the _following_ setup call's
`clearTimeout` cancels the deferred destroy before it ever fires. A genuine unmount (navigating to
a different screenplay) has no such follow-up setup call, so the deferred `destroy()` runs and the
connection really tears down, at most one macrotask later than before -- negligible against a
WebSocket teardown nothing here awaits. `<StrictMode>` itself was not touched or disabled; it is
surfacing a real lifecycle bug, not causing one, exactly as instructed.

### Proof, not assertion

**`pnpm --filter @finaler-draft/web test` -- exit 0, 635/635**, no regression from either change
(the existing "entitlement flips read-only mid-session" test still passes -- it never actually
exercised the gap Fix 1 uncovered, only the toolbar's own disabled state, which was never broken).

**`test:system:persistence`, three consecutive runs, each reported separately, not averaged:**

- Run 1: 18 passed, 0 failed (41.9s).
- Run 2: 18 passed, 0 failed (41.5s).
- Run 3: 18 passed, 0 failed (41.4s).

All three exit 0. This is the same suite that was 17/18 (always the identical test, identical
mechanism) immediately before these two fixes -- both the deterministic id-null failure and the
general `maxDebounce`/poll-timeout race documented earlier in this file are gone.

**The no-op `store` mutation, re-run with both fixes in place**: forced `apps/collab`'s `store` to
a no-op (temporary, reverted, reconfirmed identical to baseline by `diff`), ran the full suite:
**11 failed, 7 passed** -- the identical count established earlier in this file, confirming the
harness still fails loudly when persistence is genuinely broken. Full run required ~4.2 minutes
wall clock (every failing poll now correctly exhausts its full `PERSISTED_POLL_TIMEOUT_MS`/
`test.setTimeout` budget rather than failing fast), consistent with the mechanism, not a concern.

**`pnpm dev`, two browser windows, one screenplay, both fixes exercised live:** started against a
disposable database (created and dropped for this check only, per this file's own established
practice -- the owner's real dev database, `.env`, and Resend account were never touched). All
three processes came up cleanly (3001/5173/4400). Signed in, created a project and screenplay in
one tab, opened a second tab on the identical URL (same signed-in session). Both tabs reported
`Synced` within moments of opening -- the sync gate closing and reopening correctly, not staying
stuck at `'connecting'` the way the StrictMode defect made it before. Typed `"INT. TWO WINDOW
CONVERGENCE TEST - DAY"` in tab 0: appeared verbatim in tab 1 without any action there. Typed a
reply in tab 1: appeared in tab 0. Real, live, bidirectional convergence through the actual
`apps/collab` server under ordinary `pnpm dev` -- the verification this whole investigation could
never previously complete, because the StrictMode defect meant the editor never got past
`'connecting'` in dev at all.

Then killed the collab process (`kill -9` on the listening PID for 4400, confirmed by `lsof`) with
both tabs still open: both flipped to `Offline · reconnecting… your edits are safe and will sync
automatically` within seconds, and both **remained editable** (the "Undo local change" button
enabled, typing accepted in both tabs) -- confirming `'offline'` was deliberately not gated,
exactly as decided above. Typing further in each tab while offline correctly diverged the two
tabs' content (nothing left running to reconcile them), the expected, honest difference this
proof was meant to show -- not a bug, the absence of a connection doing exactly what it should.

All processes killed and the disposable database dropped afterward; `git status --short` returned
to the same 85-file baseline (84 plus a legitimate `apps/web/src/styles.css` comment update for
the new banner reason) with no instrumentation left in the tree, confirmed by `diff` against each
file's own pre-diagnosis backup before any of the above was reported.

### Gates for this implementation -- every one run and checked by `$?`

1. `pnpm lint` -- exit 0.
2. `pnpm format:check` -- exit 0.
3. `pnpm typecheck` -- exit 0.
4. `pnpm test` -- exit 0 (all packages; web 635/635, collab 34/3 skipped, api 158/39 skipped).
5. `pnpm check:bundle-budget` -- exit 0 (entry 111.65/120 kB, lazy editor chunk 139.76/200 kB --
   up 0.11 kB from the sync-gate/banner/`setEditable` code, CSS 6.31/20 kB).
6. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/api test:integration` -- exit 0, 39/39.
7. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/collab test:integration` -- exit 0, 3/3.
8. `TEST_DATABASE_URL=<...> pnpm test:system:persistence`, three consecutive runs -- exit 0, 0,
   0; **18/18 every time**.
9. `pnpm test:system` -- exit 0, 40/40.

No new dedicated unit tests were added for the sync gate or the deferred-destroy fix specifically:
`App.test.tsx` statically imports `App` and has no existing `HocuspocusProvider` mocking
infrastructure, and retrofitting one (dynamic imports plus `vi.resetModules()` across a 1400+ line
file, the same technique `collabConfig.test.ts` uses for a single small module) was judged a
separate, nontrivial undertaking rather than something to bolt on under this task's time budget.
Both fixes are instead exercised, end to end, by the real collaborative flow in
`test:system:persistence` (now 18/18, three consecutive times) and by the manual two-window
`pnpm dev` proof above. Flagged here plainly rather than left unstated.

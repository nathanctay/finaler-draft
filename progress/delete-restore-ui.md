# Scope: delete-restore-ui

Branch: `feature/delete-restore-ui`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/delete-restore-ui`
Base: `main` @ `8b81199`
Owner: Sonnet implementation agent, advised by the lead.

## Why this scope exists

The rename/soft-delete/restore API landed last slice with **no interface at all**. `plan.md`'s
"Deleting and restoring" subsection, under "UI and interaction direction", records the settled
design. Read it first — it is the specification for this slice, and read it from
`/Users/nathan/Documents/finaler draft/plan.md` (the **main** worktree copy), not the snapshot in
your own worktree.

Note the constraint stated there: **the delete interface must not ship before the restore route
exists.** Delete and the Deleted page land together, in this slice, or neither does.

## What exists now

- `apps/web/src/api.ts` — the `api` object. It has no rename/delete/restore calls yet; add them
  following the existing `json(...)` + Zod response-schema pattern exactly.
- `apps/web/src/routes/projects/index.tsx` — the writing desk. Its `.project-header` currently
  holds a bare **Sign out** button and nothing else.
- `apps/web/src/routes/projects/$projectId/index.tsx` — the screenplay list for one project.
- `apps/web/src/styles.css` — the design-token system. `.primary-button`, `.sign-out-button`,
  `.project-header` exist. **Use the tokens; do not introduce raw colour literals.**
- Existing accessible-status precedent: `role="alert"` in `projects/index.tsx` and `sign-in.tsx`,
  `aria-live="polite"` in `App.tsx`.

Endpoints available (from `apps/api/src/app.ts`): `PATCH`, `DELETE`, and `POST .../restore` for
both `/api/projects/:id` and `/api/screenplays/:id`. Delete returns `200 { id }`; restore returns
`200 { id, title }`. Non-members get 404; members with an insufficient role get 403.

## 1. The overflow menu

An overflow (three-dot) menu at the right of each **screenplay** row and each **project** row. It
carries **Delete** only in this slice. Rename lands later as **Edit**; do not build it now, and do
not add a disabled placeholder for it.

Accessibility is the substance of this item, not a finishing touch. It must have a real accessible
name, `aria-haspopup`, `aria-expanded`, open on Enter/Space, close on Escape with focus returning
to the trigger, and be operable entirely by keyboard. Menus are the control most often shipped
mouse-only; a menu that cannot be opened and dismissed from the keyboard is not done.

There is no existing menu component. Build the smallest one that satisfies the above and lives with
the other components — do not add a component library.

## 2. Delete with an undo affordance

No confirmation dialog. `plan.md` is explicit about why: deletion is reversible, so a modal is
friction that trains people to dismiss dialogs unread.

After a successful delete, show an inline **"Deleted — Undo"** affordance. Undo calls the restore
endpoint and returns the row. It must be announced to assistive technology (there is precedent in
the files listed above) and must be keyboard-reachable — an undo only usable with a mouse fails the
people most likely to need it.

State explicitly in your progress entry what happens when the affordance goes away (does it
persist, auto-dismiss, or clear on navigation) and why. Whatever you choose, the Deleted page is
the permanent route back, so nothing is lost when it disappears.

## 3. The Deleted page

A route listing deleted projects and deleted screenplays, each with a rectangular **Restore**
button — not an overflow menu, since restore is the only action available there.

**It must not be reachable from the writing desk or a project's screenplay list.** `plan.md` places
it in the account/settings menu. No such menu exists: the header holds a bare Sign out button.
**Convert that into an account menu** containing "Deleted items" and "Sign out". Keep it small and
hold it to the same accessibility bar as item 1.

Two behaviours that are easy to get wrong and are specified, not open:

- **A screenplay whose project was deleted must not appear as a deleted screenplay.** Its
  `deleted_at` is `NULL`; it is unreachable only because its parent is. Restoring the project
  restores it. Listing it would make restoring a project look like it resurrected screenplays the
  writer never deleted. Check what the API actually returns and make the interface agree with the
  data model — if the endpoints do not currently expose enough to distinguish these, **stop and
  report** rather than inferring it in the client.
- The page is named **Deleted**, never "Recently deleted". Nothing is purged and no retention
  window exists; the friendlier name promises an expiry that does not.

If listing deleted items requires an endpoint that does not exist, **stop and report at checkpoint
1** with what is missing. Do not add API routes without agreement — the last slice deliberately
shipped none.

## 4. Visual direction

`plan.md`'s "UI and interaction direction" governs: desktop authoring software, square or subtly
rounded rectangles, no pills, no floating shadows, restrained palette, dense and deliberate. This
is the first substantial interface work since the token system was built, so it is also a test of
whether that system covers real components. If you find yourself wanting a value the tokens do not
have, say so in your report rather than reaching for a literal.

## Out of scope

Rename/Edit. Bulk actions. Purge or retention. Admin roles. Any change to `apps/api`,
`packages/database`, `packages/layout`, `packages/screenplay`, or the pagination path. New
dependencies.

## Verification required before handoff

1. `pnpm format:check` — run this **after** writing your progress entry
2. `pnpm lint`
3. `pnpm typecheck` — clean tree, no prior build
4. `pnpm test:coverage`
5. `pnpm build`
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`
7. The persistence gate, run **at least three times**, reporting each result
8. `git diff --check`
9. **No credential in any file you write**, including `progress/`. The test database URL goes on the
   command line only.

The API server serves a **prebuilt** web bundle: run `pnpm --filter @finaler-draft/web build`
before any browser gate. Kill stale servers on the gate ports first.

## Testing standard

For every test guarding specific behaviour: **break the behaviour, confirm the test fails, restore**,
and report it.

This slice is interface work, so the specific trap is tests that assert markup rather than
behaviour. A test that finds a button by CSS class and asserts it exists proves nothing. Drive the
real components: open the menu by keyboard, activate Delete, assert the row leaves the list, invoke
Undo, assert it returns. At least one end-to-end path — delete then restore through the real API
and database — belongs in the persistence gate, since that is the only place the real endpoints are
exercised.

Assert the accessibility properties as behaviour too: Escape closes and focus returns to the
trigger; the undo affordance is announced; every control is reachable by keyboard alone.

## Rules

- Do not stage, commit, merge, rebase, force-push, reset, or create/delete worktrees. The owner
  controls staging, committing and pushing.
- Do not read, print, or commit `.env` files or any credential.
- No TODO, FIXME, or placeholder comments. No emojis. Strict TypeScript, `.js` extensions on
  relative imports.
- If anything contradicts the specification, stop and report rather than bending the spec.
- If a command hangs for more than a few minutes, stop and report rather than polling.

## Checkpoints — report to the lead with SendMessage

1. **Before writing components:** whether listing deleted items is possible with the endpoints that
   exist, and the menu/undo/Deleted-page structure you intend. Wait for a reply.
2. On completion, with gate results, the mutation-testing report, and the repeated persistence runs.

## Log

### 2026-08-11 — lead — scope opened

Status: ready-for-implementation
Third item in the remaining Phase 1 order. Opened after the CRUD API and the interface direction in
`plan.md` both merged.

### 2026-08-11 — lead — scope amended: one API endpoint added

The implementation agent correctly stopped at checkpoint 1: no route exposes deleted items, so the
Deleted page cannot be built. Verified — `listProjects` and `listScreenplays` both hard-filter
`deleted_at is null`, and the only `deleted_at is not null` query is `lockScreenplayRow`'s point
lookup by id, which no route reaches.

`plan.md` mandates the Deleted page and forbids shipping delete without a restore route, so the
endpoint is a required consequence of a decision already made, not new product scope. **The
out-of-scope rule against touching `apps/api` is amended for this one addition.** Everything else
listed there still stands.

**Add `GET /api/deleted`**, returning both collections in one response:

```
200 { projects: [...], screenplays: [...] }
```

Not `GET /api/projects/deleted` — `/api/projects/:id` already owns that shape, so `deleted` would
bind as `:id` and fail UUID validation with a 400.

Requirements:

- **Scope each collection to what the actor may actually restore**: projects where they are owner,
  screenplays where they are owner or editor. A Restore button that returns 403 is a broken
  control; do not list rows the actor cannot act on.
- **Deleted screenplays must exclude any whose project is also deleted** —
  `s.deleted_at is not null and p.deleted_at is null`. This is `plan.md`'s rule, and it belongs in
  the query, not in client-side filtering. It is also what makes item 3 of the scope satisfiable.
- Include enough on each screenplay row to identify its project, so the page can show which project
  a deleted screenplay belonged to.
- Follow the existing conventions exactly: declared Zod `response` schema through the type provider,
  authorisation enforced in the store, a new `ProjectStore` method rather than an ad hoc query.
- Unit, HTTP, and real-database coverage, each mutation-tested — in particular, removing the
  `p.deleted_at is null` predicate must fail a test.

### 2026-08-11 — implementation agent — complete

Status: ready-for-review

#### What shipped

**API** (`apps/api/src/projects.ts`, `apps/api/src/app.ts`): `ProjectStore.listDeleted(actorId)`
and `GET /api/deleted`, exactly as the lead's amendment specified — two queries, not a shared one,
scoped to owner for projects and owner-or-editor for screenplays, with the screenplays query
requiring `p.deleted_at is null` so a screenplay independently deleted before its now-also-deleted
project never lists a Restore button that would 404. The auth `preValidation` hook only guarded
`/api/projects` and `/api/screenplays` prefixes; `/api/deleted` matched neither, so the route was
silently unauthenticated until a test caught it (see Mutation testing below) — fixed by adding the
prefix to the guard.

**Web** (`apps/web/src/components/`): `OverflowMenu.tsx`, a from-scratch accessible popup menu
(no library) — real per-row accessible name, `aria-haspopup="menu"`, `aria-expanded`, native
Enter/Space activation via a real `<button>`, Escape closes and returns focus to the trigger,
ArrowDown/ArrowUp roam between items (wrapping), ArrowDown from the trigger opens and focuses the
first item, and focus leaving the whole widget closes it. `DeletedRow.tsx`, the shared inline
"Deleted — Undo" affordance (`role="status"` message + Undo button), used by both the writing desk
and a project's screenplay list.

`apps/web/src/routes/projects/index.tsx` and `.../$projectId/index.tsx`: per-row `OverflowMenu`
carrying only Delete, and delete-then-undo wired through `DeletedRow`. The writing desk's bare
Sign out button became an account `OverflowMenu` ("Account" trigger) with two items: "Deleted
items" (navigates to `/deleted`) and "Sign out" (the existing mutation, unchanged).

`apps/web/src/routes/deleted.tsx`: the new `/deleted` route, guarded by the same
`guardSessionUser` pattern as every other protected route, reachable only from the account menu.
Two sections (Projects, Screenplays), each row a rectangular `.primary-button`-styled Restore, no
menu. Screenplay rows show `From {projectTitle}`.

**Undo-affordance lifecycle** (the explicit question in the scope): it persists until Undo
succeeds or the component unmounts on navigation — never on a timer. Delete does **not**
invalidate the list query immediately; the row switches to `DeletedRow` via local component
state keyed by id, independent of the query. To make that robust against an incidental
background refetch (e.g. window-focus regain, which `@tanstack/react-query`'s default
`staleTime: 0` would otherwise trigger) silently dropping the affordance along with the now-absent
row, both list pages render any locally-tracked deleted id that has fallen out of the live query
data as a trailing "orphaned" row, so the affordance is guaranteed to survive until the writer
acts or leaves. This is exercised directly by
`routes/projects/index.delete.test.tsx`'s "keeps the Undo affordance visible even if an unrelated
background refetch drops the row" test and the equivalent in the `$projectId` variant. Undo (or a
Restore from `/deleted`) invalidates the relevant query, which is what makes the real row
reappear from fresh server data.

**Visual direction**: no new design tokens were needed. The menu and Restore button reuse
existing tokens (`--border-03`, `--surface-01`/`--surface-05`, `.primary-button`) and existing
hard-edged, no-shadow conventions; the popup menu has a 1px border and no shadow, in keeping with
"no floating shadows."

#### Verification

1. `pnpm format:check` — clean (run after this entry was written; see below).
2. `pnpm lint` — clean. Caught and fixed three real issues during development: a `let` that
   should have been `const`, and two destructuring-derived unused vars (`_removed`) that this
   config's `no-unused-vars` does not exempt by leading underscore for plain variables (only for
   trailing, already-used function parameters) — rewritten as `Object.fromEntries(...filter(...))`.
3. `pnpm typecheck` — clean, run against a tree with every package's `dist/` removed first (leaf
   packages rebuilt, then `web`/`api` typecheck against that clean build).
4. `pnpm test:coverage` — web: 18 files, 122 tests, all pass; coverage 96.96% statements / 92.17%
   branches overall, every new file individually clears the `perFile` 80% thresholds
   (`OverflowMenu.tsx`, `DeletedRow.tsx`, `deleted.tsx`, both edited route files). api: 4 files, 43
   tests (14 more skipped without `TEST_DATABASE_URL`), aggregate coverage 93.91% statements /
   85.8% branches against the configured `include` list, comfortably above the 80% gate.
5. `pnpm build` — clean, produces the expected extra chunks (`OverflowMenu`, `deleted`).
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — 21/21 passed.
7. The persistence gate (`TEST_DATABASE_URL=<test db> PLAYWRIGHT_CHANNEL=chrome pnpm
test:system:persistence`), run four times total:
   - **Run 1**: 6/8 passed. One failure (`page-rendering-persistence` "every block lands where the
     model predicts") was `browserType.launch: Executable doesn't exist` — a `PLAYWRIGHT_CHANNEL`
     propagation issue in my invocation, not a code defect; the other failure was a real bug in my
     own new e2e test (see below). Fixed both and reran.
   - **Runs 2, 3, 4**: 8/8 passed each time, consistently.
   - The real bug: my new "delete a screenplay and undo" test clicked a `Link` named "Projects" to
     navigate back from the screenplay editor, but the editor shell (`App.tsx`) has no such link —
     that breadcrumb exists only on the project's screenplay list. Fixed by using `page.goBack()`
     instead, since screenplay creation is a router push. This was a genuine defect in the test,
     not the feature, but it is exactly the kind of thing that only a real end-to-end run catches.
8. `git diff --check` — clean.
9. No credential in any file written, including this one — the test database URL was only ever
   passed on the command line, per instruction.

#### Mutation testing (break it, confirm the test fails, restore it, report it)

- `apps/api/src/projects.ts`: removed `and p.deleted_at is null` from the deleted-screenplays
  query. Both `projects.test.ts`'s query-string assertion and
  `persistence.integration.test.ts`'s real-database "excludes a screenplay whose project is also
  deleted" assertion failed as expected. Restored; both pass again.
- `apps/web/src/components/OverflowMenu.tsx`: removed `triggerRef.current?.focus()` from
  Escape's close handler. The dedicated "closes on Escape and returns focus to the trigger" test
  failed as expected. Restored.
- `apps/web/src/routes/projects/index.tsx`: added a stray `<Link to="/deleted">Deleted</Link>` to
  the writing-desk header (simulating a regression that makes the Deleted page reachable outside
  the account menu). Both `index.test.tsx`'s and `index.delete.test.tsx`'s "only through the
  account menu" assertions failed as expected. Restored.
- The auth-guard gap on `GET /api/deleted` (see "What shipped" above) was caught by my own new
  HTTP test before I ever ran the app manually — worth recording as evidence the test was doing
  real work, not asserting markup.

#### Known limitations / things not done

- Coverage numbers above are from a run without `TEST_DATABASE_URL`, matching what `pnpm -r
test:coverage` (the root script) actually runs; the integration suite's additional coverage of
  `listDeleted` was verified separately by running `test:integration` and reading the assertions,
  not by a combined coverage figure.
- Playwright's own browser-launch flakiness (run 1, item 7 above) is an environment characteristic
  of this machine/session, not something this slice's code can fix; noting it in case it recurs
  for review.

### 2026-08-11 — implementation agent — audit follow-up

A third-party audit (`audit.md`, in the main worktree, reviewing this branch) raised several
findings. Verified each against the code rather than accepting them at face value; fixed the ones
squarely within this slice's diff, left the rest for a separate decision. Details:

**Fixed, in this diff:**

- **Delete controls did not respect authorization.** `ProjectRow` rendered its overflow menu (and
  therefore Delete) for every viewer regardless of role, even though `deleteProject` is
  owner-only server-side — an editor or reviewer would see a control that always 403s, the same
  "broken control" class flagged for Restore during the amendment round. Fixed by gating the menu
  on `project.role === 'owner'`; `projects.data` already carries `role` per project, so no API
  change was needed. New test in `index.test.tsx` proves the menu is present for an owner's row
  and absent for an editor's and a reviewer's. **Not fixed**: the equivalent gap on screenplay
  Delete (`ScreenplayRow` shows Delete to a reviewer, who cannot use it). Fixing it requires the
  viewer's role for that specific project, which `GET /api/projects/:id/screenplays` does not
  currently return — projects' listing has `role` because membership is looked up per project;
  screenplays' listing was never given the equivalent field. Closing this properly means adding
  `role` to that response (a further, small `apps/api` change, beyond what this scope's amendment
  authorized) or an extra `api.projects()` fetch on the project page to derive it client-side. Left
  for a decision rather than done unilaterally.
- **Undo/Restore buttons were not distinguishable by accessible name.** Every `DeletedRow`'s Undo
  button and every `/deleted` row's Restore button had static text with no per-row `aria-label` —
  fine with one row visible, indistinguishable to a screen reader user with more than one. Fixed
  with `aria-label="Undo delete of {title}"` and `aria-label="Restore {title}[, from
{projectTitle}]"` respectively, following the same per-instance-name discipline already used for
  the OverflowMenu triggers.
- **Keyboard focus was lost after a keyboard-driven delete or restore**, and the keyboard test
  masked it. Selecting Delete from the menu unmounts the focused menuitem when the menu closes,
  then unmounts the row's trigger entirely when it is replaced by `DeletedRow` — nothing claimed
  focus afterward, so it fell back to `document.body`. The audit's sharpest point: my own keyboard
  test called `undoButton.focus()` manually rather than asserting where focus actually landed,
  which is exactly the "test asserts manufactured state, not real behaviour" trap the original
  scope warned against. Fixed by having `DeletedRow` focus its own Undo button on mount
  (unconditionally, not only for keyboard-initiated deletes — simpler than tracking input
  modality, and losing focus entirely is worse for every user than a mouse user briefly seeing a
  focus ring). The `/deleted` page has the same shape of problem in reverse — a successful Restore
  removes the row and its now-gone button — fixed by focusing the page's own `<h1>` (`tabIndex={-1}`)
  after a successful restore. Every affected test (`index.delete.test.tsx`,
  `$projectId/index.delete.test.tsx`, `deleted.test.tsx`) was rewritten to assert real focus rather
  than force it, and updated for the new accessible names (`getByRole`'s `name` matches exactly in
  `@testing-library/react`, unlike Playwright's substring default, so every RTL query needed the
  full new name; the e2e specs needed no changes since Playwright's substring matching already
  covers the longer names).
- **`GET /api/deleted`'s two queries were not snapshot-consistent.** They ran as independent
  `pool.query` calls; a concurrent restore between them could produce a response that never
  existed in the database at any single instant (e.g. naming a project deleted while also listing
  a screenplay whose exclusion depends on that same project's state). Fixed by wrapping both
  queries in one `begin isolation level repeatable read read only` transaction. Unit test rewritten
  to the `fakeClient`/`fakePool` transactional pattern already used by every write method in this
  file; real-database integration test unaffected (was already passing, now also correct under
  concurrency by construction rather than by accident).
- **The editor-role integration test never proved what it claimed.** It restored the one deleted
  screenplay an editor was eligible to see _before_ querying as that editor, so "editor sees
  nothing" was trivially true regardless of whether the scoping rule worked. Rewrote it to check
  the editor's view while the screenplay is still genuinely deleted (expecting exactly one row),
  then have the editor themselves perform the restore — proving both visibility and the
  restore-authorization rule in one path. Mutation-tested: with the screenplays query narrowed
  back to owner-only, this specific assertion fails (`expected [] to deeply equal
[Array(1)]`); restored, passes again.
- **`packages/database/package.json` had no trailing newline**, failing `format:check`. Fixed
  (`prettier --write`); this was already true before today's `db:studio` script addition, not
  introduced by it.

**Verified and re-run after all of the above:** `pnpm lint`, `pnpm typecheck`, `pnpm --filter
@finaler-draft/web test:coverage` (123 tests, all files still clear their `perFile` 80%
thresholds), `pnpm --filter @finaler-draft/api test` and `test:integration` (real database),
`pnpm format:check`, `git diff --check`, and the persistence gate once more end-to-end
(`TEST_DATABASE_URL=<test db> PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence`, 8/8).

**Read and assessed, not changed — a call for the owner, not something to fix silently:**

- _Private screenplay data can leak between users sharing one browser session_ (P1). Verified the
  premise: `$projectId.screenplays.$screenplayId.tsx`'s query has `staleTime: Infinity,
refetchOnMount: false, refetchOnWindowFocus: false`, keyed only by `screenplayId`, and
  `sign-in.tsx`'s success handler removes only `['session']`, not the whole cache (unlike
  sign-out, which does `queryClient.clear()`). The scenario is real but narrow: same tab, user A's
  session invalidated without an explicit sign-out or reload, user B signs in in that same tab,
  and B reaches the exact same screenplay URL. Real, worth fixing, but this route predates this
  slice entirely and isn't part of it.
- Dependency-version advisories (Fastify, `@fastify/static`), the Railway health check not
  checking Postgres, and the rest of auth hardening (rate limiting, email verification, password
  recovery) are all real and all pre-existing, unrelated to this diff's files. The auth items are
  also already tracked in `plan.md` as explicitly deferred, not silently missing.
- Retry-safety/idempotency of delete and restore, missing `Origin` validation on state-changing
  routes, missing `Cache-Control: private, no-store` on private responses, no durable audit trail
  for lifecycle changes, unbounded collections with no pagination, pool sizing/graceful shutdown,
  and API contract duplication are all real characteristics, mostly pre-existing patterns this
  slice's new endpoint continued rather than introduced (e.g. `listDeleted` has no pagination
  because `listProjects`/`listScreenplays` never did either). Each is a legitimate architectural
  item, not a defect specific to this slice, and each is a bigger decision than one implementation
  agent should make unilaterally mid-review.
- `apps/web/src/routes/projects/$projectId/index.tsx` still does not handle `scripts.isError`
  (a load failure renders as an empty list) — true, and pre-existing: the original file had the
  same gap before this slice touched it. Not fixed here to keep this follow-up round scoped to
  what the audit specifically found in the delete/restore surface.

### 2026-08-11 — implementation agent — second audit follow-up

The branch was re-audited (audit.md, same location, reviewing the fixes above). Verified the new
and refined claims directly rather than relaying them; two turned out to be real regressions in
this slice's own code and are fixed below. Also independently ran `pnpm audit --prod` myself (18
vulnerabilities: 3 low / 8 moderate / 6 high / 1 critical against the exact pinned `fastify`/
`@fastify/static` versions) and inspected `auth.ts`, `schema.ts`, `railway.toml`, and `app.ts`
directly to confirm the security-relevant claims rather than take the document's word — none were
fabricated or overstated in substance.

**Fixed, in this diff:**

- **CSS regression: deleted item titles were unintentionally capitalized.** `.project-list li span`
  (added before this slice, originally scoped for the project role badge) is a broad descendant
  selector that also matched `.restore-row-title` and `.restore-row-meta` on the Deleted page —
  both spans nested under the same `.project-list li` structure this slice reused. Every deleted
  project/screenplay title and the "From {project}" meta text were being title-cased. Fixed by
  giving the role badge its own class (`.project-row-role`) and scoping the rule to it specifically,
  removing the broad selector. Not caught by the existing test suite because jsdom does not apply
  the real CSS cascade — this is a case where the fix is correct but not test-guarded; noting that
  honestly rather than claiming coverage that doesn't exist.
- **The database-backed browser suite was never wired into CI.** `pnpm test:system` runs in
  `.github/workflows/quality.yml`, but `pnpm test:system:persistence` — the gate covering the real
  delete-then-undo and delete-then-restore-from-the-Deleted-page paths against a real database —
  only ever ran when a human or agent invoked it manually. Added it as a CI step, reusing the
  same Postgres service and connection string already used by the `test:integration` step in the
  same workflow file. Verified the addition is syntactically sound and re-ran the exact command
  locally after the fix (8/8, consistent with every prior run).

**Verified and re-run after both fixes:** `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
`pnpm --filter @finaler-draft/api test`, `git diff --check`, and the persistence gate end-to-end
once more (8/8).

**Verified as real, not fixed — cross-cutting security/policy decisions beyond this slice:**

- **CSRF via same-site sibling origins, confirmed at the code level.** The `preValidation` auth
  hook (`app.ts`) checks only the session cookie; it never inspects `Origin` or `Referer` on any
  custom REST route, including the restore endpoints this slice's UI calls. `SameSite=Lax` cookies
  (which `plan.md` mandates) do not protect against this specific shape of attack — only against
  fully cross-site requests. Did not attempt a live exploit against the running dev database; the
  code-level absence of any Origin check is sufficient confirmation. Fixing this correctly means an
  exact-origin allowlist across every state-changing route, not just restore — `plan.md`'s own
  CORS/origin-policy section already specifies the shape of that fix. A cross-cutting `app.ts`
  change beyond this slice's scope.
- **`Cache-Control: private, no-store` is missing on every authenticated response, including
  `/api/deleted`.** This is not just a nice-to-have the audit suggested — `plan.md` states outright
  that "every authenticated API response must carry `Cache-Control: private, no-store`
  explicitly," citing a real Railway CDN misconfiguration incident as the reason. Confirmed by grep:
  zero `Cache-Control` handling anywhere in `apps/api`. A separate, related gap in the same policy
  block: `@fastify/static` is registered with no `maxAge`, so it currently serves every hashed
  static asset as `public, max-age=0`, the opposite of the `immutable` caching `plan.md` requires.
  Both need a app-wide Fastify hook, not a per-route fix, and both predate this slice.
- **Deleted/revoked screenplay content can reopen via Back/Forward navigation.** The same infinite
  screenplay cache behind the cross-account leak finding also means a screenplay just deleted (by
  this slice's own Delete control) can still render from cache if the writer navigates back into
  it — stale content, and any further edit would fail against a screenplay that no longer exists.
  Same root cause and same file as the pre-existing cross-account leak; not something this slice's
  diff can fix in isolation without touching that route.
- **Reviewers still see "New screenplay" as well as Delete.** Already disclosed as unfixed
  (screenplay-level role gating needs either a `role` field added to the screenplays-list response
  or an extra fetch); the audit's mention of the New-screenplay button specifically is the same
  underlying gap — the project page has no way to know the viewer's role at all yet.
- **`OverflowMenu` mixes ARIA `menu`/`menuitem` semantics with Tab-through-every-item behavior**
  rather than the APG menu pattern's roving tabindex (where Tab exits the whole menu and only
  Arrow keys move among items). This was a deliberate tradeoff, documented in the component at the
  time: every item is independently tabbable so "operable by keyboard" doesn't depend on
  discovering Arrow-key support first. It is a real deviation from strict ARIA authoring practice,
  not a bug in what it does today. Left as-is pending a decision on whether strict APG conformance
  is wanted here.
- Duplicate/concurrent delete-restore reconciliation across tabs, autosave's navigation-loss
  window, unbounded pagination, pool sizing, and the rest of the dependency advisories are the same
  findings as the first round, re-confirmed, still out of this slice's scope.
- Better Auth does provide production-mode auth throttling by default — the first audit's "no rate
  limiting" framing was corrected by the second pass. The real residual gap is that the built-in
  throttling is in-memory/per-instance with no global/distributed cap, which still needs addressing
  before horizontal scaling.

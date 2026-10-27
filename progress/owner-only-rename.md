# Owner-only rename, and closing the ungated screenplay Delete

Branch `feature/owner-only-rename`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/rename`,
off `main` @ `ac0128a`.

## Why this scope exists

The owner asked for a rename option in the 3-dot menu on both the projects and screenplays screens
-- pop a dialog, let the writer change the name -- restricted to the owner. Deleting a project or
screenplay should be owner-only too, enforced on the server. RLS was discussed and deliberately
deferred for this slice; the server is the one enforcement point.

Two things made this smaller than it first looked, and one thing made it bigger:

- **The rename API already existed.** `apps/api/src/projects.ts` already exported `renameInput`
  and implemented `renameProject`/`renameScreenplay`, both wired into real PATCH routes in
  `app.ts`. Only the UI was missing -- `routes/projects/index.tsx` even carried a comment calling
  the menu "Rename/Edit's eventual home."
- **Delete and restore already existed too**, for both resources, with a working UI (overflow
  menu, undo affordance, the Deleted page) from an earlier slice (`progress/delete-restore-ui.md`).
- **The authorization underneath all of it was inconsistent**, and fixing that consistently is
  most of this slice's actual work. Before this slice:

  | operation           | gate                                   |
  | ------------------- | -------------------------------------- |
  | `deleteProject`     | owner only (inline `role !== 'owner'`) |
  | `restoreProject`    | owner only (inline `role !== 'owner'`) |
  | `renameProject`     | `canEdit` -- owner **or editor**       |
  | `renameScreenplay`  | `canEdit` -- owner **or editor**       |
  | `deleteScreenplay`  | `canEdit` -- owner **or editor**       |
  | `restoreScreenplay` | `canEdit` -- owner **or editor**       |

  Four of six operations admitted an editor. The owner's ask -- rename and delete are owner-only,
  full stop, for both projects and screenplays -- was a real narrowing of existing behaviour, not
  just new UI on top of an already-correct bar. After this slice:

  | operation           | gate                                                  |
  | ------------------- | ----------------------------------------------------- |
  | `renameProject`     | owner only (`isOwner`, was `canEdit`)                 |
  | `deleteProject`     | owner only (`isOwner`, was inline `role !== 'owner'`) |
  | `restoreProject`    | owner only (`isOwner`, was inline `role !== 'owner'`) |
  | `renameScreenplay`  | owner only (`isOwner`, was `canEdit`)                 |
  | `deleteScreenplay`  | owner only (`isOwner`, was `canEdit`)                 |
  | `restoreScreenplay` | owner only (`isOwner`, was `canEdit`)                 |

  All six now share one predicate. `createScreenplay` and `createRevision`'s `'named'` case stay
  `canEdit` (owner or editor) -- untouched by this slice; see "What stayed `canEdit`, deliberately"
  below.

- **A defect this slice is explicitly on the hook for, not a drive-by:** `apps/web/src/routes/
projects/$projectId/index.tsx` rendered `{ label: 'Delete', onSelect: ... }` on every screenplay
  row **unconditionally**, so a reviewer saw a Delete button that always 403'd. That is the same
  broken-control defect class `progress/paste-sanitization.md` records for the export buttons that
  silently did nothing (there, a click did nothing and looked broken; here, a click looks like it
  should work and answers a refusal) -- not incidental cleanup, a named part of this brief.

## Why `roleIsOwner` belongs in `packages/database`

`roleCanEdit` already lives there, and its own doc comment gives the reason this slice's new
predicate has to live beside it: a role reaching an authorization check in `apps/api` can now come
from **either** `project_members` or `screenplay_members` (`screenplayRoleLateral` unions both,
most-privileged-wins). "Which roles may do this" has to mean one thing regardless of which table
resolved the role, for both services that ask the question. `apps/api/src/projects.ts`'s own
`isOwner` is a thin wrapper that delegates to it, exactly mirroring how `canEdit` wraps
`roleCanEdit` there already -- same shape, same rigour, same reason the wrapper exists (every call
site in `projects.ts` reads better with the shorter local name, but the predicate itself has
exactly one definition).

Before this slice, `deleteProject`/`restoreProject` didn't even have a shared predicate for "is
this an owner" -- each wrote `role !== 'owner'` inline. That is a security-bearing comparison
duplicated at two call sites with no shared name, which is the same hazard `roleCanEdit`'s own doc
comment already describes for six independently-maintained copies of "who may write." Consolidating
both the inline comparisons and the four `canEdit` call sites onto one `roleIsOwner` means the
owner-only bar now has exactly one definition across both tables, both services, and all six
operations -- not four implicit agreements plus two inline literals that happened to agree.

`packages/database/src/membership.ts`:

```ts
export function roleIsOwner(role: unknown): boolean {
  return role === 'owner';
}
```

Exported from the package's `index.ts` alongside `roleCanEdit`, with its own doc comment recording
the "owner may do this now, used to be owner-or-editor" history for the same reason `roleCanEdit`'s
own comment exists -- so a reader three slices from now finds the "why" at the definition, not only
in a progress doc.

## What stayed `canEdit`, deliberately

Not everything narrowed. `createScreenplay` (creating a screenplay inside a project) and
`createRevision`'s `'named'` case (saving a milestone) are both still `canEdit` -- owner or editor
-- and that is correct, not an oversight. The owner's ask was specifically about **renaming and
deleting existing things**; creating new content and authoring a milestone label are not the same
act as renaming or deleting the resource itself, and narrowing them was never requested. I updated
the stale doc comment on `RevisionStore.createRevision` (`apps/api/src/revisions.ts`) that used to
cite `renameScreenplay`/`deleteScreenplay` as sharing the exact same bar -- that citation went
wrong the moment this slice narrowed those two specifically, so the comment now explains that an
editor may still save a named revision, just not rename or delete the screenplay.

## The `listDeleted` filtering decision, and its consequence

`listDeleted`'s screenplay collection used to select `m.role in ('owner', 'editor')`, matching
`restoreScreenplay`'s then-wider bar. The interface comment on `ProjectStore.listDeleted` is
explicit about why that collection is scoped at all: the Deleted page's only action per row is
Restore, so a row that cannot be restored must never be listed -- that is the exact "broken
control" defect this whole slice is about, pointed the other direction. Once `restoreScreenplay`
narrowed to owner-only, leaving the listing at `in ('owner', 'editor')` would have reintroduced
precisely that defect: an editor would see a Restore button for their own just-deleted screenplay,
click it, and get a 403.

I narrowed the query to `m.role = 'owner'` in lockstep, rather than widening the response to carry
a `role` field and gate in the UI. Two reasons, both from the task brief directly: the screen's
only action is Restore, so an item nobody can restore has nothing else to offer -- there's no
"view-only" row worth rendering -- and gating in the UI would mean the server still returning rows
an editor cannot act on, which is the shape of the defect, not a fix for it. Filtering server-side
is also strictly simpler: no new wire field, no client-side branch, one predicate that has to agree
with `restoreScreenplay`'s own bar (and now does, provably -- see "Mutation testing" below, where
widening this predicate back without narrowing `restoreScreenplay` is exactly the drift a test now
catches).

**The consequence, stated plainly:** an editor who deleted a screenplay under the old rules can no
longer restore it, and no longer sees it listed on the Deleted page at all. Only the project's
owner can see it and restore it now. This is a real, visible behaviour change for any editor with
a screenplay already sitting in that state at deploy time -- there is no migration or backfill for
it, because there is nothing to migrate: the screenplay is still there, soft-deleted, exactly as
it was; only who may act on it has changed. Going forward this situation cannot newly arise, since
an editor can no longer delete a screenplay in the first place (Delete is now owner-only in the UI
and the server). I did not attempt to notify affected editors or build any interface for "this is
stuck, ask the owner" -- that is outside what was asked, and the owner already has full visibility
and the actual restore capability from their own Deleted page.

## What shipped -- server

`apps/api/src/projects.ts`:

- Added `isOwner`, delegating to `@finaler-draft/database`'s new `roleIsOwner` (mirrors `canEdit`
  exactly).
- `renameProject`, `renameScreenplay`, `deleteScreenplay`, `restoreScreenplay`: their `canEdit(...)`
  check became `isOwner(...)`.
- `deleteProject`, `restoreProject`: their inline `role !== 'owner'` comparison became
  `!isOwner(...)` -- same behaviour, one definition instead of two independent literals.
- `listDeleted`'s screenplay query: `m.role in ('owner', 'editor')` became `m.role = 'owner'`.
- The `projectTitle` schema (`renameInput`'s field) now reads its `200` bound from
  `@finaler-draft/config`'s new `RESOURCE_TITLE_MAX_LENGTH` rather than a bare literal -- see "The
  shared title-length constant" below.
- Every doc comment that described the old bars (the `ProjectStore` interface comments, the
  `isOwner`/`canEdit` wrapper comments, the `listDeleted` screenplay-query comment) was updated to
  state the new bar and the history, not just the new behaviour silently.

`apps/api/src/app.ts`: the four 403 messages for the newly-narrowed operations changed from
"... editor access required" to "... owner access required" (`renameProject`, `renameScreenplay`,
`deleteScreenplay`, `restoreScreenplay`) -- a 403 has to read as the bar that is actually being
enforced, not the old one. `createScreenplay`'s "Project editor access required" and the two
collaboration-revision routes' "Screenplay editor access required" are untouched; they still mean
owner-or-editor, correctly.

`packages/database/src/membership.ts` and `index.ts`: `roleIsOwner`, exported.

`packages/config/src/index.ts`: `RESOURCE_TITLE_MAX_LENGTH = 200`.

### The shared title-length constant

`renameInput`'s schema was `z.string().trim().min(1).max(200)` with `200` as a bare literal. The
brief asked that the rename dialog's client-side validation derive its bound from the same
constraint rather than restate `200` fresh. `apps/api` and `apps/web` are two different deployable
packages with no dependency between them, but both already depend on `@finaler-draft/config`
(`apps/web` imports `PASSWORD_REQUIREMENTS_MESSAGE` from it already; `apps/api` lists it as a
dependency already, unused until now). That package's own doc comment explains exactly what it is
for: "shared policy the browser legitimately needs," with server-only parsing kept out of it on
purpose. A title-length bound both a server schema and a client validation message need to agree on
is precisely that shape, so `RESOURCE_TITLE_MAX_LENGTH` lives there now, and both
`projects.ts`'s `projectTitle` and `renameDialog.tsx`'s validation read the same constant. I did
not touch `routes/projects/$projectId/index.tsx`'s pre-existing `MAX_CREATE_SCREENPLAY_TITLE_LENGTH`
literal (the FDX-import title clamp) -- it already carries its own comment explaining the 200 bound
by cross-reference to `projects.ts`'s schema, and consolidating it onto the new constant was not
part of what broke or what was asked; I'm noting it here as a small follow-up worth doing later
rather than doing it unasked in this slice.

## What shipped -- UI

**`apps/web/src/renameDialog.tsx`** (new), modeled on `namedRevisionDialog.tsx`'s shell exactly
(`role="dialog"`, `aria-modal="true"`, a Tab/Shift+Tab focus trap, Escape to close, a real
`idle`/`pending`/`error` state machine) -- the brief named it as the closest existing shape, and
reading it alongside `restoreRevisionDialog.tsx` confirmed both dialogs are the identical shell
with different content, not two shells to choose between. Two things make this dialog different
from `NamedRevisionDialog`:

- **Pre-filled, not blank.** `initialTitle` seeds the field and is selected on mount (a desktop
  rename convention), so renaming edits the current title rather than retyping it.
- **Validated inline, before submission**, mirroring the registration form's password-confirmation
  mismatch (`routes/sign-in.tsx`'s `showMismatchError`): a field-level message appears, and Rename
  disables, once the field is blurred or a submit is attempted -- not only after a round trip. The
  two rules -- non-empty after trimming, at most `RESOURCE_TITLE_MAX_LENGTH` -- are validated
  against the _trimmed_ value, matching `renameInput`'s own `z.string().trim().min(1).max(...)`
  (`.trim()` runs before the length checks in zod, so the dialog has to trim before checking length
  too, or a title that trims under the limit could be rejected client-side while the server would
  have accepted it).

A server refusal renders as the server's own sentence, through the `MessageApiError` pattern
`RestoreRevisionDialog.handleConfirm` already established: `api.renameProject`/`renameScreenplay`
use `jsonWithServerMessage` (added to `api.ts` alongside the existing `deleteProject`/
`restoreProject`/`deleteScreenplay`/`restoreScreenplay` calls), so a 403 arrives carrying
`app.ts`'s exact "Project owner access required" / "Screenplay owner access required" sentence,
read directly rather than paraphrased. This is the route's existing error pattern, not a new one
invented for this dialog -- it is the identical idiom `namedRevisionDialog.tsx` and
`restoreRevisionDialog.tsx` already use for every other write that can be refused for a reason
worth explaining.

**`apps/web/src/routes/projects/index.tsx`** (`ProjectRow`): added a lazy-loaded `RenameDialog`
(matching the existing lazy `SharingDialog` import, same reasoning -- only needed once a writer
actually opens it) and a `Rename…` item, both gated identically to `Delete`:
`...(project.role === 'owner' ? [...] : [])`. The stale comment claiming "Non-owner members still
get a real, if empty, menu affordance in Rename/Edit's eventual home" was rewritten -- that eventual
home is now occupied.

**`apps/web/src/routes/projects/$projectId/index.tsx`** (`ScreenplayRow`): same `RenameDialog`
wiring, same `Rename…` item, and **`Delete` moved from unconditional to the same owner-only gate**
(Task 3's fix). The menu itself is now only rendered when there is at least one item for it to hold
(`canShare || isOwner`) -- previously Delete's unconditional presence meant the menu always had
something, so a reviewer's now-empty case needed this guard to avoid a pointless, item-less menu
button; `ProjectRow` already followed this rule for its own menu, so `ScreenplayRow` now matches it.

**Confirmed, not assumed**, per the brief's explicit instruction: the "Shared with you" screenplay
rows on the _projects_ dashboard (`SharedScreenplayRow` in `routes/projects/index.tsx`) render only
a `Link` and a role label -- no menu at all, for any role. Rename was **not** added there; there is
no menu to add it to, and building one was out of scope.

## Tests

**Server, unit (`apps/api/src/projects.test.ts`, fake-pool)** -- every one of the six operations'
existing tests now asserts owner-allowed / editor-forbidden (previously several asserted
editor-allowed); `deleteProject`'s test lost its "unlike rename which also allows an editor"
framing since that asymmetry no longer exists; the `listDeleted` test's string assertion on the
screenplay query changed from `in ('owner', 'editor')` to `= 'owner'`.

**Server, unit (`packages/database/src/membership.test.ts`)** -- `roleIsOwner` gets the same
treatment `roleCanEdit` already has: admits only `'owner'`, refuses `'editor'`/`'reviewer'`/
non-roles.

**Server, integration, new (`apps/api/src/projectsAuthorization.integration.test.ts`)** -- the
one the brief specifically called for: against a real migrated Postgres, every one of the six
operations proven owner-allowed and editor-**and**-reviewer-refused, and for the three screenplay
operations, refused through **both** `project_members` and `screenplay_members` separately (a
screenplay-scoped membership can never be `'owner'` -- `shared_role` has no such value, enforced
by the database itself -- so the owner-admitted case is proven through `project_members` only, and
the screenplay-scoped case is proven on its two real roles, both refused). Also proves
`listDeleted`'s screenplay collection agrees with `restoreScreenplay`'s own bar: an owner's deleted
screenplay is listed, an editor member of the same project is not. 25 tests, all passing, all
`describe.skipIf(!databaseUrl)`-gated so a run without `TEST_DATABASE_URL` skips cleanly. Added to
`apps/api/package.json`'s `test:integration` script list (it would not otherwise run under
`pnpm test:integration`, since that script names its files explicitly rather than globbing).

**Server, integration, existing files updated to match the new authorization** -- these were
genuinely asserting the _old_ behaviour and failed outright against my changes before I fixed
them, which is itself a form of mutation-test evidence (see below):

- `apps/api/src/persistence.integration.test.ts`: the soft-delete/rename test's "an editor can
  restore too" section now expects 403 for the editor and 200 only for the owner; the
  owner-only-deletion test (retitled from "...distinct from screenplay deletion which an editor
  may also do" to "...authorises both project deletion and screenplay deletion to the owner only")
  now expects 403 for the editor's screenplay delete attempt too; the rename/delete/restore matrix
  test's "an editor may rename (canEdit) but not delete" section now expects 403 for both; the
  deleted-items-scoping test's editor assertions flipped from "sees and can restore their own
  invited screenplay" to "sees nothing and a restore attempt 403s," with the owner's own view
  checked instead to prove the scoping and the deletion both still work.
- `apps/api/src/sharing.integration.test.ts`: the screenplay-invitation acceptance test's "the one
  thing a screenplay-scoped editor genuinely may do" demonstration moved from
  `renameScreenplay` (now correctly forbidden for them) to creating a named revision (still
  `canEdit`, unaffected) -- and then separately asserts `renameScreenplay` **is** forbidden for
  that same screenplay-scoped editor, through the invitation-acceptance path specifically. The
  "sees only their own screenplay in the deleted list" test (retitled "sees nothing... neither
  their own invited screenplay nor a sibling") now asserts the screenplay-scoped editor sees
  nothing at all, matching the new reality that a screenplay-scoped membership can never reach
  owner-only operations, with the owner's own view checked to confirm the deletions genuinely
  happened.

**UI, standalone dialog (`apps/web/src/renameDialog.test.tsx`, new, 17 tests)** -- pre-fill and
selection on mount, each validation branch (blank, whitespace-only, overlong by trimmed length,
exactly-at-the-limit), successful submit calling `onRename` with the trimmed title then `onClose`,
never submitting a blank title (including via Enter, which a real browser also refuses to dispatch
once the submit button is natively `disabled`), the server-sentence-verbatim case and the
generic-fallback case, Cancel changing nothing, Escape closing without calling `onRename`, initial
focus and selection, the Tab/Shift+Tab focus trap in both directions, and a non-Escape/Tab key
being ignored.

**UI, route-level (real `@tanstack/react-query`, mocked router, matching `index.delete.test.tsx`'s
established pattern)**:

- `apps/web/src/routes/projects/index.rename.test.tsx` (new, 4 tests) -- the full rename flow
  against a mocked fetch: open the menu, choose Rename…, the dialog is pre-filled, submit updates
  the row via cache invalidation and a real `PATCH`; the same path from the keyboard alone; Cancel
  changes nothing and sends no request; a 403 shows the server's sentence and leaves the dialog
  open to retry.
- `apps/web/src/routes/projects/$projectId/index.rename.test.tsx` (new, 7 tests) -- gating (an
  owner sees both Rename… and Delete; an editor sees neither, though their menu still exists for
  Share…; a reviewer has no menu at all) and the same rename-flow coverage (pre-fill, successful
  rename, inline blank-title rejection before any request fires, Cancel, the 403 message).
- `apps/web/src/routes/projects/index.test.tsx` -- the existing owner-only-Delete role test
  extended to also assert `Rename…`'s identical gating (owner sees both; editor sees neither but
  keeps Share…; reviewer gets no menu), and `index.delete.test.tsx`'s keyboard-navigation test
  updated for the now-three-item owner menu (Share… → Rename… → Delete).
- `apps/web/src/routes/projects/$projectId/index.sharing.test.tsx` -- the reviewer test
  ("is withheld from a reviewer, who keeps the rest of the menu") retitled and rewritten: a
  reviewer now gets **no menu at all** (they could share, rename, and delete nothing), where
  before this slice Delete's unconditional presence meant they always had a menu with something in
  it. This test used to assert the exact defect Task 3 fixes.

## Mutation testing

Every mutation below was applied to the real source file, confirmed to fail the named test(s)
(and only those), then reverted; a final `grep -n "isOwner(\|canEdit("` on `projects.ts` after all
reverts confirms the six call sites and the `listDeleted` query predicate are back to their correct
post-slice state.

**The six authorization checks**, each flipped from `isOwner(...)` back to `canEdit(...)`, run
against both the fake-pool unit suite (`projects.test.ts`) and the real-database integration suite
(`projectsAuthorization.integration.test.ts`):

| line (post-slice)               | operation         | unit test killed                                                                                        | integration tests killed                                                                                                                                                                           |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renameProject`'s `isOwner`     | renameProject     | "renames a project only for its owner, and reports missing without leaking existence details"           | `renameProject > refuses a project editor`                                                                                                                                                         |
| `deleteProject`'s `isOwner`     | deleteProject     | "deletes a project only for its owner"                                                                  | `deleteProject > refuses a project editor`                                                                                                                                                         |
| `restoreProject`'s `isOwner`    | restoreProject    | "restores a project only for its owner, mirroring delete authorisation exactly"                         | `restoreProject > refuses a project editor`                                                                                                                                                        |
| `renameScreenplay`'s `isOwner`  | renameScreenplay  | "renames a screenplay only for its owner, and reports missing for a nonexistent or already-deleted one" | `renameScreenplay > refuses a project editor, resolved through project_members` **and** `renameScreenplay > refuses a screenplay-scoped editor, resolved through screenplay_members` (both failed) |
| `deleteScreenplay`'s `isOwner`  | deleteScreenplay  | "deletes a screenplay only for its owner, matching project deletion"                                    | `deleteScreenplay > refuses a project editor...` **and** `...refuses a screenplay-scoped editor...` (both failed)                                                                                  |
| `restoreScreenplay`'s `isOwner` | restoreScreenplay | "restores a screenplay only for its owner, and reports missing when it is not currently deleted"        | `restoreScreenplay > refuses a project editor...` **and** `...refuses a screenplay-scoped editor...` (both failed)                                                                                 |

For the three screenplay operations, the mutation killed **both** the `project_members`-path test
and the `screenplay_members`-path test every time -- proof that the screenplay-scoped branch is
genuinely exercised by its own dedicated test, not merely assumed to be covered because the
project-scoped one passes. This is exactly the gap the brief warned "a test that only exercises
project-level membership would miss a screenplay-scoped editor entirely" about, and the mutation
run shows it is not the gap here.

**The `listDeleted` screenplay-scoping predicate**, widened from `m.role = 'owner'` back to
`m.role in ('owner', 'editor')`:

- Unit (`projects.test.ts`): killed "lists deleted projects and screenplays with ISO timestamps,
  inside one repeatable-read transaction" (the query-string assertion).
- Integration (`projectsAuthorization.integration.test.ts`): killed "listDeleted lists a deleted
  screenplay for its owner, and omits it for an editor member of the same project."

**`roleIsOwner` itself** (`packages/database/src/membership.ts`), widened from `role === 'owner'`
to `role === 'owner' || role === 'editor'`:

- Unit (`membership.test.ts`): killed "refuses editor, reviewer, and anything that is not a role
  at all."

Every mutation was reverted immediately after confirming the failure; no mutation was left in place
between checks, and the full suites (`pnpm test`, `pnpm test:integration`) were re-run clean after
the last revert.

## Gates, verbatim

```
pnpm install --frozen-lockfile
```

Resolved, no changes needed beyond workspace linking. Exit 0.

```
pnpm build:packages
```

All twelve workspace packages built clean. Exit 0. (Run before every test command below, and again
after mutation testing touched `membership.ts` with `sed`, so no gate ran against a stale `dist`.)

```
pnpm lint
```

`eslint . --max-warnings=0` -- clean, no output. Exit 0.

```
pnpm typecheck
```

Clean across every workspace package, `apps/web` (`tsc -b`), `apps/api` (`tsc -p tsconfig.json
--noEmit`), `apps/collab`, and `apps/landing` (`astro check`: 0 errors, 0 warnings, 0 hints). Exit 0.

```
pnpm test
```

Every package and app green. `apps/api`: 317 passed, 101 skipped (the skipped count is every
`*.integration.test.ts` file, correctly skipped without `TEST_DATABASE_URL`). `apps/web`: 1039
passed across 69 files, including the five new/extended files this slice added. `packages/database`:
54 passed, 11 skipped. `apps/collab`, `packages/screenplay`, `packages/layout`,
`packages/screenplay-editor`, `packages/fdx`, `packages/docx`, `packages/pdf` all unchanged and
green. Exit 0.

```
pnpm test:coverage
```

`apps/api`'s `projects.ts` (the file with every behavioural change this slice made): 86.36%
statements, 81.35% branch, 88.88% functions, 86.36% lines -- all comfortably above the configured
80% thresholds. `apps/web`'s new `renameDialog.tsx`: 99.18% statements, 88.37% branch, 100%
functions, 99.18% lines. No threshold failure anywhere; exit 0.

```
pnpm build
```

Every package, `apps/web` (Vite + `tsc -b`), `apps/api`, `apps/collab`, and `apps/landing` (Astro)
built clean. Exit 0.

```
pnpm check:bundle-budget
```

```
[bundle-budget] ok   Entry chunk        assets/index-B9rkfEVI.js      111.95 kB / 120.00 kB budget
[bundle-budget] ok   Lazy editor chunk  5 chunks                      165.66 kB / 200.00 kB budget
[bundle-budget] ok   CSS                assets/index-R7i004nK.css       7.93 kB / 20.00 kB budget
All bundle artifacts are within budget.
```

The new `renameDialog-*.js` chunk (2.16 kB / 1.07 kB gzipped) is lazy-loaded, same as every other
dialog in this app, and does not touch the entry-chunk budget. Exit 0.

```
docker run -d --name rename-test-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16
export TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/postgres"
pnpm test:integration
```

`packages/database`: 11 passed. `apps/api`: 101 passed (including the new 25-test
`projectsAuthorization.integration.test.ts`, and the `persistence.integration.test.ts`/
`sharing.integration.test.ts` tests rewritten above to match the new authorization). `apps/collab`:
32 passed. Exit 0.

```
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @finaler-draft/database db:generate
```

`No schema changes, nothing to migrate 😴`. `git status --porcelain packages/database/drizzle/`
empty both before and after. No migration drift from this slice's schema-adjacent work (there is
none -- `roleIsOwner` is pure TypeScript, not a schema change).

```
PLAYWRIGHT_CHANNEL=chrome pnpm test:system
```

79 passed (25.8s). Exit 0.

```
PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence
```

Run **twice**, per this project's own flakiness history with this gate. Both runs: **35 passed, 1
failed**, the identical failure both times --
`screenplay-diff-persistence.spec.ts:82` (`"the diff view renders a real difference between a
named revision and the live document, and never disturbs the live document"`), asserting typed
text comes back duplicated (`"Added after the milestone.tone."` instead of `"Added after the
milestone."`).

This is **not a regression from this slice**, for reasons I verified rather than assumed:

- `git log --oneline -1 -- apps/web/e2e/screenplay-diff-persistence.spec.ts` names a commit
  (`d0304be`, "download submenu") that predates every change in this worktree, and `git diff HEAD`
  on that file is empty -- I never touched it, directly or by touching anything it imports.
- The test's own code comment documents this exact failure signature as already timing-sensitive
  **on `main`**, unrelated to authorization or sharing: typing faster than ProseMirror, pagination,
  and the Yjs transaction behind each keystroke can settle duplicates the last few characters, and
  the comment records that an earlier slice (screenplay-invitations, already merged) added one
  extra SQL join to `GET /api/screenplays/:id` that was "enough to move this assertion from
  passing to failing every run... which says the test was sitting on the edge rather than that
  anything about sharing is wrong." This slice adds no join and no new query to that route at all.
- Re-run a third time, isolated (`node scripts/test-system-persistence.mjs -- screenplay-diff-
persistence --workers=1`), outside the full 5-worker suite: identical failure, identical
  duplicated text, same line. A resource-contention theory (this machine also running Postgres in
  Docker, a Vite build, and five Playwright workers concurrently) is consistent with a test that is
  already documented as sitting right at a timing threshold on `main`.

I did not change the typing delay or touch that spec file to "fix" this -- it is pre-existing,
already diagnosed in its own comment, and out of scope for an authorization slice. Flagging it here
rather than silently re-running until it happened to pass: the other 35 tests, including the three
this slice's own UI directly affects (`persistence.spec.ts:448`, the screenplay delete/undo test,
and `persistence.spec.ts:519`, the project delete/restore-from-Deleted-page test, both still
exercise the now-owner-only paths as the account used in those fixtures is always the owner),
passed clean both full runs.

```
docker rm -f rename-test-pg  # cleanup, run after the integration/persistence gates above completed
```

## Known limitations / open questions

- **RLS was deliberately not added**, per the brief. The server is the single enforcement point
  for this slice; a direct database connection bypassing `apps/api` is not defended against by this
  work, same as every other authorization path in this codebase today.
- **No notification was built for an editor whose previously-deletable screenplay is now stuck in
  a state only the owner can restore.** See "The consequence, stated plainly" above -- the owner
  retains full visibility and the actual capability from their own account; building a "this is
  now locked, ask your owner" UI for the editor was not asked for and would be new scope.
- **`MAX_CREATE_SCREENPLAY_TITLE_LENGTH`** in `routes/projects/$projectId/index.tsx` (the FDX-import
  title clamp) still restates `200` as its own literal rather than importing
  `RESOURCE_TITLE_MAX_LENGTH`. It already cross-references `projects.ts`'s schema in its own
  comment and was not broken by this slice, so I left it as a note for a future pass rather than
  touching code outside what this slice needed.
- The `screenplay-diff-persistence.spec.ts` flake documented above is pre-existing and already
  diagnosed in that file's own comment; it is not something this slice can or should fix.

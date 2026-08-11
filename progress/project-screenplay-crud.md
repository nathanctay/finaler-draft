# Scope: project-screenplay-crud

Branch: `feature/project-screenplay-crud`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/project-screenplay-crud`
Base: `main` @ `288ad57`
Owner: Sonnet implementation agent, advised by the lead.

## Why this scope exists

`plan.md`: "Rename and soft-delete for projects and screenplays. Deletion is always soft;
screenplays are the asset a user least wants a stray click to destroy." This is the second item in
the remaining Phase 1 order.

Read the specification from `/Users/nathan/Documents/finaler draft/plan.md` — the **main** worktree
copy, not the snapshot in your own worktree. Do not edit either.

## What exists now

- `packages/database/src/schema.ts`: `projects` and `screenplays` tables. Neither has any deletion
  column. `screenplays.projectId` references `projects.id` with `onDelete: 'cascade'`, and
  `projectMembers` cascades from both `projects` and `user`.
- `apps/api/src/projects.ts`: the `ProjectStore` interface — `listProjects`, `createProject`,
  `listScreenplays`, `createScreenplay`, `getScreenplay`, `updateScreenplay`. Authorisation is
  enforced in the store, per actor.
- `apps/api/src/app.ts`: routes now declare Zod `params`/`body`/`response` schemas through
  `withTypeProvider<ZodTypeProvider>()`. The auth hook runs at `preValidation` deliberately — read
  the comment there before touching it; moving it changes 401/400 precedence.

## 1. Rename

Add rename for both projects and screenplays. Follow the existing route and store conventions
exactly — declared schemas, store-enforced authorisation, the existing title constraints
(`z.string().trim().min(1).max(200)`, matching the `varchar(200)` columns).

Renaming a screenplay must not touch `canonicalScreenplay`, `canonicalHash`, or `version`. The
title on the screenplay row and the `title` inside the canonical document are different fields;
decide explicitly whether they are meant to stay in sync, state your answer, and make the code match
it rather than leaving the relationship implicit.

## 2. Soft delete

Deletion is always soft. Nothing this slice adds may remove a row.

- Add the deletion column(s) to `projects` and `screenplays` with a Drizzle migration. Follow the
  existing migration conventions in `packages/database`.
- **Every existing read path must exclude soft-deleted rows** — lists, direct fetch, and the
  authorisation checks. A soft-deleted screenplay must behave as though it does not exist: 404, not
  403, and not a readable document.
- Deleting a project must make its screenplays inaccessible too. Note the existing FK is
  `onDelete: 'cascade'`, which is about _hard_ deletes and does not help here. Decide between
  cascading the soft delete to child rows and filtering by the parent's state on read, state the
  trade-off you are accepting, and be consistent. Whichever you choose, a screenplay whose project
  is deleted must not be reachable by direct id.
- Provide restore. Soft delete without restore is just a slower delete, and `plan.md`'s reason for
  soft deletion is protecting against a stray click.
- Uniqueness and listing behaviour must be considered: a deleted project must not occupy a name or
  appear in any list.

Do **not** build a trash/restore interface in the web app beyond what is needed to exercise the
endpoints; the interface design for that is not settled. If you think a UI affordance is
unavoidable, stop and ask rather than inventing one.

## 3. What this slice must not break

`updateScreenplay`'s optimistic concurrency (`expectedVersion`, terminal 409) is load-bearing and
untouched by this scope. Saving to a soft-deleted screenplay must fail as not-found rather than
succeeding or producing a confusing conflict.

## Out of scope

No Yjs. No title page, scene numbers, or document settings. No export formats. No changes to
`packages/layout`, `packages/screenplay`, or the pagination path. No auth changes. No new
dependencies without asking.

## Verification required before handoff

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck` — clean tree, no prior build
4. `pnpm test:coverage`
5. `pnpm build`
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`
7. The persistence gate — required, this slice is all API and database
8. `git diff --check`
9. **No credential may appear in any file you write**, including `progress/`. The test database URL
   is passed inline on the command line only. The previous slice wrote it into its progress log in
   the same sentence that claimed it had not; check your own output before reporting.

Run `pnpm format:check` **after** you finish writing your progress entry — two consecutive slices
reported that gate clean and left it failing because the log was appended afterwards.

The API server serves a **prebuilt** web bundle: run `pnpm --filter @finaler-draft/web build`
before any browser gate. Kill stale servers on the gate ports first.

## Testing standard

For every test guarding specific behaviour: **break the behaviour, confirm the test fails, restore**,
and report it. Additionally, **run the persistence gate at least three times** and report the
results — a test that passes once may still be flaky, and a 1-in-4 flake was found in this suite
that mutation-testing alone did not reveal.

Security-relevant assertions to get right, because a weak version of each looks identical:

- A soft-deleted screenplay returns **404, not 403**, to a user who could otherwise read it.
- A user who was never authorised still gets the same answer they got before.
- Restore is authorised the same way delete is.

## Rules

- Do not stage, commit, merge, rebase, force-push, reset, or create/delete worktrees. The owner
  controls staging, committing and pushing. If you find files staged, report it and leave them.
- Do not read, print, or commit `.env` files or any credential.
- No TODO, FIXME, or placeholder comments. No emojis. Strict TypeScript, `.js` extensions on
  relative imports.
- If anything contradicts the specification, stop and report rather than bending the spec.
- If a command hangs for more than a few minutes, stop and report rather than polling.

## Checkpoints — report to the lead with SendMessage

1. **The data model and migration, before writing it.** The deletion column shape, how project
   deletion reaches screenplays, and what happens to reads. Wait for a reply.
2. **After the store and routes work, before the tests are finished.** Report the endpoint list and
   status codes.
3. On completion, with gate results, the mutation-testing report, and the repeated persistence runs.

## Log

### 2026-08-11 — lead — scope opened

Status: ready-for-implementation
Second item in the remaining Phase 1 order, opened after platform hygiene and the persistence-gate
bundle fix merged.

### 2026-08-11 — implementation agent — complete

Status: ready-for-review

**Data model.** Nullable `deleted_at timestamptz` added to `projects` and `screenplays`
(`packages/database/src/schema.ts`), migration `drizzle/0002_pale_leper_queen.sql` generated via
`db:generate`, not hand-written. `NULL` means active; a timestamp means soft-deleted. No boolean
flag.

**Cascade design.** Project deletion does not write to child screenplay rows. Every
screenplay-touching read and write in `apps/api/src/projects.ts` joins to `projects` and requires
`deleted_at is null` (or, for restore, the screenplay's own row specifically requires
`deleted_at is not null`, while the project join is still required active). A single helper,
`lockScreenplayRow`, is the one place every transactional screenplay operation
(`updateScreenplay`, `renameScreenplay`, `deleteScreenplay`, `restoreScreenplay`) performs that
lookup, so the project-active requirement holds by construction there rather than by convention.
`getScreenplay` and the two project-level methods use the same predicates inline, since their
query shapes genuinely differ (no locking, different joins) and folding them into one helper would
have obscured more than it centralized. This was approved by the lead at checkpoint 1, with the
explicit trade-off that correctness depends on every such query living inside this file.

**Endpoints added**, all behind the existing `preValidation` auth hook:

- `PATCH /api/projects/:id` (rename, owner or editor) and `PATCH /api/screenplays/:id` (rename,
  owner or editor)
- `DELETE /api/projects/:id` (soft delete, **owner only**) and `DELETE /api/screenplays/:id` (soft
  delete, owner or editor)
- `POST /api/projects/:id/restore` and `POST /api/screenplays/:id/restore` — each mirrors its
  resource's delete authorisation exactly

Delete and restore return `200` with a JSON body (`{ id }` for delete, `{ id, title }` for restore)
rather than `204`, for consistency with every other endpoint in this API and to avoid an
empty-body edge case in the zod response serializer this codebase just adopted.

A non-member gets `404` (must not learn the resource exists); a member with an insufficient role
gets `403` (they already know it exists). Both sides of that split are asserted with real Better
Auth sessions against a real database in `persistence.integration.test.ts`, not only against the
fake store.

**Title independence.** `renameScreenplay` writes only `screenplays.title`. It never touches
`canonicalScreenplay`, `canonicalHash`, or `version` — those live inside the version-guarded
document and can only change through `updateScreenplay`. Proven against a real save: after a row
rename, the in-document `screenplay.title` is unchanged.

**`createScreenplay` extended.** Its membership lookup now also requires the project active, so a
soft-deleted project cannot silently accept new screenplays that no read path could then reach.
The route's existing status code is unchanged (a nonexistent project already collapsed to `403`
before this slice); this only widens which conditions produce that same outcome.

**Testing.** `projects.test.ts` store-level unit tests, `app.test.ts` HTTP-status-mapping tests
against a fake store, and `persistence.integration.test.ts` real-PostgreSQL, real-Better-Auth
integration tests covering: rename/delete/restore for both resources; list exclusion for deleted
rows and rows under a deleted project, with active siblings proven still visible in the same list
call; a direct `getScreenplay` 404 when only the parent project is deleted; the four
security-relevant assertions from the lead's checkpoint-1 reply (save into a soft-deleted
screenplay is 404 not 409; restoring a screenplay whose project is still deleted is 404; restoring
something not currently deleted is 404, stated and tested explicitly; 404-not-403 asserted for a
user who could actually read the resource before deletion, not a stranger); the filter-design
proof that a screenplay deleted independently before its project stays deleted after the project
is restored; and the owner-only vs owner-or-editor authorisation split for project vs screenplay
deletion, both with non-member/wrong-role/correct-role cases.

**Mutation testing.** Nine load-bearing predicates/checks were each broken, confirmed to fail the
test that guards them, then restored: `listProjects`'s and `listScreenplays`'s exclusion
predicates (including the project-half of the latter, isolated from the screenplay-half);
`getScreenplay`'s deleted-state predicates; `lockScreenplayRow`'s unconditional project-active
requirement on the restore path; `deleteProject`'s owner-only check (weakened to `canEdit`);
`restoreScreenplay`'s and `restoreProject`'s requirement that the row actually be deleted;
`updateScreenplay`'s `expectedVersion` conflict check (confirming the pre-existing optimistic-
concurrency path is unweakened by the `lockScreenplayRow` refactor — caught by both the untouched
unit test and the untouched real-database concurrency test); and `createScreenplay`'s
project-active guard. One mutation (`restoreScreenplay`'s "not deleted" case) was caught only by
the real-database integration test, not the fake-store unit test, because the fake store returns
canned rows regardless of the actual SQL predicate — a reminder that the integration suite is load-
bearing for this class of defect, not merely a formality.

**Gates.**

- `pnpm format:check` — run after this entry was written, per instruction.
- `pnpm lint` — clean.
- `pnpm typecheck` — clean, from a clean tree, no prior build (the root script builds leaf
  packages first).
- `pnpm test:coverage`, run with the test database wired in so the integration suite is included:
  `projects.ts` 94.93% statements / 89.01% branches / 100% functions; `app.ts` 99.41% / 93.54%.
  Remaining gaps are unexercised `catch` blocks for genuine unexpected database errors, consistent
  with the pre-existing pattern elsewhere in the file.
- `pnpm build` — clean.
- `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — 21/21 passed. No UI was added for this slice, so
  this gate's job is confirming no regression, not exercising the new feature.
- The persistence gate (`pnpm test:system:persistence`, browser-driven, real disposable database),
  run three times as required: **6/6 passed on run 1, 6/6 on run 2, 6/6 on run 3.** No flake
  observed. This gate's existing specs predate this slice and don't exercise soft-delete (no UI
  affordance was added, per the scope's explicit instruction); it verifies no regression to
  autosave, session routing, and page-rendering persistence.
- `git diff --check` — clean.
- No credential appears in this entry or any file changed in this slice. The test database URL was
  passed inline on the command line only, for every gate that needed it.

**Scope notes.** No UI was added, per the scope's explicit instruction not to build a trash/restore
interface beyond what's needed to exercise the endpoints; the persistence gate's `page.request`-
style real-API coverage plus the integration suite above serves that role instead. Files touched:
`packages/database/src/schema.ts`, `packages/database/drizzle/0002_pale_leper_queen.sql` (and its
snapshot/journal), `apps/api/src/projects.ts`, `apps/api/src/app.ts`, and their three test files.
Nothing outside `apps/api` and `packages/database` was changed. No files were staged; the owner
controls staging and commit.

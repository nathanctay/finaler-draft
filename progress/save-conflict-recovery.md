# Save-conflict recovery (audit A2)

Branch `fix/save-conflict-recovery`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/save-conflict-recovery`.

## Why this scope exists

`audit/CONSOLIDATED.md` item A2, found independently by two vendors and rated the sharpest
violation in the codebase, measured against `plan.md`'s "A writer must never lose access to their
own work."

The server side is correct and must not be touched: optimistic locking uses `for update`, rejects a
stale version before incrementing, and returns a terminal 409. The defect is entirely client-side,
in `apps/web/src/App.tsx`:

1. Once `saveStateRef.current === 'conflict'`, both `scheduleSave` and `saveLatest` return early on
   every subsequent call, **permanently**. Nothing ever clears it. Contrast `'failed'`, which
   `scheduleSave` deliberately recovers from on the next edit.
2. The status message reads "your local edits are preserved; reload before saving again."
   **Nothing preserves them.** There is no `localStorage`, `sessionStorage` or `indexedDB` anywhere
   in `apps/web/src`. Following that instruction destroys the work it promises to protect.
3. In-app navigation cannot rescue it either: the query is `staleTime: Infinity` with
   `refetchOnMount: false`, so it re-serves the same stale `version`.
4. Editing stays fully enabled while every save is suppressed. There is an `aria-live` status, so
   this is subtle rather than silent -- but there is no dialog, no disabled editor, no recovery
   action, and no navigation guard.
5. Smaller sibling, same family: unmount clears the debounce timer without flushing, so navigating
   away within 600 ms drops the last edit. There is no `beforeunload`, `visibilitychange`,
   `pagehide`, `sendBeacon` or `keepalive` anywhere in `apps/web/src`.

## The owner's ruling on scope

`plan.md` schedules this whole client-side save module for deletion when Yjs lands in Phase 2.
Durable local drafts (IndexedDB and a real recovery flow) were considered and **rejected**: it is a
slice, and Yjs would delete most of it. Phase 1 still has export, SmartType, the Characters tab,
zoom and auth hardening outstanding, so the conflict path stays reachable for a while yet -- long
enough that a false promise and a dead end are not acceptable in the meantime.

**The ruling: make the failure honest and survivable, without building a storage layer.** Stop
promising preservation, give the writer the means to rescue their work themselves, and give them a
clean exit. That is hours of work, not a slice.

## What this must achieve

1. **The message must stop lying.** It may not claim anything is preserved. It should say what is
   actually true: this screenplay changed somewhere else, this browser's copy has not been saved,
   and saving is paused so the other version is not overwritten.
2. **"Copy my version" must actually rescue the work.** A real, keyboard-reachable button in the
   conflict state that copies the writer's current manuscript to the clipboard as readable
   screenplay-formatted plain text -- not canonical JSON, which a writer cannot paste anywhere
   useful. Report success or failure honestly; the Clipboard API can reject, and a button that
   silently does nothing in that case would repeat the defect this scope exists to fix.
3. **A clean, explicit exit.** A "Reload" action that discards the local copy and re-fetches the
   server's version. It must be explicit and clearly labelled as discarding, and it must not be the
   only thing on offer -- copy first, then leave.
4. **Do not auto-clear the conflict and resume saving.** The 409 means the server genuinely holds a
   newer version; silently resuming would overwrite whatever the other session wrote. Recovery is
   the writer's decision, taken through one of the actions above. Saving stays paused until then,
   deliberately -- this part of the current behaviour is correct and the reason it exists must
   survive in a comment.
5. **Stop dropping the last edit on the way out.** Flush a pending debounced save when the
   component unmounts and when the page is hidden (`visibilitychange`/`pagehide`). Use `fetch` with
   `keepalive` rather than `sendBeacon` -- the save is an authenticated `PUT` with headers, which
   `sendBeacon` cannot express. This must respect the same conflict rule: never flush while in the
   conflict state.

## Out of scope

Any change to `apps/api` or the server's optimistic-concurrency contract. IndexedDB, localStorage,
or any durable draft store. Yjs. A diff or merge UI. Export formats -- FDX export will eventually
supersede the clipboard rescue, and that is a separate Phase 1 slice.

## Verification

The full gate list, `pnpm format:check` run **after** writing your progress entry, and the
persistence gate run at least three times. This base is clean: it is post-merge `main` with every
gate passing, so any failure is yours.

The persistence suite already drives a real 409 against the real API and database. Extend that
coverage rather than mocking it: a test that only exercises a stubbed conflict proves nothing about
the path a writer actually hits.

For every test guarding specific behaviour: break the behaviour, confirm the test fails, restore,
and report it. Green does not mean working -- this project has found five vacuous tests so far, one
of them written by the lead. The two most likely to pass vacuously here are "the conflict message
does not promise preservation" (assert on the real rendered text, not on a constant you also
control) and "a pending edit is flushed on hide" (make sure the assertion would fail if the flush
never fired, rather than passing because the debounce had already elapsed).

No credential may appear in any file you write, including your progress log.

## Rules

Do not stage, commit, merge, rebase, force-push, reset, or create or delete branches or worktrees --
the owner controls staging, committing and pushing. No TODO or placeholder comments, no emojis,
strict TypeScript, `.js` extensions on relative imports. Match the surrounding comment style: this
codebase records _why_ a decision was made, with reference to `plan.md`. If the code contradicts the
specification, stop and report rather than bending either.

## Checkpoints -- SendMessage to the lead

1. After the conflict-state UI and copy action work, before the flush-on-hide work: report what the
   conflict state now shows and what "Copy my version" produces. **Wait for a reply.**
2. Completion, with gate results and the mutation-testing report.

### 2026-08-20 — complete (implementation agent; verification completed by the lead)

Status: ready-for-review. The implementation agent reached an API failure partway through its
mutation-testing pass (the machine slept mid-response); the code was already complete. The lead
verified the tree was left unmutated, re-ran every gate, and independently reproduced the three
mutations that matter most.

#### What shipped

**The message stopped lying.** The conflict status now reads "Save conflict · this screenplay
changed elsewhere; this copy is unsaved and saving is paused", replacing "your local edits are
preserved; reload before saving again". Nothing preserved them -- there is no `localStorage`,
`sessionStorage` or `indexedDB` anywhere in `apps/web/src` -- so the old copy sent a writer away
from the one place their unsaved work still existed.

**Two rescue actions**, rendered outside `.status-center` so they survive the narrow-viewport rule
that hides it: "Copy my version" and "Reload (discards this copy)". Copy feedback is its own live
region, reporting a Clipboard API rejection honestly rather than silently doing nothing.

**`screenplayToPlainText`** (`packages/screenplay`): renders the canonical model as readable
screenplay-formatted plain text, not canonical JSON a writer cannot paste anywhere useful. It does
no line wrapping, so it does not duplicate `packages/layout`'s `wrap.ts`, and its own comment
disclaims it as an export format -- FDX remains the real one. That disclaimer is load-bearing
against a future reader wiring this into export.

**Saving stays paused after a 409, deliberately.** The server genuinely holds a newer version, so
resuming would overwrite whatever the other session wrote. Recovery is the writer's explicit
choice through one of the two actions. This part of the old behaviour was correct; only the false
promise and the dead end were the defect.

**The last edit is no longer dropped on the way out.** Unmount, `visibilitychange` to hidden, and
`pagehide` all flush a pending debounced save, subject to every existing guard including the
conflict guard.

#### The defect the lead caught at checkpoint 1

The first implementation used `fetch(..., { keepalive: true })` for all three exits. **`keepalive`
caps the total request body at 64 KB (Fetch spec), and real screenplays are far past it** --
measured on this branch: 500 blocks of canonical JSON is 66.6 KB, 1500 blocks is 199 KB, 3000
blocks is 398 KB. The flush would have worked for the suite's tiny fixtures and failed for
essentially every real document, passing every test on the way.

Fixed by separating the exits, which are not the same situation. Unmount and `visibilitychange`
are in-app -- the page is not going away, an ordinary `fetch` completes normally, and there is no
size limit. Only `pagehide` may be a real teardown, so it alone passes `keepalive: true` and
accepts the cap, failing honestly (`saveState: 'failed'`, never `'saved'`) when over it.

#### Mutation testing

Nine mutations were run by the implementation agent before it died. The lead independently
re-ran the three protecting the properties most likely to pass vacuously:

- **`keepalive: true` restored on the unmount path** (the checkpoint-1 defect): 3 failures,
  including the over-cap test, with `expected { keepalive: true } to deeply equal
{ keepalive: false }`. That test asserts the flag rather than the byte limit deliberately --
  jsdom does not enforce the cap, so asserting the observable flag is the only honest way to guard
  it, and the test also asserts the payload really is over 64 KB.
- **The conflict message reverted to the old false promise**: 1 failure, on the test that asserts
  the real rendered text rather than a constant it also imports.
- **The conflict guard removed from `saveLatest`**: 4 failures, including the dedicated
  never-flush-while-conflicted test.

All restored; full suite re-verified green after each.

#### Gates (all re-run by the lead)

`lint`, `typecheck`, `build`, `git diff --check`, `format:check` clean. `test:coverage`: config 1,
server-config 6, database 4, screenplay 53, layout 63, api 78, web 187. `test:system` 21/21.
Persistence gate three runs: 9/9, 9/9, 9/9.

#### Known limitations / things not done

- **No durable draft store**, deliberately: the owner ruled against IndexedDB because `plan.md`
  schedules this whole client-side save module for deletion when Yjs lands in Phase 2. A writer who
  closes the tab in a conflict without copying still loses the unsaved copy. What changed is that
  the app no longer tells them it was preserved, and gives them a way to rescue it.
- **A `pagehide` flush of a document over 64 KB still cannot complete.** No browser mechanism
  exists for that; `sendBeacon` carries the same cap and cannot express an authenticated `PUT`. The
  common exits (route change, tab switch) are now reliable at any size, which is the reachable part
  of the problem.
- The older test named `preserves local edits and visibly locks automatic saves after a conflict`
  now overstates what it checks -- it asserts the conflict state appears and that exactly one save
  was attempted, not preservation of anything. Its assertions are correct; only the name is stale.
  Left alone rather than renamed mid-slice, flagged here.
- **`test:system` intermittently reports 20 passed and exits non-zero**, on this branch and on
  `main` alike, always on a first run under load and never reproducibly. It is not attributable to
  this slice. Note that `playwright.config.ts` sets `retries: 2` under CI and `0` locally, so CI
  will mask this as a passing flake rather than surface it.

# Collaboration slice 4a: durable revisions and historical preview

Branch `feature/collab-revisions`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/revisions`, off `f972f82` (current `main`).

## Why this scope exists

`plan.md`'s "Collaboration, history, and restoration" bundles revision history, a
screenplay-aware diff, and restore-as-current into one phase, but is explicit that they are
separate deliverables built in sequence. This slice is the first: **durable, immutable
revisions and read-only historical preview**, built on top of slice 3's append-only
`document_yjs_updates`/`document_yjs_checkpoints` log (`progress/collaboration-offline-durable.md`).
A screenplay-aware diff is slice 4b. Restore-as-current — an epoch cutover — is slice 5,
deliberately last, and nothing here builds toward it except by not foreclosing it.

## Schema

```
document_revisions
  id, screenplay_id, source_epoch, kind, label, authored_by, created_at,
  canonical_screenplay JSONB, canonical_hash, rendered_text, preview_metadata
```

**Naming: `screenplay_id`, not `document_id`.** Same reasoning slice 3 already recorded for
`document_yjs_updates`: `plan.md`'s own sketch predates this schema and names the column
`document_id`, but this codebase has no `documents` table — a screenplay _is_ the collaboration
document — and every sibling table (`document_yjs_updates`, `document_yjs_checkpoints`,
`document_yjs_quarantined_updates`) already uses `screenplay_id`. Matching the sketch over the
codebase as built would be adopting drift for its own sake.

**`kind`: a Postgres enum** (`'named' | 'idle_session' | 'structural_change' | 'export'`), not a
bare string — this codebase enums closed, finite value sets elsewhere (`project_role`,
`subscription_status`) and a revision's kind is exactly that.

**`source_epoch`**: carried forward at `DEFAULT_EPOCH` (0) today, for the identical
forward-looking reason slice 3 introduced `epoch` on the update log ahead of need — slice 5 is
specifically an epoch cutover, and a revision written under one epoch should stay attributable to
it afterward.

**`label`**: non-null only for `kind: 'named'`. Enforced by callers (zod at the API boundary,
the collab server's own triggers always pass `null`), not by the schema — the write path
(`insertRevisionIfChanged`, below) stays a thin, ungated layer, matching `updateLog.ts`'s
`appendUpdate`.

**`authored_by`**: nullable, `onDelete: 'set null'` — identical reasoning to
`document_yjs_updates.authenticated_actor_id`. `idle_session`/`structural_change` have no single
human author and always write `null`; `named`/`export` are explicit actions by a specific
authenticated actor and always write the actor's id.

**`canonical_screenplay`**: a full, independent copy of the projection at that moment —
deliberately not a foreign key or a diff against `screenplays.canonical_screenplay`, which is
mutable and will have moved on by the time anything reads a revision row. A revision is immutable
specifically because it owns its own copy.

**`canonical_hash`**: the identical sha256-of-serialized-JSON algorithm `screenplays.canonical_hash`
already uses. This is the column the dedupe invariant (below) is about.

**`rendered_text`**: `@finaler-draft/screenplay`'s existing `screenplayToPlainText` — built for the
save-conflict "Copy my version" rescue, explicitly documented there as "not an export format," which
is exactly the right shape for this column too: legible, not round-trip-exact. Reused rather than
reinvented; no new rendering logic was written for this slice.

**`preview_metadata`**: `{ sceneCount, blockCount }`, computed once at write time by a new shared
function, `computeRevisionPreviewMetadata` (`packages/screenplay/src/revisions.ts`). A display
convenience only — nothing in this slice's correctness depends on it — so a revision list can
render without deserializing and re-deriving from the full `canonical_screenplay` blob per row.

**Index**: `(screenplay_id, created_at)`, not `(screenplay_id, id)` — `id` is a random UUID with no
chronological meaning; every real query orders by `created_at`.

**Migration `0008_romantic_aqueduct.sql`** is purely additive (one new enum type, one new table, one
new index) — safe to run against a database with existing rows, which it will be the moment this
merges (`app`'s `preDeploy` migration step on `main`'s auto-deploy).

## Where the write/read path lives, and why

`packages/database/src/revisions.ts` is a new shared module, exporting `insertRevisionIfChanged`,
`latestRevision`, `listRevisionsForScreenplay`, and `getRevisionById`. Both `apps/collab` (automatic
triggers) and `apps/api` (named/export triggers) import it directly, rather than each implementing
its own insert logic. This was a deliberate departure from this codebase's own precedent of letting
each app duplicate small persistence helpers (e.g. `canonicalHash`'s sha256 wrapper exists separately
in `apps/collab/src/database.ts` and `apps/api/src/projects.ts`): the dedupe invariant below is
exactly the kind of correctness-bearing logic `progress/collaboration-offline-durable.md`'s own
quarantine-generalization reasoning warns against duplicating — two independently-maintained copies
risk silently drifting apart, which a cheap string-concatenation helper does not.

The structural-change measure and the shared preview-metadata computation
(`measureStructuralChange`, `computeRevisionPreviewMetadata`) live in `packages/screenplay/src/revisions.ts`
instead, not `apps/collab` — they are pure functions over two `Screenplay` objects with no database
or Hocuspocus dependency, and `apps/api`'s own `previewMetadata` computation for named/export
revisions needs the identical block/scene counting `apps/collab`'s structural-change trigger uses,
so one definition living in the package both apps already depend on is what keeps a revision list
from ever showing a count computed two different ways depending on which process wrote the row.

## The two automatic triggers and the numbers behind them

### "Meaningful idle session": 10 minutes

`apps/collab/src/revisions.ts`'s `IDLE_SESSION_REVISION_MS = 10 * 60 * 1000`.

**Reasoning.** Too short and history fills with noise: a writer composing a scene pauses
constantly — to think about the next line, to check an earlier page, to take a call — and those
pauses routinely run past a minute without the writer having stopped working in any sense that
deserves its own place in history. Too long and a real session goes unrecorded for an
unreasonably long time (or never, if the tab is simply closed with no further edits — nothing else
in this slice creates a revision for that session until this timer fires). 10 minutes sits above
the range ordinary composition pauses occupy (seconds to a few minutes) and below the range that
would let a solid, continuous writing session go unrecorded for most of its length. It is a
deliberate, documented, tunable constant — not something `plan.md` specifies — and the scheduler's
own `idleMs` option exists precisely so a later, evidence-driven adjustment never has to wait out
the real duration to test.

**Mechanism.** `createIdleSessionRevisionScheduler` is a small, process-local timer keyed by
screenplay id. It takes an `onIdle` callback rather than a `Pool` directly — a deliberate seam that
separates the scheduler's own timer/reset/fire logic (pure, and the part worth unit-testing in
isolation, see `apps/collab/src/revisions.test.ts`) from `maybeCreateIdleSessionRevision`'s database
access. `server.ts`'s `onChange` hook — which, by construction, only ever fires for a write that was
actually applied to the live document (a quarantined, read-only writer's edit never reaches it) —
calls `noteActivity` on every accepted edit; `onDestroy` calls `dispose()` so a graceful shutdown
never leaves a `setTimeout` outliving the process's own database pool.

When the timer fires, `maybeCreateIdleSessionRevision` reconstructs the document **purely from what
is durable in Postgres** (`updateLog.ts`'s `reconstructDocumentState`), never from a live
in-memory `Y.Doc` — the identical "never trust memory, trust the log" discipline `createCheckpoint`
already follows. It then projects, and attempts a write only if the projection is valid.

**A known, honestly-stated limitation.** The scheduler's state is process-local. If `apps/collab`
is ever run as more than one replica, each process tracks idle timers independently, and two
replicas that each handled edits to the same screenplay could each fire their own idle timer. This
cannot corrupt anything or produce a true duplicate — `insertRevisionIfChanged`'s dedupe is
authoritative regardless of which process calls it, backed by a real Postgres advisory lock, not an
in-memory one — but it could occasionally produce one extra automatic revision where a
single-process deployment would have produced one. I did not independently re-verify against the
live Railway configuration whether more than one `apps/collab` replica is actually configured;
flagged as a "should be checked," not a settled fact.

### "Major structural change": scene delta ≥ 1, or block-change ratio ≥ 25%

`packages/screenplay/src/revisions.ts`'s `measureStructuralChange(before, after)`.

**Scene count: any delta at all (`STRUCTURAL_CHANGE_MIN_SCENE_DELTA = 1`).** `plan.md`'s own
wording lists "scenes added or removed" as a condition in its own right, separate from "some
proportion of blocks changed" — and a screenplay's scene list is its skeleton. Adding or cutting
even one scene changes what the document _is_ in a way no amount of line-editing within existing
scenes does. This is not a tuned threshold; it is the literal reading of "added or removed."

**Block-change ratio: 25% (`STRUCTURAL_CHANGE_BLOCK_RATIO_THRESHOLD = 0.25`).** Computed as the
number of blocks added, removed, or content-changed (by stable id, dual-dialogue columns
flattened into their constituent blocks so a dual-dialogue exchange is counted the same as the
same lines unpaired) divided by the union of both projections' block ids. An ordinary editing
session — polishing a line of dialogue, tightening one action paragraph, fixing a typo — touches a
handful of blocks; at any reasonable screenplay length a few edited blocks is comfortably under 5%
of the total, usually a fraction of a percent for one sitting's worth of polish. A quarter of the
document changing in one debounced save cycle is a different kind of event: a large paste (an
imported act, a scene reorder that regenerates many block ids), a broad rewrite pass across a whole
sequence, or restructuring dialogue voice throughout a scene — exactly what a writer would want a
checkpoint recorded for before continuing. 25% sits with comfortable margin above what routine
editing ever produces and comfortably below "the whole document was retyped" (100%), confirmed with
a boundary test (`packages/screenplay/src/revisions.test.ts`: 24/100 blocks changed is not major,
25/100 is).

**No baseline yet (a screenplay's first real content).** `before: undefined` is treated as an
empty screenplay (zero scenes, zero blocks). The first time any real content exists, the scene
count moves from 0 to something, which is itself a delta ≥ 1 — so a screenplay's very first
content always becomes its first revision, with no separate "genesis" trigger needed.

**Mechanism.** `apps/collab/src/database.ts`'s `createStore` (the debounced `onStoreDocument` hook)
calls `maybeCreateStructuralChangeRevision` immediately after writing the new canonical projection,
on the exact same valid projection, non-fatally — a bug in revision creation must never regress the
primary write. It compares the new projection against the screenplay's current `latestRevision`
(any kind), and attempts a write only when `isMajor` is true.

## Retention policy

**Named revisions are retained indefinitely** (`plan.md`, stated as a requirement, and simply true
by construction — nothing in this slice ever deletes a `document_revisions` row of any kind).

**Decided policy for automatic revisions (`idle_session`, `structural_change`, `export`): retain
for 90 days from `created_at`, except that the single most recent automatic revision for a
screenplay is always retained regardless of age.**

**Reasoning for 90 days.** Automatic revisions capture incremental progress a writer did not
explicitly ask to keep forever; retaining every one indefinitely would let storage grow without
bound for a long-lived, actively-edited project (`canonical_screenplay` is a full JSONB copy of the
document per row). 90 days is roughly a quarter — long enough to cover the ordinary "what did this
look like a month or two ago" curiosity a writer might have without having explicitly named
anything, short enough to bound growth for a project worked on continuously for a year or more.
This is a judgment call stated plainly as one, not a number `plan.md` specifies.

**Why the latest automatic revision is exempt regardless of age.** `measureStructuralChange`'s own
baseline is `latestRevision` — if every automatic revision for a screenplay were pruned on a fixed
schedule with no exception, a screenplay that goes 90 days between structural changes would lose
its only baseline, and the next real edit would be compared against "empty," spuriously flagging
routine content as a 100% "major" change. Keeping the single latest automatic revision alive
indefinitely (until superseded by a newer one, named or automatic) is what keeps the
structural-change trigger correct independent of the retention window's own length.

**This policy is decided and documented, not yet enforced by code.** No pruning job exists in this
slice — `document_revisions` has no automatic deletion path at all today. This is a deliberate
scope decision, stated plainly rather than silently implied: a scheduled deletion job needs its own
test suite (does it correctly skip every `named` row? does it correctly keep the latest automatic
revision per screenplay, not just per some global cutoff? does it run safely, without locking,
against a live production table?), and retrofitting a real `DELETE` path onto a slice whose actual
deliverable is "revisions are durable and immutable" is not something to rush in the same change.
The schema needs no new column to support it later — `created_at`, `kind`, and "is this the latest
row for its screenplay" are all it takes to compute the policy above from a future job.

## The `canonical_hash` dedupe, the trap it closes, and the real bug it found

**The invariant**, enforced in exactly one place, `insertRevisionIfChanged`
(`packages/database/src/revisions.ts`): a new row for `idle_session`, `structural_change`, or
`export` is never inserted when its `canonical_hash` equals the screenplay's current latest
revision's hash. The existing, pre-existing revision is returned instead (`created: false`), so a
caller that needs a revision id to reference (an export's future `source_revision_id`) always gets
one back, new or reused.

**How this closes the pagination trap.** `(MORE)`/`CONT'D` are derived by the layout package at
render time and never written into `canonicalScreenplay` — the canonical model structurally cannot
represent them (there is no field for it in the `Screenplay` type at all), so re-pagination can
never change `canonical_hash` by construction, not by a special case this slice had to add. Proven,
not merely assumed, two ways:

1. **Integration-level, against a real database**
   (`apps/collab/src/revisions.integration.test.ts`, "never creates a second revision across
   repeated debounced saves that carry no real change"): `createStore` is called twice in a row
   with the _identical_ `Y.Doc` content, standing in for Hocuspocus's own `onStoreDocument` firing
   again after a decoration-only pagination recompute that never touched the Yjs document at all —
   `plan.md`'s exact stated trap. Asserts both that `screenplays.canonical_hash` is byte-identical
   after both calls and that `document_revisions` gained exactly one row, not two.
2. **Unit-level** (`packages/database/src/revisions.test.ts`): `insertRevisionIfChanged` called
   twice with the same hash produces one row; called with two different hashes produces two.

**A real defect this found, not a hypothetical one.** My first design deduped _every_ kind
uniformly, including `named`. `apps/web/e2e/revision-history-persistence.spec.ts` — a real browser
test, typing a writer's actual first words into a brand-new, empty screenplay — immediately exposed
why that was wrong: typing even a few words into an empty screenplay already crosses the
structural-change threshold on its own (0 blocks → 1 block is a 100% change ratio), so
`createStore`'s own automatic trigger fires and writes a `structural_change` revision within
moments. When the writer then explicitly used **Save named revision…**, the named write's
`canonical_hash` was already identical to that automatic revision's — and under the original
uniform dedupe, `insertRevisionIfChanged` silently reused the existing automatic row instead of
creating one, discarding the writer's own label entirely. The revision list showed "Automatic —
structural change," never "First milestone."

**The fix**: `kind: 'named'` is excluded from the dedupe set (`KINDS_DEDUPED_ON_UNCHANGED_HASH`).
`idle_session`, `structural_change`, and `export` carry no label of their own, so deduping them
loses nothing observable; `named` is the one case where a writer supplies something — a label —
that a silent reuse would destroy. This is documented directly in `insertRevisionIfChanged`'s own
comment, not just in this file, specifically so the reasoning survives the next person who is
tempted to "simplify" it back to uniform. The browser test (now green) is what actually proves this,
end to end, through the real File-menu action, not just at the function-call level — see
`packages/database/src/revisions.test.ts`'s own added test, `'never dedupes a named revision, even
when the hash exactly matches the latest (automatic) revision'`, and the integration-level
confirmation in `apps/api/src/revisions.integration.test.ts`.

## Historical preview: read-only, and structurally incapable of touching the live document

**The route.** `apps/web/src/routes/projects/$projectId.screenplays.$screenplayId.revisions.$revisionId.tsx` —
the one addressable route for a historical preview. Only a revision id travels in the URL;
`GET /api/screenplays/:id/revisions/:revisionId` is the only source of the screenplay content the
route ever renders (`plan.md`: "a revision identifier in the URL is fine; screenplay text is not").

**Reusing the existing read-only mechanism, not inventing a second one.** `App.tsx` already had one
read-only mechanism, built for the lapse-chooser slice (`entitlementReadOnly`): a single
`editingAllowed` flag folding together every reason editing might be disallowed, gating Tiptap's own
`editable` option, the title page's `contentEditable`, the element-type selector,
`convertActiveScreenplayBlock`'s own internal guard, Undo/Redo, and "Document settings…". This
slice adds a new prop, `historicalRevision`, and folds it into the identical flag:
`editingAllowed = initialContent !== undefined && entitlementReadOnly === undefined &&
historicalRevision === undefined && (syncState === 'synced' || syncState === 'offline')`. No second
read-only code path was written.

**What is genuinely different, not merely re-skinned.** Reusing the read-only _gate_ is not enough
on its own — a lapsed-entitlement screenplay is still connected to the live Yjs document over a real
`HocuspocusProvider`, just blocked from typing into it. A historical preview must never do that.
`App.tsx`'s `collab` useMemo — the one place a `HocuspocusProvider`/`IndexeddbPersistence` is ever
constructed — now takes `historicalRevision !== undefined` as a third, unconditional reason to take
its existing "local, unconnected `Y.Doc`" branch, regardless of whether `COLLAB_WS_URL` is
configured. In historical-preview mode there is structurally no code path from this render to the
live document at all — not a disabled one, an absent one. `syncState`'s own initializer and the
sync-reporting effect both already key off `collab.provider`'s presence, so they correctly settle to
`'synced'` with no live connection to report on.

**Proven, not assumed, two ways:**

1. `apps/web/src/App.historicalRevision.test.tsx` mocks `collabConfig.js` to a real-looking
   `COLLAB_WS_URL` and spies on the `HocuspocusProvider`/`IndexeddbPersistence` constructors
   specifically so the assertion is direct: neither is ever called when `historicalRevision` is set,
   even with a real collaboration server configured. (Every other test in this codebase's `App.test.tsx`
   runs with `COLLAB_WS_URL` unset, so it can never by itself prove this — the branch that _would_
   construct a live provider is unreachable from that file no matter what.)
2. `apps/web/e2e/revision-history-persistence.spec.ts`, a real browser test: types real content into
   a real, Hocuspocus-backed live document, saves a named revision, makes a further live edit _after_
   the revision was captured, opens the historical preview, confirms the preview shows the captured
   snapshot (not the later edit), attempts a real keystroke into the read-only canvas and confirms
   nothing changes, then re-fetches the live screenplay directly via the REST API and confirms the
   later live edit is still there and the attempted preview keystroke never reached it.

**Unmistakably distinct from the live editor, not just functionally read-only.** The banner reuses
`entitlementReadOnly`'s exact markup/grid mechanics (`.readonly-banner`, the same
`has-readonly-banner` CSS row-insertion fix that slice's own bug report required) but adds a
`readonly-banner-historical` modifier: a left-border accent in the same blue
(`--border-11`/`--border-12`) this codebase already uses for focus and the active Navigator tab
— not a new brand colour, consistent with `plan.md`'s "one functional accent color" — plus
text that leads with **"Historical revision."**, not a colour-only distinction. No "Make this one
editable" action exists in this mode at all; promoting a past revision to the live document is
restore-as-current (`plan.md`), explicitly slice 5, and nothing here builds a path toward it.

## How the design keeps export-from-revision possible later

Not built in this slice (`plan.md`'s own explicit requirement is a _test_, deferred along with the
feature). The schema and the write path were shaped so that test is satisfiable later without a
redesign:

- `createPostgresRevisionStore.createRevision` (`apps/api/src/revisions.ts`) already has a
  `kind: 'export'` case, callable independent of `kind: 'named'`, that always resolves to a
  concrete, immutable `document_revisions` row — new or deduped-and-reused — representing exactly
  the canonical screenplay at the moment of the export action.
- `plan.md`'s own schema sketch for `document_exports` includes `source_revision_id`. Once export
  generation itself is built (out of scope here), it has exactly one thing to point at: the id this
  endpoint already returns. A test asserting "an export made from a historical revision exactly
  identifies that revision, not the mutable current document" is then a direct comparison between
  `document_exports.source_revision_id` and the `document_revisions.id` the export was actually
  generated from — nothing about this slice's schema makes that comparison impossible or ambiguous.
- Today's export buttons (`App.tsx`'s File menu, `fdxDownload.ts`/`docxDownload.ts`/`pdfDownload.ts`)
  are wired to call `api.createExportRevision` alongside the existing client-side download, fire-and-
  forget, non-blocking — this is this slice's own "exports are a revision-creation occasion" trigger,
  not export-from-revision. What is _not_ built is a route or UI to export _from_ a chosen historical
  revision rather than the live document; that is explicitly the deferred feature, and nothing here
  stands in its way.

## Boundaries honored

**Revision history, Track Changes, and production revision sets share no implementation or state.**
`document_revisions` carries no per-block author attribution (that is Track Changes) and models a
revision as a single immutable snapshot, never a set of proposed changes with accept/reject state
(also Track Changes). Neither Track Changes nor production revision sets exist yet in this codebase;
nothing here was built anticipating their shape.

**Local undo/redo is never presented as collaboration history.** `yUndoPlugin`'s own state is never
read by anything in this slice; the File menu's "Undo local change"/"Redo local change" and
"Revision history…"/"Save named revision…" are visually and functionally unrelated controls, and a
historical-preview render disables the former (as part of the general read-only gate) without any
of this slice's own revision machinery ever touching it.

**A revision is immutable.** Nothing in this slice issues an `update` against `document_revisions`
— every writer is `insertRevisionIfChanged`, which only ever inserts or returns an existing row
unchanged. (See "Mutation testing" below for what happens when that is deliberately violated, and
what did — and did not — catch it.)

## A real TanStack Router nesting bug, found and fixed while building the preview routes

File-based routing in this codebase treats any route whose path is a prefix of another's as an
implicit parent requiring the parent to render `<Outlet/>` for the child to ever appear — regardless
of dot-file vs. folder naming. The existing screenplay editor route
(`$projectId.screenplays.$screenplayId.tsx`) renders `<EditorWorkspace/>` directly, with no
`<Outlet/>`, because until this slice it had no children. Adding
`$projectId.screenplays.$screenplayId.revisions.tsx` as a _sibling_ URL under the same prefix
silently made the router treat it as a _child_ instead: the URL updated on navigation, but the
component never rendered, because the parent route had nowhere to put it.

The fix follows this codebase's own existing precedent exactly
(`routes/projects/$projectId.tsx` as a thin `<Outlet/>` layout, `routes/projects/$projectId/index.tsx`
as its actual leaf content) rather than TanStack's trailing-underscore "non-nested route" escape
hatch, which was tried first and rejected: it works by making the _de-nested_ route's own
`routePath` carry a trailing underscore, which `path.js`'s own `paramName = part.substring(1)`
parses as part of the literal param name — `screenplayId_`, not `screenplayId` — breaking `params`
validation for any route whose own local path segment introduces more than the one trailing
dynamic param. (Confirmed directly by reading the installed `@tanstack/router-generator` and
`@tanstack/router-core` source, not guessed from the symptom alone.) The editor route became
`$projectId.screenplays.$screenplayId/index.tsx` (a thin layout at the flat-file location was not
needed, since nothing else needs to share its `<Outlet/>` — the index file itself is now simply a
sibling, not a parent, of the two new revision routes), and the revision-history list route
similarly became `$projectId.screenplays.$screenplayId.revisions/index.tsx` once the identical
problem recurred one level deeper (the list route, as a flat file, was itself an implicit parent of
the `$revisionId` preview route). Found by, and only by, the real browser test —
`App.historicalRevision.test.tsx`'s mocked-router harness could not have caught either defect,
since it does not exercise real route matching at all.

## Mutation testing

Every mutation below was applied to the real source file, rebuilt where the change crossed a
package boundary (`packages/database` is consumed by both `apps/collab` and `apps/api` through its
own compiled `dist/`, not `src/`, so a source edit alone is invisible to either app's tests until
`pnpm --filter @finaler-draft/database build` runs), confirmed to fail in exactly the expected way
against the suite meant to prove that property, then reverted and reconfirmed byte-identical with
`diff` before moving on.

**1. Revision creation skips its hash dedupe** (`packages/database/src/revisions.ts`'s
`insertRevisionIfChanged`: the body of the `if (KINDS_DEDUPED_ON_UNCHANGED_HASH.has(params.kind))`
block replaced with nothing — dedupe silently disabled for every kind).

- `packages/database/src/revisions.test.ts`: 3 of 10 tests failed — `'never creates a second
revision when the canonical hash is unchanged from the latest one'`, `'dedupes an export
revision...'`, and `'serializes two concurrent writers...'` — exactly the tests this property
  is named for.
- `apps/collab/src/revisions.integration.test.ts` (real database): 1 of 4 failed —
  `'creates an idle-session revision ... and never a duplicate on repeated idle fires with no new
activity'`. The sibling test in the same file,
  `'never creates a second revision across repeated debounced saves that carry no real change'`
  (the direct pagination-spam scenario), **did not fail under this mutation** — found and reported
  honestly, not hidden: that scenario is additionally protected by `measureStructuralChange` itself
  reporting `isMajor: false` for genuinely unchanged content, so `maybeCreateStructuralChangeRevision`
  never even attempts a second write for it to begin with. The dedupe at `insertRevisionIfChanged`
  remains the sole guarantee for the idle-session trigger, which has no equivalent pre-filter — and
  that is exactly the test that caught the mutation.
- `apps/api/src/revisions.integration.test.ts` (real database): 1 of 4 failed —
  `'never creates a second revision when the canonical hash has not changed since the last one...'`.
- Reverted; `diff` confirmed byte-identical; all three suites reconfirmed fully green afterward.

**2. Preview made writable** (`apps/web/src/App.tsx`'s `editingAllowed`: the
`historicalRevision === undefined` conjunct deleted).

- `apps/web/src/App.historicalRevision.test.tsx`: 2 of 4 tests failed —
  `'renders visibly read-only, with the revision content itself still legible'` (the canvas came
  back `contenteditable="true"`) and `'disables every other affordance...'` (the element selector
  came back enabled). Reverted; `diff` confirmed byte-identical; suite reconfirmed 4/4 green.

**3. A revision made mutable in place** (`insertRevisionIfChanged`: the final `insert` replaced with
"if a latest revision already exists for this screenplay, `update` it in place instead of inserting
a new, immutable row").

- `packages/database/src/revisions.test.ts`: 4 of 10 tests failed, most directly
  `'creates a new revision once the canonical hash actually changes'` (expected two distinct rows,
  got one — the second write silently overwrote the first instead of creating a new one).
- **Honestly disclosed gap**: neither real-database integration suite
  (`apps/collab/src/revisions.integration.test.ts`, `apps/api/src/revisions.integration.test.ts`)
  caught this mutation. Both ran clean. The reason is the same measure-gate redundancy mutation 1
  surfaced from the other direction: every existing "a later edit doesn't mutate the earlier
  revision" scenario in those two files happens to route its _second_ write attempt through a path
  that never reaches `insertRevisionIfChanged` again with genuinely different content (a minor,
  non-major live edit in the collab case; a raw `update screenplays` with no second `createRevision`
  call at all in the api case) — so there was nothing in those specific scenarios for an
  update-in-place bug to visibly corrupt. This is a real, acknowledged limit of this slice's
  integration coverage for the immutability invariant specifically, distinct from the dedupe
  invariant (mutation 1), which the same integration suites _did_ independently catch. The pure
  unit suite against `insertRevisionIfChanged` directly is what actually proves immutability holds
  for a genuine second, different write; I did not additionally build a real-database test that
  forces two back-to-back _major_ structural changes for the same screenplay to close this gap, and
  am stating that plainly rather than leaving it to be rediscovered by surprise.
- Reverted; `diff` confirmed byte-identical; `packages/database`'s build and all three revision test
  suites reconfirmed green afterward.

No prior assertion was weakened, and no fourth misleading assertion was added: every pass or fail
above was checked against the specific suite(s) named as proving that property, not a different
suite passing by coincidence — including the two places above where the "expected" suite did not,
in fact, catch the mutation, which is reported as found rather than smoothed over.

## Immutability at the integration level — the disclosed gap, closed in review

This slice's own mutation testing reported, honestly, that making a revision mutable in place was
caught only at the unit level: neither real-database suite forced a second genuine insert, so an
implementation that rewrote the latest revision rather than appending a new one would have passed
every integration test. Immutability is _the_ defining property of a revision, so that gap was worth
closing rather than recording.

The existing integration tests cover the adjacent case well — a later edit that creates no revision
leaves the stored one byte-identical — but a save that writes nothing cannot prove append-only
behaviour. Only two real inserts against one screenplay can.

Added `apps/collab/src/revisions.integration.test.ts`'s "a genuine second revision is appended, never
written over the first": one save produces a revision, then a save adding a whole second scene
(scene delta 1) forces a second real insert, and the first revision's **entire row** is compared for
equality — id, hash, canonical projection and `created_at` together, because an in-place write that
happened to preserve the id would still be caught that way. It also asserts the second revision is
genuinely different content, so the first assertion cannot pass merely because nothing was written.

Mutation-proved twice, because the first attempt was not good enough and that is worth recording:

1. Turning the insert into `on conflict (screenplay_id) do update` failed five tests — but there is
   no unique constraint on `screenplay_id`, so that mutation was a SQL error, not a semantic
   in-place write. Five tests failing told us nothing about immutability.
2. Replaced with a genuine semantic mutation: select the latest revision for the screenplay and
   `update` it in place, falling back to insert only when none exists. That fails **exactly one**
   test — the new immutability test — and no others. That is the precise sensitivity the property
   needs, and it confirms directly that nothing else in the suite covered it.

## Known limitations, stated plainly

- **Automatic-revision retention is decided and documented, not enforced.** See "Retention policy"
  above. No pruning job exists; nothing deletes a `document_revisions` row today.
- **The idle-session scheduler's state is process-local**, with the horizontal-scaling caveat
  described above, not independently re-verified against the live Railway configuration.
- **Mutation 3's real-database integration coverage has a genuine gap**, described above rather than
  hidden: the immutability invariant is proven at the unit level against `insertRevisionIfChanged`
  directly, but the two real-database integration suites' own existing "a later edit doesn't mutate
  an earlier revision" scenarios do not happen to exercise a second genuine insert attempt, so they
  did not independently catch an update-in-place mutation.
- **Named-revision creation is not entitlement-aware.** `apps/api/src/revisions.ts`'s
  `createRevision` is registered as the bare Postgres store, not wrapped the way
  `createEntitlementEnforcedProjectStore` wraps screenplay content writes — a restricted account
  past its lapse could, in principle, name a milestone on a screenplay that is not their chosen
  editable one, even though they cannot edit its content. This was a deliberate scope cut under
  this slice's time budget, reasoned through rather than simply missed: entitlement's own axis is
  "which one screenplay may this restricted account write _content_ to," a different question from
  "may a revision be captured of a screenplay this account can already read," and `plan.md` never
  asks for the latter to be gated. Worth the owner's attention if that reasoning doesn't hold.
- **Export-triggered revision creation fires best-effort from the browser, with no retry.** If
  `api.createExportRevision` fails (offline, a transient 5xx), the export itself still succeeds —
  by design, an export must never fail because this bookkeeping call did — but that specific export
  event then has no corresponding revision. Acceptable for this slice (export-from-revision, the
  feature that would actually depend on that correspondence, is out of scope), but worth knowing
  before building on top of it.
- **The lazy editor chunk grew from this slice's own additions** (`App.tsx`'s new
  `historicalRevision` branch, `namedRevisionDialog.tsx`, the two new route files it lazily loads
  alongside) — gzip 144.72 kB against this repo's 200 kB budget in `check:bundle-budget`'s own
  build (pre-gzip ~468 kB), up from the prior slice's ~143.66 kB baseline, still comfortably within
  budget. `pnpm build`'s own, differently-configured invocation (as run by
  `scripts/test-system-persistence.mjs`) measured a larger pre-gzip figure for the same chunk and
  crossed Vite's unrelated 500 kB source-size advisory warning on that specific invocation; gzip
  size, the only number `check:bundle-budget` actually gates on, was unaffected.

## New environment variables

None.

## Gates — every one run and checked by `$?`, not by reading output

```
pnpm lint
```

Exit 0. Clean, no output.

```
pnpm format:check
```

Exit 0. `All matched files use Prettier code style!`

```
pnpm typecheck
```

Exit 0. Clean across every package and both apps (root script builds every package first, then
`apps/web`/`apps/api`/`apps/collab` typecheck, then `apps/landing`'s `astro check`: "0 errors - 0
warnings - 0 hints").

```
pnpm test
```

Exit 0. `apps/web`: **703 passed** (667 baseline + 36 new). `apps/collab`: **106 passed** (92
baseline + 14 new). `apps/api`: **190 passed** (163 baseline + 27 new). `packages/database`: **40
passed** (2 new, `revisions.test.ts`). `packages/screenplay`: **128 passed** (10 new,
`revisions.test.ts`), unchanged otherwise. `packages/screenplay-editor`: **99 passed**, unchanged.
`packages/collab-token`: **9 passed**, unchanged. Every other package unchanged and green.

```
pnpm test:coverage
```

Exit 0. New files added to each package's coverage `include` list (previously excluded entirely —
`revisions.ts` would otherwise have been silently uninstrumented): `packages/database/vitest.config.ts`,
`packages/screenplay/vitest.config.ts`, `apps/collab/vitest.config.ts`, `apps/api/vitest.config.ts`.
Measured: `packages/database/src/revisions.ts` 97.7/83.33/100/97.7 (stmts/branch/funcs/lines),
`packages/screenplay/src/revisions.ts` 96.87/91.66/100/96.87, `apps/collab/src/revisions.ts`
100/91.66/100/100, `apps/api/src/revisions.ts` 100/100/100/100, `apps/web`'s new route files
100/92.85/100/100, `apps/web/src/namedRevisionDialog.tsx` 100/89.65/100/100 — every one comfortably
above the existing 80% thresholds.

```
pnpm check:bundle-budget
```

Exit 0 (after fixing `scripts/check-bundle-budget.mjs`'s hardcoded `EDITOR_ROUTE_SRC_PREFIX`, which
pointed at the editor route's pre-move flat-file path — see "A real TanStack Router nesting bug"
above). `Entry chunk 111.84 kB / 120.00 kB`, `Lazy editor chunk 144.72 kB / 200.00 kB`,
`CSS 6.60 kB / 20.00 kB`. All within budget.

```
TEST_DATABASE_URL="..." pnpm test:integration
```

Exit 0. `packages/database`: 5/5 (unchanged). `apps/api`: **44/44** (40 baseline + 4 new,
`revisions.integration.test.ts`). `apps/collab`: **22/22** (18 baseline + 4 new,
`revisions.integration.test.ts`).

```
TEST_DATABASE_URL="..." pnpm test:system:persistence
```

First run: **30/31 passed**, one failure —
`presence-persistence.spec.ts`'s `'clicking exactly on a remote cursor places the local caret at
the same position a plain click at those coordinates would'` (`Error: Block has no text node.`),
unrelated to anything in this slice. Re-run immediately after, ports recleared, full rebuild: **31/31
passed**, confirming the first failure was a flake in a pre-existing test under this suite's
own worker contention, not a regression — consistent with this repo's own prior history of exactly
this class of flake in the click-through/cursor-positioning tests (`titlepage-cursors-persistence.spec.ts`
had an analogous one, fixed on `main`). 31, not the 30 baseline, because this slice adds one new spec,
`revision-history-persistence.spec.ts` (the historical-preview read-only/live-document-untouched
proof), both runs green.

```
pnpm test:system
```

Exit 0. **40/40**, unchanged — this slice's new browser test needs the persistence harness's real
database and mail capture, so it was added to `playwright.persistence.config.ts`'s own `testMatch`
and `playwright.config.ts`'s `testIgnore`, the same convention every other `*-persistence.spec.ts`
file already follows.

Nothing regressed against the stated baseline (unit web 667/screenplay-editor 99/collab 92/api
163/collab-token 9; integration 5+40+18; `test:system:persistence` 30/30; `test:system` 40/40).

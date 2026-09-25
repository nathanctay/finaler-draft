# Collaboration: the title page and document settings save path

Branch `feature/collab-title-page`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/collab-titlepage`, off `1b798f7` (current main at
the time this slice started, which already includes collaboration slices 1 and 2).

## Why this scope exists

A defect the owner found in real use: title-page edits do not sync between windows, no remote
cursors appear on the title page, and changes do not survive a reload. The cause is not a sync bug
-- when Yjs became the source of truth in slice 1, the whole-document `PUT` was deleted, and the
title page was never part of the Yjs document. It lived only in `apps/web/src/App.tsx`'s
`titlePageState`/`documentSettings` React state, folded into the canonical projection at save time
-- except there was no save time left. `apps/collab/src/database.ts`'s old `createStore` read
`titlePages`/`documentSettings` back from the existing row and passed them through unchanged,
precisely so collaboration would not silently erase a writer's title page. That was the right
defensive choice at the time and it preserved the owner's data, but it was never a save path --
this slice explicitly calls that gap out in `progress/collaboration-slice-1.md`'s "known
limitations."

The owner's decision: title page and document settings move into the Yjs document, rather than a
separate REST endpoint (which would reintroduce a second writer to the same row with
last-write-wins and no live sync). One document, one save path, one source of truth -- and remote
cursors on the title page follow from it (the write-rejection gate at the socket already applies to
the whole document, so it covers these two new maps with no extra code; see "Write rejection is
free" below).

## The Yjs shape

```
Y.Doc
  "default"          -> the ProseMirror fragment (SCREENPLAY_YJS_FRAGMENT, unchanged from slice 1)
  "titlePage"         -> a Y.Map (TITLE_PAGE_YJS_MAP)
  "documentSettings"   -> a Y.Map (DOCUMENT_SETTINGS_YJS_MAP)
```

Two separate top-level maps, not one combined "metadata" map -- the owner's own approved shape
lists them as siblings of the body fragment, and keeping them separate means a reader (or a future
increment) touching one can never accidentally clobber the other's keys, the same reason
`SCREENPLAY_YJS_FRAGMENT` is its own named constant rather than nested inside something else.

Both maps hold **plain, last-write-wins values, not `Y.Text`/`Y.Array` nested shared types** --
one Y.Map key per canonical field, written and read as a unit. This was the real design decision
the brief asked to be justified:

- A title page has a handful of short fields (title, credit, source, draft date, a handful of
  author/contact lines) that two collaborators overwhelmingly do not edit character-by-character at
  the same instant, unlike the manuscript body. `documentSettings`' six fields are settings, not
  prose -- there is no sensible reading of "merge two people's concurrent character-indent edits
  character by character."
- `Y.Text` would buy fine-grained concurrent-merge semantics at real cost: the title page's fields
  are plain `contentEditable` divs synced by whole-string assignment
  (`titlePageEditor.tsx`'s own "uncontrolled but synced" `TitlePageField` comment), not bound
  through `y-prosemirror` the way the manuscript body is. Getting `Y.Text` co-editing right for six
  short fields nobody meaningfully co-edits would mean building a second, parallel rich-text
  binding, for a benefit (character-level merge on a title page) nobody asked for.
- The honest cost of plain values: a genuinely simultaneous edit to the _same field_ by two writers
  drops one writer's keystroke (last-write-wins). That is the same cost every other settings-shaped
  value in this codebase already accepts, and far cheaper than the alternative's complexity for
  content this size and this rarely contested.

### Field-level writes: only the keys that actually differ

Added after review of the first implementation, which cleared every key and rewrote all of them from
the caller's full `TitlePage` on every write. That made the stated cost above wrong in a way that
mattered: `Y.Map` resolves a concurrent write **per key**, so the set of keys a write touches is
exactly the set it can take from another writer. Rewriting all of them meant two writers editing
_different_ fields still collided on every field, and one writer's edit was discarded whole.

Verified against real Yjs before changing anything -- two docs, seeded identically, then edited
concurrently and merged both ways:

```
A edits only the title; B concurrently adds only an author
  -> both converge on: B's author kept, A's title reverted
```

`writeTitlePageToYMap` and `writeDocumentSettingsToYMap` now compute the difference against what the
map already holds and touch only the keys that genuinely changed -- setting changed keys, deleting
keys the incoming value no longer carries (which is what still lets a writer clear a field back to
nothing, since `titlePageFromYMap` reads an absent key as "no value"), and leaving everything else
untouched so it is never offered up to a concurrent write. Array fields (`authors`, `contact`) are
compared by contents rather than identity; otherwise a fresh-but-equal array from React state would
rewrite the key on every unrelated keystroke and collide on it anyway.

This matters for `documentSettings` just as much as for the title page, and it is not a contrived
case there: the settings dialog submits a whole `DocumentSettings` object for a single changed
control, so before this, toggling scene numbers would revert a collaborator's concurrent
character-indent change.

With the fix, the cost is what the section above claims it is -- a collision is confined to the one
field two writers are genuinely contesting, and one of those two edits is lost. Concurrent edits to
different fields now both survive.

`titlePage`'s map presence is keyed on its `id` field: a real, required `TitlePage.id` present means
"a title page exists, however sparsely filled in" (mirrors `titlePageFromState`'s own convention --
a title page cleared down to nothing still has an `id` and still counts as one title page);
`id` absent means "no title page," matching `titlePages: []` in the canonical screenplay. The six
`documentSettings` keys are all established by the _seeding_ write; later writes touch only what
changed (above). `DocumentSettings` has no optional fields, so `documentSettingsFromYMap`'s
per-key fallback to `DEFAULT_DOCUMENT_SETTINGS` covers exactly one real case -- a document seeded
before a settings field existed -- and is otherwise unreachable
(`packages/screenplay-editor/src/index.ts`).

### New shared functions, `packages/screenplay-editor/src/index.ts`

- `titlePageFromYMap` / `writeTitlePageToYMap` -- the read/write pair for `TITLE_PAGE_YJS_MAP`.
- `documentSettingsFromYMap` / `writeDocumentSettingsToYMap` -- the same pair for
  `DOCUMENT_SETTINGS_YJS_MAP`. `documentSettingsFromYMap` returns `undefined` for an empty map so
  `projectDocumentScreenplay`'s own schema default keeps being the one place that default lives,
  exactly as `ProjectScreenplayOptions.documentSettings`'s existing convention already established.
- `isTitlePageMapSeeded` / `isDocumentSettingsMapSeeded` -- whether a map has ever been written to.
  Used by the migration (below) to tell "predates this slice" apart from "a writer already edited
  this collaboratively, however sparsely."
- `seedScreenplayYDoc(content, titlePage, documentSettings)` -- builds a fresh `Y.Doc` with all
  three parts (body, title page, document settings) seeded together in one `doc.transact()`, so
  nothing ever observes a document with a body but no title page partway through. Two call sites:
  `apps/collab/src/database.ts`'s `createFetch` (a screenplay opened collaboratively for the first
  time ever) and `apps/web/src/App.tsx`'s local, no-collaboration-server fallback (so that path has
  the identical shape a real `HocuspocusProvider`'s document eventually gets).
- `projectYDocScreenplay` now reads `titlePages`/`documentSettings` off the `Y.Doc`'s own maps
  instead of accepting them as caller-supplied options -- both genuinely live in the document now,
  so there is nothing left for a caller to supply beyond `id`/`title` (title is a
  project/screenplay-level field, unrelated to the title _page_). This is the one call-site-visible
  signature change; every existing caller that never passed `titlePages`/`documentSettings` (all of
  them) is unaffected.

## The migration -- the highest-stakes part of this slice

Existing screenplays already have title pages in `screenplays.canonical_screenplay`. The owner has
real screenplays in his own development database right now; a migration that silently dropped a
title page would destroy real data.

### Two cases, both handled in `apps/collab/src/database.ts`'s `createFetch`

1. **Never opened collaboratively at all** (no `document_yjs_state` row). Already handled by the
   existing "seed from canonical" branch -- now calling `seedScreenplayYDoc` instead of
   `createLocalScreenplayYDoc` alone, so the title page and document settings are seeded in the
   same pass as the body.
2. **Already opened collaboratively before this slice shipped** (a `document_yjs_state` row exists,
   but its title page/document settings maps were never written to, because that concept did not
   exist when the row was created). This is the case the brief specifically warns about, and it is
   real: the owner has been testing collaboration since slice 1 shipped. Left unhandled, the
   existing "row exists, return it unchanged" fast path would carry the gap forward forever,
   silently, for exactly the screenplays most likely to already be in active use.

   `createFetch` now decodes the stored state far enough to check
   `isTitlePageMapSeeded`/`isDocumentSettingsMapSeeded`. If both are already seeded (the steady-
   state case, once every collaboratively-opened screenplay has been through this once), the
   original bytes are returned completely unchanged -- no extra query, no re-encoding. Only when a
   map is genuinely unseeded does it query `canonical_screenplay` and call
   `backfillTitlePageAndDocumentSettings`, which writes into whichever map is unseeded and
   re-encodes.

### Idempotency: gated on the map's own state, not a separate flag

`backfillTitlePageAndDocumentSettings` writes to a map **only when that map is unseeded**. There is
no separate "have I migrated this document" bookkeeping -- the moment a title page (however sparse)
or a document settings object is written, by this function or by a real writer editing
collaboratively, `isTitlePageMapSeeded`/`isDocumentSettingsMapSeeded` flips to `true` and this
function never touches that map again. This is the idempotency guarantee and the "never clobber a
collaborative edit" guarantee in one property, not two: there is no code path that overwrites a
seeded map, ever, regardless of how many times `createFetch` cold-loads the same document or how
stale `canonical_screenplay` has become relative to it.

A screenplay that genuinely has no title page leaves the map unseeded after backfill too (correctly
-- an absent title page and an unmigrated map are the same bit by construction), so every future
cold load re-checks and finds nothing to do; a small, deliberate inefficiency (one extra query per
cold load, never per keystroke) traded for not needing a second signal to distinguish the two cases.

Persistence of the migrated state relies on the existing store lifecycle, not a proactive write-back
inside `fetch`: confirmed by reading the installed `@hocuspocus/server` source, `Document`'s own
`update` listener fires for the `applyUpdate` `onLoadDocument` performs to apply a fetched buffer
(including a migrated one), which triggers the debounced `onStoreDocument`/`createStore` the same
way any real edit does. A server restart before that debounce fires would simply redo the same
(idempotent, safe) backfill on the next cold load.

### Write rejection is free

`connection.readOnly` in the installed `@hocuspocus/server` gates `messageYjsUpdate`/
`messageYjsSyncStep2` at the whole-document level (confirmed by reading the compiled source), not
per Y-type. A reviewer's write rejection, already proven in
`apps/collab/src/collaboration.integration.test.ts`'s "write rejection at the socket" test for the
body fragment, applies to `titlePage`/`documentSettings` with no additional code -- they are part of
the same `Y.Doc`.

## `documentSettings` changing under a remote writer

`documentSettings` now drives `updatePaginationDocumentSettings`/`applyPageGeometryCssVariables`
from a source that can change because _another_ writer changed it, not only from this tab's own
document-settings dialog. What was found:

- **`compensateScrollForRepagination`'s scroll-anchor fix (progress/repagination-scroll-anchor.md)
  already applies unconditionally**, regardless of who or what triggered the pagination pass.
  `App.tsx`'s new title-page/document-settings observer effect calls
  `updatePaginationDocumentSettings(editor, next, () => applyPageGeometryCssVariables(next))` --
  the identical call the document-settings dialog's own handler used to make directly -- so a
  remote settings change gets the same "compensate the caret's screen position, or leave an
  off-screen reader alone" behaviour a local change already had. No new gap was found here.
- **The `parentheticalWidthIn`-specific rewrap-timing fix is also unconditional.** That file's own
  "known limitations" entry (an under-compensated scroll for a `parentheticalWidthIn` change
  specifically) was already closed in a later slice by passing `applyPageGeometryCssVariables` as
  `updatePaginationDocumentSettings`'s `runBeforeDispatch` argument, which runs _inside_ the
  compensated window regardless of the call site. This slice's observer effect reuses that exact
  call shape, so a remote `parentheticalWidthIn` change is covered the same way a local one is.
- **Yjs's synchronous `.observe()` firing is what keeps this a single authority, not two.** Writing
  into `DOCUMENT_SETTINGS_YJS_MAP` (local or remote in origin) triggers the registered observer
  synchronously, before the write's own call stack unwinds (confirmed by reading the installed
  `yjs` source: `Transaction`'s `cleanupTransactions` calls every observer before `transact()`
  returns). `App.tsx`'s `updateDocumentSettings` (the dialog's own handler) therefore only ever
  writes to the map and does nothing else -- the observer effect is the _only_ place
  `updatePaginationDocumentSettings`/`setDocumentSettings` are called, whether the edit is this
  tab's own or a remote collaborator's. The previous code called them directly from the dialog
  handler; keeping that as a second call site alongside the new observer would have run the
  pagination pass twice for one local edit.
- **One real, narrow gap closed defensively, not found broken:** if `editor` (from `useEditor`)
  becomes available _after_ the observer effect's own registration (that effect is keyed on
  `[collab]`, once per mounted screenplay, deliberately not on `[editor]`, so a remote change can
  reach this tab even before its own editor has mounted -- the same reasoning `ySyncPlugin` itself
  already relies on), the observer's `updatePaginationDocumentSettings` call is skipped for lack of
  a live editor to call it on. A second, small effect keyed on `[editor]` re-reads the current map
  value and repaginates once `editor` exists, closing that ordering gap without a second competing
  authority (it reads the same map the observer does, not `documentSettings` state).

## What was removed

`apps/collab/src/database.ts`'s pass-through -- reading `titlePages`/`documentSettings` back from
the existing `screenplays` row and threading them into `projectYDocScreenplay`'s options --
is gone. It was correct while these lived outside Yjs; it is wrong now that `projectYDocScreenplay`
reads them directly off the `Y.Doc` it is already projecting, and leaving it in place would have
created two disagreeing sources of truth the moment a writer's collaborative edit diverged from
whatever the row happened to hold.

`apps/web/src/App.tsx`'s `updateTitlePageState`/`updateDocumentSettings` no longer call
`setTitlePageState`/`setDocumentSettings`/`applyProjection`/`updatePaginationDocumentSettings`
directly. They write into the relevant `Y.Map` and nothing else; a new effect
(`titlePageMap.observe`/`documentSettingsMap.observe`, registered once per mounted screenplay) is
the single place that reacts to a map change -- local or remote -- and updates React state, live
pagination, and CSS geometry. The pre-existing `useEffect` that recomputes `projection` (word count,
save-dot, export validity) is unchanged; it already re-fires whenever `titlePageState`/
`documentSettings` change, which the new observer now drives instead of a direct `setState` call.

## Tests

### `packages/screenplay-editor/src/index.test.ts` (12 new tests)

Round-trip coverage for `titlePageFromYMap`/`writeTitlePageToYMap` and
`documentSettingsFromYMap`/`writeDocumentSettingsToYMap`: a fully populated title page, an
emptied-down-to-`id`-only one, clearing a previously-set field on re-write (proving the map is
cleared and rewritten, not merged), an unseeded map reporting no override, and the defensive
per-key fallback to `DEFAULT_DOCUMENT_SETTINGS`. `seedScreenplayYDoc` (seeds all three parts
together; leaves both maps unseeded when given neither). `projectYDocScreenplay` reading a seeded
title page/settings, and reading nothing when neither map is seeded.

### `apps/collab/src/database.test.ts` (rewritten, 12 tests, fake pool)

- `createFetch` returns the stored state **byte-identical**, with **no canonical query issued at
  all**, when the document is already fully seeded (the steady-state fast path).
- `createFetch` seeds body, title page, and document settings together when no state row exists.
- **The migration itself, three tests:** backfills a genuinely pre-slice document (asserts the
  returned bytes differ from what was stored, the canonical query _was_ issued, and the body
  content is untouched); is idempotent against a writer's own already-collaborative edit even when
  `canonical_screenplay` disagrees (a stale/different title page in the row must not win); leaves a
  genuinely title-page-less screenplay unseeded rather than inventing content, while still
  backfilling its (real) document settings independently.
- `createStore` reads title page and document settings from the `Y.Doc`'s own maps, proven by
  seeding the doc with values that **disagree** with the existing row and asserting the persisted
  JSON matches the doc, not the row -- this is the direct proof the old pass-through is gone.

### `apps/collab/src/collaboration.integration.test.ts` (3 new tests, real Postgres, real socket)

- A screenplay opened collaboratively for the first time carries `screenplayFixture`'s real,
  populated title page and document settings into the Yjs document (the "no row yet" path, for
  real).
- A screenplay already collaborative before this slice (a real `document_yjs_state` row inserted
  directly, with no title page map) backfills its title page on the next open.
- **The idempotency case, end to end:** first open backfills the fixture's title page; a writer
  edits it collaboratively to something new and that edit is flushed to `document_yjs_state`
  (`server.hocuspocus.flushPendingStores()`); `canonical_screenplay` is then directly updated to a
  _third_, stale value; a brand-new `Server` instance (standing in for a restart) reopens the
  document and the writer's own edit survives, not the stale canonical value.

`screenplayFixture` itself has `dual_dialogue`/a `page_break`/a note and so is not representable in
this text-block editor (`editorContentFromScreenplay` rejects it) -- `createProjectAndScreenplay`
gained an optional `screenplayOverrides` parameter so the "first open" test (the only one of the
three that exercises `editorContentFromScreenplay`) can keep the fixture's real title page and
document settings while substituting editor-representable `blocks`/`annotations`.

### `apps/web/src/App.test.tsx` (4 new tests, replacing two obsolete "known gap" comments)

No `HocuspocusProvider` mock exists in this file (deliberately -- see its own top-of-file comment),
so these spy on the module's own `seedScreenplayYDoc` (`vi.spyOn(screenplayEditorModule, ...)`) to
capture the exact `Y.Doc` a mounted `<App>` is using internally, the unit-level equivalent of
inspecting a real `HocuspocusProvider.document` end to end:

- A title-page field edit reaches the Y.Doc, preserving the rest of the title page exactly.
- A read-only screenplay's title page never reaches the Y.Doc from a field-edit attempt --
  `TitlePageView`'s own `readOnly` prop drops `contentEditable`/`onInput` entirely, which this test
  confirms directly; `updateTitlePageState`'s own `if (!editingAllowed) return` is a second,
  independent guard behind that one, not separately exercised (there is no route through this
  component's public surface that reaches it with the DOM guard bypassed).
- Toggling "Number scenes" writes only `sceneNumbersEnabled` to the Y.Doc, leaving every other
  setting at its seeded value.
- A loaded screenplay's own non-default document settings are still what the Y.Doc holds after an
  unrelated body edit (an element-type conversion, not literal canvas typing -- jsdom has no
  `elementFromPoint`, which `EditorView.posAtCoords` needs for a real mousedown-driven caret
  placement; no test anywhere else in this file drives the canvas that way either), not the schema
  defaults.

All 81 tests in this file pass (77 baseline + 4 new); the full existing suite required **no other
changes** to keep passing -- confirming the client-side design (write to Yjs, let its synchronous
`.observe()` callback be the only path back to React state) is behaviourally identical to the old
direct-`setState` implementation for the single-writer case every existing test exercises.

### `apps/web/e2e/titlepage-persistence.spec.ts` (2 new tests, real two-browser-context proof)

Reuses `presence-persistence.spec.ts`'s own two-context, one-account pattern rather than inventing a
new one (that file's own comment on why "same account, two contexts" is the right shape here too).
Added to `playwright.persistence.config.ts`'s `testMatch` and `playwright.config.ts`'s `testIgnore`,
matching every other spec that needs a real disposable database.

- **Title page:** context A edits the title-page title; context B sees it live (no reload); the
  rest of the title page (`credit`) is untouched; the real database row is polled directly
  (`GET /api/screenplays/:id`) to prove persistence, not merely this tab's own "synced" status; B
  reloads (a fresh `<App>`, a fresh `HocuspocusProvider`) and the edit survives.
- **Document settings:** context A toggles "Number scenes" through the real dialog; context B, who
  never opened the dialog, reads the setting straight out of its own dialog (not off a rendering
  side effect -- a scene-number widget needs real scene-heading text to render, which a brand-new
  screenplay's seeded empty block does not have); B reloads and the setting survives.

Both found real bugs in the first draft before passing: an `article` role-name collision between
`"Title page"` and `"Title Page Script screenplay canvas"` (fixed with `exact: true`), and an
initial document-settings assertion against `.scene-number[data-scene-number="1"]` that could never
render against an empty seeded scene heading (rewritten to read the settings dialog's own checkbox
state in each context instead).

## Mutation testing

Every mutation below: broke the real implementation, ran the named test(s), confirmed the predicted
failure (and nothing else), restored, confirmed green again.

1. **Disabled the title-page backfill branch** in `backfillTitlePageAndDocumentSettings`
   (`if (false && !isTitlePageMapSeeded(...) ...)`) -- caught by
   `database.test.ts`'s "backfills the title page and document settings from
   canonical_screenplay..." test: the migrated document's title page came back `undefined` instead
   of the expected canonical value. **This is the data-loss path the brief specifically asks to be
   caught, and it is.**
2. **Removed the idempotency gate**, backfilling unconditionally regardless of
   `isTitlePageMapSeeded` -- caught by `database.test.ts`'s "is idempotent: never overwrites a title
   page a writer has already edited collaboratively..." test: the writer's own edited title page
   was silently replaced by the stale canonical value.
3. **Disabled the client-side write** in `App.tsx`'s `updateTitlePageState` (commented out the
   `collab.doc.transact(...)` call) -- caught by `App.test.tsx`'s "an edit reaches the collaborative
   Y.Doc..." test: the Y.Map still held the original title instead of the edited one.
4. **Restored the clear-every-key-and-rewrite behaviour** in `writeTitlePageToYMap`, and removed
   `writeDocumentSettingsToYMap`'s changed-key guard -- caught by exactly the three new tests in
   `packages/screenplay-editor/src/index.test.ts` and nothing else: "two writers editing different
   title-page fields at the same time both keep their edit," "two writers changing different
   document settings at the same time both keep their change," and "a re-write that changes nothing
   touches the map at all." The "same field" convergence test passes under both implementations, as
   it should -- it documents an invariant this change does not alter.

### A vacuous integration assertion, found in review and fixed

The three mutations above are caught by `apps/collab/src/database.test.ts`, the unit-level proof.
The _integration_ test that was meant to prove the same property end-to-end against a real database
-- `collaboration.integration.test.ts`'s "the backfill is idempotent: ... even though
canonical_screenplay still disagrees" -- was asserting nothing at all, and was found in review by
re-running the mutations against the integration suite specifically: with **both** the
`alreadySeeded` early return and the inner `isTitlePageMapSeeded` gate removed, all 11 integration
tests still passed.

The cause was ordering, not the guard. The test planted its stale `canonical_screenplay` value
_before_ `await server.destroy()`, and `destroy()` flushes Hocuspocus's pending stores -- that flush
rewrote `canonical_screenplay` from the document's own projection, restoring the writer's real title
and erasing the planted staleness before the reopen ever read it. The next open therefore found
canonical and the Yjs document in perfect agreement: the exact condition under which the migration
is trivially safe whether or not it is gated.

Fixed by planting the stale value _after_ `destroy()` and before the new server starts. With that
ordering the mutation behaves as it always should have: guards intact, the test passes; either guard
removed, it fails with `+ "title": "A Stale Title From Before The Edit"`.

The two guards are deliberately layered -- the `alreadySeeded` early return and the per-map
seeded-ness check inside the backfill -- so removing _one_ alone still leaves the document
protected, and no test distinguishes them. That is defence in depth rather than a gap, but it is
worth knowing: a single-layer regression is caught by the unit test, not by the integration test.

## Gates -- every one run and checked by `$?`

1. `pnpm lint` -- exit 0 (one real issue found and fixed along the way: an unused
   `createLocalScreenplayYDoc` import left in `apps/collab/src/database.ts` after switching its call
   sites to `seedScreenplayYDoc`).
2. `pnpm format:check` -- exit 0.
3. `pnpm typecheck` -- exit 0.
4. `pnpm test` -- exit 0. Every package passed; `apps/web` 619 (615 baseline + 4 new), `apps/collab`
   58 passed / 11 skipped (needs `TEST_DATABASE_URL`; 3 more skip slots than the pre-existing 8,
   for the 3 new migration integration tests), `packages/screenplay-editor` 90 (78 baseline + 12
   new).
5. `pnpm test:coverage` -- exit 0, no coverage threshold failures. `apps/collab/src/database.ts`
   98.33% statements (the one uncovered branch, a generic `catch`/`rollback`/`throw` in
   `createStore`, is pre-existing and unrelated to this slice). `packages/screenplay-editor/src/index.ts`
   97.01% statements. `apps/web/src/App.tsx` 91.43% statements.
6. `pnpm check:bundle-budget` -- exit 0. Entry chunk 111.66 kB/120 kB, lazy editor chunk
   142.70 kB/200 kB (down slightly from slice 1's 139.66 kB baseline reading -- no new client
   dependency was added, only new exports from an already-bundled package), CSS 6.53 kB/20 kB.
7. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/api test:integration` -- exit 0, 39/39.
8. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/collab test:integration` -- exit 0, 11/11
   (8 pre-existing + 3 new migration tests).
9. `TEST_DATABASE_URL=<...> pnpm test:system:persistence` -- exit 0, 23/23 (21 pre-existing + 2 new
   `titlepage-persistence.spec.ts` tests).
10. `pnpm test:system` -- exit 0, 40/40, unaffected by this slice.

## What is proven, and what is not

Proven, against a real database and (for the migration and the two-context sync/reload property) a
real Hocuspocus server and real browser: the migration backfills an existing title page exactly
once and never clobbers a subsequent collaborative edit; a fresh screenplay's title page and
document settings are seeded into Yjs on first collaborative open; a title-page/document-settings
edit reaches a second live browser context and survives a reload; write rejection at the socket
(proven for the body in slice 1) extends to these two new maps by construction, not by new code.

Not separately proven: remote _cursors_ rendered specifically over title-page fields (slice 2's
`createRemotePresenceExtension`/`yCursorPlugin` machinery is bound to the ProseMirror body via
`ySyncPlugin`; the title page's plain `contentEditable` fields are not ProseMirror nodes and have no
cursor-decoration surface today). The brief's "remote cursors on the title page follow from it"
refers to the write-rejection/single-document guarantee this slice establishes, not to a rendered
caret on the title page's own fields -- building that decoration surface, if wanted, is a
follow-on increment, not implied by moving the data into Yjs.

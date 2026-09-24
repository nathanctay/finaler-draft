# Collaboration slice 2: presence, cursors, and reconnection

Branch `feature/collab-presence`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/collab-2`,
off `f80a694` (current main at the time this slice started).

## Why this scope exists

`progress/collaboration-plan.md` ("Slice 2 -- presence, cursors, and reconnection"): the awareness
protocol, remote cursors and selections in the manuscript, a participant indicator, and reconnection
that recovers cleanly from a dropped socket. Presence is transient and must never reach the database
-- plan.md: "Cursors and presence are transient and never belong in history." The screenplay is a
fixed character grid, so a remote cursor is a decoration on that grid, not a free-floating overlay --
"the same class of problem as the seam caret and the page-break widgets," a defect this codebase has
introduced and fixed four times before this slice.

## What shipped

### Server: `apps/collab/src/presence.ts`

- `deriveParticipantColor(actorId)` -- a deterministic FNV-1a hash of the actor id into a fixed
  8-colour palette (`PARTICIPANT_COLOR_PALETTE`), never reordered once shipped.
- `fetchDisplayName`/`resolvePresenceIdentity` -- the account's real name (Better Auth's own
  `user.name`, required at signup) plus the derived colour, resolved **once per connection** in
  `server.ts`'s `onAuthenticate` and cached on the connection's own `context` -- not re-queried on
  every awareness update, which can fire as often as every caret move.
- `sanitizeAwarenessStates(states, identity, now)` -- wired into a new `beforeHandleAwareness` hook
  in `server.ts` (and mirrored in `collaboration.integration.test.ts`'s own `startServer`, since that
  harness rebuilds the server's hook wiring rather than importing the self-executing `server.ts`).
  Rewrites every entry in the inbound `states` map to exactly `{ user: { name, color, lastActiveAt },
cursor? }`, dropping every other field. `name`/`color` are always replaced with the _connection's
  own authenticated identity_ -- never with anything the client claimed. `lastActiveAt` is the one
  field **not** re-stamped from the server's clock (see "Presence lifetime" below); it is only
  clamped so a client cannot claim to have been active in the future. A malformed `cursor` (wrong
  shape) is dropped rather than forwarded, so a peer's `Y.createRelativePositionFromJSON` never
  throws on garbage.

**A real bug found and fixed while writing the integration test, not assumed away.** The first
version of `sanitizeAwarenessStates` rejected (cleared) any inbound message naming more than one
client id, on the theory that a single connection's `Awareness` only ever reports its own state.
That theory is correct in spirit but wrong about cardinality: confirmed directly against a real
`HocuspocusProvider`/`Awareness` pair, `HocuspocusProviderWebsocket.awarenessUpdateHandler` batches
`added`/`updated`/`removed` client ids arriving within one flush window into a single outbound
message, and a single browser tab's own internal bookkeeping can legitimately name more than one
client id in one message. The stricter check silently dropped every one of these -- which is exactly
how the new identity-spoofing integration test (below) first failed, with the remote peer never
receiving _anything_, not even a corrected identity. Fixed by stamping the connection's own identity
onto **every** entry in the map instead of requiring exactly one; the spoofing guarantee does not
depend on the cardinality assumption (a connection still only ever has one authenticated identity to
attribute), so nothing about the security property was weakened -- only a false-positive rejection of
legitimate traffic was removed.

### Client (headless): `packages/screenplay-editor/src/presence.ts`

Wraps `y-prosemirror`'s own `yCursorPlugin` (correctness-critical relative-position tracking and
decoration lifecycle, reused rather than reimplemented) with:

- `buildRemoteCursorWidget(user)` -- the geometry-safe caret DOM. `position: absolute` with no
  `top`/`left` of its own, the exact technique `styles.css`'s `.smarttype-ghost` rule already uses
  and documents: it paints at exactly the position an inline insertion would have had while being
  completely removed from layout, so it cannot widen a line, wrap a line, or grow `.script-body`'s
  content-sized height.
- `noRemoteSelectionAttrs()` -- the owner's decision was narrower than y-prosemirror's own default
  (which always also highlights the remote selection range): "a thin coloured caret," not a
  highlighted range. This supplies no attributes, so that decoration exists (satisfying
  `yCursorPlugin`'s own control flow) without rendering anything.
- `presenceHeartbeatPlugin` -- refreshes this browser's own `lastActiveAt` on real, locally-originated
  activity (a keystroke, a caret move), reading `ySyncPluginKey.getState(state).isChangeOrigin` to
  tell a local edit apart from a remote peer's edit merging in -- the identical field `y-prosemirror`
  itself uses internally for the same distinction. Marks the tab present the instant it mounts,
  before any keystroke.
- `listPresentParticipants(awareness, now)` -- the pure function the participant indicator reads;
  excludes self and anyone outside the active window.

**A real ordering bug, found and documented rather than worked around blindly.** Tiptap's
`ExtensionManager.plugins` reverses the extension array (then stable-sorts by priority) before
flattening it into ProseMirror plugins -- "a later entry runs first" is the framework's own framing,
for keymap/override priority. `yCursorPlugin`'s `state.init` synchronously reads
`ySyncPluginKey.getState(state)`, which is only populated once `ySyncPlugin` has itself run its own
`init`. Registering the presence extension _after_ `editorInit.extensions` (`ScreenplayYjsExtension`)
crashes with `TypeError: Cannot read properties of undefined (reading 'doc')` inside y-prosemirror's
own `createDecorations` -- confirmed directly, not assumed, both in the package's own test suite and
in `App.tsx`. The extension must be listed _before_ `editorInit.extensions` for `ySyncPlugin` to end
up later in the final plugin list and therefore initialize first. Both `presence.test.ts` and
`App.tsx`'s own `extensions` `useMemo` carry this exact reasoning in a comment at the call site.

### Client (App.tsx and UI)

- `extensions` (`App.tsx`) conditionally prepends `createRemotePresenceExtension(collab.provider
.awareness)` when a real collaboration server is connected; unchanged (and still ordered correctly)
  for every local-only editor.
- `apps/web/src/components/ParticipantIndicator.tsx` -- a small coloured-initial avatar row in the
  status bar (`.statusbar`, after `.status-center`, taking the bar's free right edge the same way
  `.status-attention` already does), subscribing to `awareness.on('change', ...)` plus a 5-second
  poll (matching the client-side "typing glow" recheck's own reasoning: staleness is a function of
  wall-clock time, not an event).
- CSS: `.remote-cursor`/`.remote-cursor-caret`/`.remote-cursor-label` in `styles.css`, placed directly
  after `.smarttype-ghost`'s own rule and its established comment convention;
  `.participant-indicator`/`.participant-avatar` near `.status-attention`.

## Design decisions

**What awareness carries, and why.** Exactly two fields, ever: `cursor` (y-prosemirror's own relative
position pair) and `user: { name, color, lastActiveAt }`. Deliberately absent: email, role, account
id, or anything else the session carries -- awareness reaches every other connected client (plan.md:
"Presence is a privacy surface... decide what it exposes before building it, not after"), so this
defaults to less. The client never even computes its own name or colour; there would be nothing for
anyone to read them from, since the server always overwrites both (see above).

**Colour: stable per user, not per session.** `deriveParticipantColor` hashes the actor id. A
reconnecting writer keeps the same colour -- a colour that changes on every reload would be its own
kind of confusing -- at the cost of two accounts occasionally hashing to the same 1-of-8 palette slot,
which the owner's framing already accepted as a tradeoff. The name label (on hover, or briefly while
typing) always disambiguates.

**What counts as "present": a connected socket is not enough.** y-protocols' own `Awareness` class
doc comment is explicit that this needs stating: "Awareness states must be updated every 30 seconds.
Otherwise the Awareness instance will delete the client state" -- a **liveness** requirement
(`@hocuspocus/provider`'s own periodic heartbeat resend keeps a connection from being locally
garbage-collected), not an **activity** signal. Relying on state presence alone would make a tab left
open overnight look like a live participant forever. `PRESENCE_ACTIVE_WINDOW_MS` (10 minutes) is the
separate, additional requirement: `lastActiveAt` must be recent, checked both by the cursor's own
`awarenessStateFilter` (a stale peer's caret stops drawing) and by `listPresentParticipants` (a stale
peer drops off the indicator entirely, not merely greyed). `lastActiveAt` is stamped at connect time
(not only on first keystroke), so a participant who just opened the document and hasn't typed yet is
still counted present. `PRESENCE_TYPING_GLOW_MS` (2 seconds) is a separate, much shorter window,
purely for the name label's "briefly when they start typing" reveal -- it never affects whether the
caret itself draws or whether the participant list shows them.

**Reconnection: verified against the installed libraries, not assumed handled.** Read directly from
`@hocuspocus/provider`'s compiled source: `HocuspocusProvider.onClose()` calls
`removeAwarenessStates(this.awareness, [...otherClientIds], this)` -- on our _own_ disconnect, every
other participant's cached state is cleared locally, so a dropped socket does not leave stale remote
cursors rendered during the offline window. And from `@hocuspocus/server`'s compiled source:
`Document` tracks `pendingAwarenessClients` per connection and calls the identical
`removeAwarenessStates(...)` when that connection actually closes, broadcasting the removal to every
remaining peer -- so _other_ writers see a dropped participant vanish promptly, not after a 30-second
timeout. Both directions of "no ghosts on reconnect" are therefore already correct by construction in
the installed libraries; this slice's own code contributes nothing extra here and needed nothing
extra, beyond not fighting that behaviour.

## The two-client browser proof

`apps/web/e2e/presence-persistence.spec.ts`, one test, added to `playwright.persistence.config.ts`'s
`testMatch` (and `playwright.config.ts`'s `testIgnore`) rather than a new config: presence needs no
different server settings than the persistence suite already runs with (awareness is not affected by
`FINALER_SYSTEM_TEST`'s shortened debounce -- that setting only changes `onStoreDocument`'s timing,
and awareness never reaches `onStoreDocument` at all, which the new
`presence never reaches the database` integration test proves directly), so a second full stack (a
second built web bundle, a second API, a second collab server) would duplicate this config's own
`webServer`s for no isolation benefit.

Two browser _contexts_, one _account_: this codebase has no user-facing way to add a second real
account to a project, and the property under test (does a remote caret move a line) does not depend
on the two sessions belonging to different people. Context A signs up and seeds two short action
blocks; context B signs the same account in independently and opens the identical screenplay URL.

**What it measures, precisely, and why the shape is what it is.** `measurePage` is copied verbatim
from `page-rendering-persistence.spec.ts` (per that file's own established convention of copying
rather than sharing flow helpers across real-editor specs), reading every block's own top/height and
every rendered line's client rects off `block.firstChild`. That capture assumes `firstChild` is the
block's one intact text node -- true for every overlay this suite has proven safe before (SmartType's
ghost, the element menu), but **not** true for a widget decoration landing mid-text or at a block's
very start, which splits or displaces that one text node. This was discovered empirically while
writing the test (an early version measured a caret placed mid-line and failed with a completely
different -- but correct-looking-if-you-didn't-know-better -- set of line rects, which took real
investigation to distinguish from an actual geometry regression). The test therefore moves the
tracked caret only between the _end_ of two different blocks' own text -- both boundary positions
where the widget is appended after, never splitting, the block's one text node -- while still proving
a genuine **move** (not merely an appearance) between two distinct visual rows. B measures its own
`.page`/`.editor-region`/`[data-screenplay-block]` geometry once with A's caret steady at the end of
block 2, then again after A clicks to the end of block 1 (a click, not `Home`/`End` -- confirmed
directly that a bare `Home` keypress dispatched over Playwright's CDP has no effect on this
contenteditable's selection in this environment, while `ArrowLeft` and a plain click both work
reliably), and asserts the two measurements are deeply equal. A positive check (`.remote-cursor` is
attached, `.remote-cursor-label` reads "Writer", and the caret's own bounding box actually moved to a
smaller `y`) runs first, so the geometry assertion cannot trivially pass because presence never
rendered at all.

**Mutation-tested, the one that matters most.** Removed `position: absolute` from `.remote-cursor`
in `styles.css`, rebuilt, re-ran this one test scoped (`pnpm test:system:persistence -- -g
"presence"`): it failed, correctly -- the widget participated in normal inline flow, growing the
first block's own height from 16px to 18.39px and shifting every later block and line down by
1.4-2.4px, exactly the defect class this test exists to catch. Reverted, re-ran, green again. Also
mutation-tested at the unit level (`apps/collab/src/presence.ts`): reverting the identity-overwrite
to trust a client-claimed `name`/`color` was caught by 3 unit tests _and_ by the new end-to-end
identity-spoofing integration test over a real socket; reverted and reconfirmed clean by `diff`
against the pre-mutation file before moving on.

## `HocuspocusProvider` mocking: not built, and why

`App.test.tsx` still has no `HocuspocusProvider` mock, the gap slice 1 flagged and said this slice
would want. Judged not worth building this slice, for three reasons: (1) the presence logic itself --
sanitization, geometry-safe rendering, active-window filtering, the heartbeat -- is fully covered by
lower-level unit tests using **real** `Y.Doc`/`Awareness` pairs (`packages/screenplay-editor/src/
presence.test.ts`, 19 tests, 100% coverage on `presence.ts`), which needs no provider or socket at
all; (2) the true end-to-end proof is the real two-browser-context Playwright test above, a stronger
guarantee than a mocked unit test could give, mirroring slice 1's own precedent of preferring a real
integration test over reconstructing the same guarantee through a double; (3) `App.tsx`'s own new
surface is a two-line conditional extension inclusion plus one presentational component -- thin
enough that a single local-mode (`collab.provider === undefined`, true for every existing test in
this file) regression test suffices (`App.test.tsx`: "shows no participant indicator with no
collaboration server configured"). Flagged here plainly rather than left unstated, per the standing
instruction.

## The StrictMode leak: it does force itself into scope, confirmed, not fixed

Slice 1 documented, and deliberately deferred, a leak: React `<StrictMode>` (dev builds only) causes
four handshakes per screenplay mount, with three providers abandoned but never destroyed (the
double-render-then-commit React performs on true initial mount constructs a `HocuspocusProvider` --
which opens a socket eagerly in its constructor -- inside a render pass that is then discarded, and
nothing ever calls `.destroy()` on a discarded render's side effects). The brief for this slice asked
specifically whether presence turns that invisible leak into a visible one, and to report rather than
silently widen scope if so.

**Confirmed directly**, not reasoned from the architecture alone: started `pnpm dev` (all three
processes, StrictMode on, the only build it ever runs in) against a disposable database created and
dropped for this check only (the owner's real `.env`, database, and Resend account were never
touched -- `FINALER_SYSTEM_TEST=true` was set only to reach the test-mailbox endpoint for email
verification, mirroring slice 1's own established pattern for this kind of check), drove a real
headless Chromium through sign-up, project and screenplay creation, and into the editor. The
screenplay's own `<ParticipantIndicator>` -- reading the _real_ committed provider's own `Awareness`,
which does not exclude _other_ client ids from the same browser/account, only its own -- showed
**one phantom "Writer" avatar**, a single browser tab appearing to have another collaborator who is
actually an abandoned, still-open StrictMode duplicate of itself.

This is real and user (developer)-visible the moment presence ships, exactly as the brief anticipated
-- but it is self-limiting, not unbounded: because an abandoned provider's `view()` never receives
another transaction (nothing renders to it, nothing types into it), `presenceHeartbeatPlugin` stamps
`lastActiveAt` once at mount and never again, so this slice's own `PRESENCE_ACTIVE_WINDOW_MS` ages the
phantom out of the participant list after 10 minutes on its own, even though the underlying leaked
socket itself remains open indefinitely (a resource leak, already documented in slice 1, and still
not addressed here). **Not fixed in this slice.** The correct fix is the one slice 1 already scoped
and declined to patch under time pressure -- giving `collab.provider` a lifecycle that does not assume
"constructed" means "trustworthy," the same architectural question slice 1's two StrictMode-adjacent
defects both trace back to -- and remains an explicit decision for the owner, not something to work
around silently inside this slice.

## Known limitations, honestly

- The StrictMode leak above: confirmed to now be user-visible, not fixed, self-limiting to 10 minutes
  per phantom via this slice's own active-window design.
- No remote selection-range highlighting -- the owner's decision was narrower ("a thin coloured
  caret"), so `yCursorPlugin`'s own default selection decoration is deliberately suppressed
  (`noRemoteSelectionAttrs`), not merely unbuilt.
- `App.test.tsx` carries no dedicated `HocuspocusProvider` mock; see the section above for the
  reasoning and what stands in for it instead.
- Colour collisions across accounts are accepted, not eliminated -- 8 palette slots, disambiguated by
  the name label, per the owner's own framing of the tradeoff.

## Gates -- every one run and checked by `$?`

1. `pnpm lint` -- exit 0.
2. `pnpm format:check` -- exit 0.
3. `pnpm typecheck` -- exit 0.
4. `pnpm test` -- exit 0. New/changed test counts: `packages/screenplay-editor` 75 (was 56: +19 in
   `presence.test.ts`, 100% line/branch/function coverage on the new `presence.ts`); `apps/collab` 53
   passed / 8 skipped (was 25 passed / 3 skipped: +17 new unit tests in `presence.test.ts`, +3 new
   integration tests -- the database-boundary test, the identity-spoofing test, and the batching-fix
   regression captured inside the existing suite's own tests); `apps/web` 615 (was 608: +6 in
   `ParticipantIndicator.test.tsx`, +1 in `App.test.tsx`).
5. `pnpm test:coverage` -- exit 0. `packages/screenplay-editor` 97.11% all-files (up from the 96.5%
   baseline this brief cited); `apps/collab` 98.83% across its tracked files (`authenticate.ts`,
   `database.ts`, and now `src/presence.ts`, added to `vitest.config.ts`'s coverage `include` list
   alongside the other security-relevant module it already tracked).
6. `pnpm check:bundle-budget` -- exit 0. Entry chunk 111.65 kB/120 kB (unchanged -- presence code
   only ever loads inside the lazy editor chunk). Lazy editor chunk 141.97 kB/200 kB, up from the
   139.76 kB slice-1 baseline (+2.21 kB for `y-protocols`, `presence.ts`, and
   `ParticipantIndicator.tsx`, comfortably inside budget). CSS 6.50 kB/20 kB.
7. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/api test:integration` -- exit 0, 39/39.
8. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/collab test:integration` -- exit 0, 8/8 (the
   5 tests slice 1 left plus this slice's 3: database-boundary, identity-spoofing, and the two
   already-passing tests that incidentally exercise the batching-fix path). Re-run three times total
   across this session with no flake.
9. `TEST_DATABASE_URL=<...> pnpm test:system:persistence` -- exit 0, **19/19** (the 18-test slice-1
   baseline plus the new `presence-persistence.spec.ts`). Re-run twice more, 19/19 both times.
10. `pnpm test:system` -- exit 0, 40/40, unaffected by this slice.

No `git add`/`commit`/`push`/`gh pr create`. No `railway` commands of any kind. No credential logged,
hardcoded, or written to any file -- the exact `TEST_DATABASE_URL` substitution given was used
verbatim; the owner's real `.env` was read only for that one substitution and never printed. No
emoji, no TODO/placeholder comments, strict TypeScript throughout. No existing assertion weakened,
skipped, or deleted, and no coverage threshold lowered -- every new test is additive, and the one
place an existing assertion's premise changed (`sanitizeAwarenessStates`'s "exactly one client id"
check) was a genuine bug found by testing against the real protocol, fixed and re-verified stricter
where it matters (identity is still always server-attributed) and looser only where the old check was
provably wrong (legitimate multi-client-id batching).

## Follow-up: two real-browser defects the owner found, and what was actually wrong

The owner tested this slice in a real browser and reported two defects: (A) a peer already
connected and positioned when you join is not visible until they move again, and (B) even a
visible cursor is "just the name tag" -- the caret line itself never renders. Both were
investigated with real, live measurement (two actual browser contexts driven against a real
`pnpm dev` stack on a disposable database, `getBoundingClientRect()`/`getComputedStyle()` read
directly, not reasoned about), per the explicit instruction not to trust reasoning over
measurement here. **One defect, not two, turned out to be real** -- see below.

### Defect B, confirmed and fixed: `box-sizing` collapsed the caret's painted area to zero

`.remote-cursor-caret` declared `width: 2px` and `padding-inline: 3px` (6px of padding total),
relying on `background-clip: content-box` to paint only the 2px stripe. This app's own global
reset, `* { box-sizing: border-box; }` (`styles.css`, near the top of the file), applies to this
element too: under `border-box`, `width` specifies the _border-box_ width, and the CSS box-sizing
spec requires that when the declared width is smaller than the padding, the used border-box width
grows to fit the padding, with content width clamped to zero. Measured directly in a real browser,
before any fix: `getComputedStyle('.remote-cursor-caret').width` read `"6px"` (not `"2px"`) --
exactly the padding total, meaning the content box `background-clip: content-box` paints was 0×18px.
The caret was correctly attached, correctly positioned, and correctly proven not to displace
anything -- and painted nothing at all. This is why the existing geometry test passed throughout:
"exists, in the right place, displaces nothing" is satisfiable by an invisible element.

**Fix:** `box-sizing: content-box` added directly to `.remote-cursor-caret` (`apps/web/src/
styles.css`), overriding the inherited global default for this one element so `width: 2px` means
exactly a 2px painted stripe regardless of the padding placed around it for a wider hover target.
Verified directly, before touching any test: re-measured the same live scenario after the fix --
`getComputedStyle(...).width` now reads `"2px"`, `getBoundingClientRect()` on the caret shows an
8px border box (2px content + 3px+3px padding), and the colour is the participant's own
(`rgb(202, 138, 4)` in the live check), not transparent.

### Defect A, investigated and found not to be a separate bug

Two live, two-context checks were run, both with context B joining _after_ context A was already
fully positioned (not the "both join, then move" shape the first version of the automated test
used):

1. A typed and positioned its caret, B joined roughly a second later (well within
   `PRESENCE_TYPING_GLOW_MS`): B's `.remote-cursor` was present, correctly positioned, and carrying
   `data-remote-cursor-active` -- immediately, with no wait beyond B's own `Synced` state, no
   further activity from A.
2. A typed, positioned its caret, and then **waited 6 seconds -- past the 2-second typing-glow
   window -- before B ever opened the document**, the shape that most resembles "a peer who has
   been sitting there a while". B's `.remote-cursor` was still present and correctly positioned the
   instant B's own sync completed, with `data-remote-cursor-active` correctly _absent_ (A is
   idle -- this is the right answer, not a bug) and, once defect B was fixed, the caret line itself
   correctly painted and coloured.

Both checks are consistent with `@hocuspocus/server`/`@hocuspocus/provider`'s own compiled source
(read directly): a newly connecting client receives the document's current awareness snapshot on
connect (`sendCurrentAwareness`, server-side), and nothing in this slice's own code -- the
`beforeHandleAwareness` sanitizer included -- interferes with that path. **No separate delivery
defect was found.** What the owner's report described is fully explained by defect B: the caret
line was invisible, and the name label -- the only thing that ever painted anything -- only shows
on hover or during the 2-second post-activity glow. A writer joining a document where the other
person is idle (not actively typing at that moment) would see nothing at all -- not because
nothing synced, but because nothing was drawn -- until that person typed again and the label
flashed into view. That flash is what read as "only movement after I join appears to register."
Reported plainly rather than assumed fixed: this conclusion rests on two live checks, not
exhaustive fuzzing of every timing window, and if it recurs after defect B's fix it would need to
be re-opened as a genuine, separate defect.

### The new assertions, and the mutations proving they bite

`presence-persistence.spec.ts` gained `measureCaretPaint`, used by both tests:

- The existing test ("caret move... geometry unchanged") now also asserts, at both the steady-state
  snapshot and after the move, that `.remote-cursor-caret`'s painted content width and height are
  non-zero and its background colour is neither `rgba(0, 0, 0, 0)` nor `transparent`.
- A new second test, `a peer who is already connected and positioned -- and has since gone idle --
is visible the instant I join, with no further activity from them required`, reproduces exactly
  the join-after-positioned-and-idle shape above: A types, waits past `PRESENCE_TYPING_GLOW_MS`,
  _then_ B opens the document. Asserts the caret is attached, `data-remote-cursor-active` is
  correctly absent (idle, not broken), and the caret paints -- immediately, no polling, no wait
  beyond the existing `Synced` check.

**`measureCaretPaint`'s own bug, found by mutation-testing it, not merely reasoned to be correct.**
The first version computed `contentWidthPx` from `getComputedStyle(...).width` directly. Re-applying
the `box-sizing: border-box` mutation (below) against that version **passed both tests** -- the
assertion existed but could not fail, because `getComputedStyle().width` under `border-box` reports
the grown _border-box_ width (6px, all padding), which is `> 0` regardless of whether any content
is actually painted. This is exactly the class of gap the coordinator's message warned about: an
assertion that cannot fail is not testing anything. Fixed by computing content width as
`rect.width - paddingLeft - paddingRight` (`getBoundingClientRect()`'s border-box width is
box-sizing-independent, so subtracting the always-correctly-reported padding gives the true content
width regardless of which box-sizing model is in effect) -- confirmed sensitive to the real defect
before trusting it further.

Three mutations, each applied, confirmed to fail the correct assertion, then reverted and
reconfirmed identical to baseline by `diff`:

1. `.remote-cursor-caret`'s `box-sizing: content-box` reverted to `border-box` (reproducing the
   original defect exactly) -- both tests failed on `contentWidthPx` reading `0`, not on the
   geometry (`toEqual`) assertion, confirming the paint check is what catches this, not the
   pre-existing geometry check.
2. `caret.style.backgroundColor = color` removed from `buildRemoteCursorWidget`
   (`packages/screenplay-editor/src/presence.ts`) -- both tests failed on the background-colour
   assertion (`rgba(0, 0, 0, 0)`), independently of the width checks.
3. `.remote-cursor`'s `position: absolute` removed (the pre-existing defect class this file's first
   version already mutation-tested, re-run here to confirm it still catches after the new
   assertions were added) -- the first test still failed on the `measurePage` geometry `toEqual`,
   unaffected by the new paint checks being added alongside it.

### A gate defect found and fixed along the way, unrelated to either browser defect

Re-running the full gate suite surfaced `pnpm test:coverage` failing (exit 1) for
`packages/screenplay-editor` specifically, with an _unhandled_ asynchronous exception: `TypeError:
target.getClientRects is not a function`, thrown from deep inside `prosemirror-view`'s
`coordsAtPos` during a `requestAnimationFrame`-deferred scroll-into-view triggered by
`presence.test.ts`'s `editor.commands.focus('end')` call. This is a long-documented jsdom gap
(`Range.prototype.getClientRects`/`getBoundingClientRect` are simply not implemented in jsdom
26.1.0) that `apps/web/src/test/setup.ts` already polyfills for exactly this reason -- but
`packages/screenplay-editor`'s own `vitest.config.ts` had no `setupFiles` at all, and
`presence.test.ts`'s `focus('end')` call was the first test in this package ever to reach the
affected code path. Confirmed to reproduce deterministically (3/3 isolated runs) before the fix and
resolved deterministically (3/3 after); the polyfill was copied (not shared, matching this
package's existing dependency-free convention) into a new `packages/screenplay-editor/src/test/
setup.ts`, wired via `vitest.config.ts`'s `setupFiles`, and excluded from this package's own
coverage accounting (it is a jsdom shim, not this package's logic, and its `if (!jsdom-has-this)`
branches are only ever exercised the one way the installed jsdom actually behaves).

### Gates for this follow-up -- every one run and checked by `$?`

1. `pnpm lint` -- exit 0.
2. `pnpm format:check` -- exit 0.
3. `pnpm typecheck` -- exit 0.
4. `pnpm test` -- exit 0, 615/615 in `apps/web` unaffected; `packages/screenplay-editor` still
   75/75 (test _count_ unchanged by this follow-up -- the fixes were to existing tests' own
   environment and to `styles.css`/`presence.ts`, not new unit tests).
5. `pnpm test:coverage` -- exit 0 (was exit 1 before the jsdom-setup fix above), re-run twice more
   for stability, both exit 0, zero unhandled errors either time. `packages/screenplay-editor`
   still 97.11% all-files, `presence.ts` still 100%.
6. `pnpm check:bundle-budget` -- exit 0, unchanged (this follow-up added no new client-side code,
   only CSS and a test-environment fix).
7. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/api test:integration` -- exit 0, 39/39.
8. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/collab test:integration` -- exit 0, 8/8.
9. `TEST_DATABASE_URL=<...> pnpm test:system:persistence`, three consecutive runs -- exit 0 all
   three times, **20/20 every time** (the original 19 plus the new join-after-positioned test;
   every one of the original 19, the geometry mutation included, still passes unchanged).
10. `pnpm test:system` -- exit 0, 40/40, unaffected.

No `git add`/`commit`/`push`. No `railway` commands. No `.env` edits -- the disposable databases
used for live browser verification were created and dropped for this check only, with their own
freshly generated, throwaway `BETTER_AUTH_SECRET`; the owner's real `.env`, database, and Resend
account were never touched. No test weakened or skipped; the one existing assertion whose
_measurement method_ changed (`measureCaretPaint`'s width calculation) was strengthened, not
loosened -- it went from an assertion that could not fail to one proven, by mutation, to fail
correctly. No coverage threshold lowered.

## Follow-up 2: the caret painted in the wrong place

The owner confirmed the caret is now visible and reported a third, distinct defect: on his own
screen a cursor between two characters reads as `cl|ient`, but on another writer's screen the
remote caret appeared to cover the `i` -- a consistent rightward shift, not jitter.

### Mechanism, confirmed by measurement before any fix

`.remote-cursor-caret` is `display: inline-block` with `padding-inline: 3px`, and
`background-clip: content-box` paints only the 2px content stripe -- which therefore starts 3px to
the right of the element's own border-box left edge, the edge that sits on the anchor position
(`.remote-cursor`, the wrapper, is `position: absolute` with no `left` of its own, so it uses its
_static_ position, which is the anchor).

Measured directly in a real, two-context browser check (a disposable database, real `pnpm dev`,
`getBoundingClientRect()`/`getComputedStyle()` on the live DOM -- not reasoned about): a `Range` at
the exact anchored text offset (`"cl|ient"`, offset 2) versus the caret's own painted left edge
(`caretRect.left + paddingLeft`) showed a delta of **exactly 3px**, matching the padding value
exactly. Re-measured at a second, different anchor position (end of a much longer line) with the
same result. On the manuscript's 9.6px character cell (`NOMINAL_CHARACTERS_PER_INCH`,
`@finaler-draft/screenplay/pageFormat`, 96dpi), a 3px shift is under a third of a cell but -- because
a caret sits _between_ two characters, not on one -- large enough to visually land over the
following glyph, matching "covering the i" exactly. Confirmed as described; no correction needed to
the coordinator's own reading.

### Fix

`.remote-cursor-caret` gained `margin-left: calc(-1 * var(--remote-cursor-hover-padding))`, where
`--remote-cursor-hover-padding: 3px` is the same value `padding-inline` now reads from, defined once
so the two can never drift apart. The negative margin shifts the caret's own border box left by
exactly the padding, which (padding still being 3px on top) puts the _content_ box -- what actually
paints -- back at the anchor position exactly.

**Why this, and not the other options:**

- **Not an explicit `left` on `.remote-cursor` (the wrapper).** `.remote-cursor` relies entirely on
  the CSS rule that an absolutely positioned element with `left`/`right` both `auto` uses its
  _static_ position (where it would have fallen in normal flow) -- that is the whole mechanism that
  currently puts it on the anchor with no arithmetic at all. Setting any explicit `left` abandons
  that rule outright and repositions instead relative to the element's _containing block_ (the
  nearest positioned ancestor -- `.page`, confirmed `position: relative`, not `.remote-cursor`'s
  immediate DOM parent), a different coordinate space entirely with no fixed offset that would
  correct for it. The fix therefore has to live entirely _inside_ `.remote-cursor`'s own local
  layout, never on its own absolute-positioning properties.
- **Not removing the padding.** The coordinator's own constraint: the padding is a real
  accessibility affordance (a 2px target is too thin to reliably hover/point at), and deleting it
  to fix the paint position would trade one real problem for another.
- **A negative margin on the caret, not a transform.** `margin-left` on an inline-block shifts its
  position within its own line box -- a purely local effect with no interaction with the wrapper's
  absolute positioning, verified by the same live measurement that confirmed the fix (delta 0px at
  two different anchor positions after applying it). A `transform: translateX(-3px)` would have
  worked equivalently but was not needed once the margin route was confirmed to compose cleanly
  with everything else on the element (`box-sizing: content-box`, the existing padding); introducing
  a second CSS positioning mechanism alongside the first was not worth it for no additional benefit.

A side effect, noted rather than engineered for: `.remote-cursor-label`'s own `left: 0` was already
anchored to the wrapper, not the caret, so it was never affected by the padding-induced shift in the
first place -- but it is now also flush with the _painted_ caret stripe's own left edge (both sit at
the anchor), where before the fix the label sat 3px left of where the caret actually painted. A
minor, purely cosmetic improvement, not the property this fix was made for.

### The new assertion, and the mutation proving it bites

`presence-persistence.spec.ts` gained `measureCaretPlacement`, comparing the caret's painted left
edge against a `Range` at the exact anchored text position (the same "end of the block's own text"
position both tests already require, found via `caret.closest('[data-screenplay-block]')` so one
helper serves both). `CARET_PLACEMENT_TOLERANCE_PX = 1`: under a ninth of the 9.6px character cell,
comfortably tighter than the "tolerates a third of a character is not worth having" bar, while
covering ordinary sub-pixel rounding between two independently measured DOM rects -- live
measurement after the fix read an exact 0px delta twice, so the 1px of slack is for measurement
noise, not an admission the fix is approximate. Both tests now assert this at every point they
already assert paint (steady state and after the move in the first test; on join in the second).

**Mutated:** reduced the compensating margin by 2px (`calc(-1 \* var(--remote-cursor-hover-padding)

- 2px)`), leaving a small, deliberately sub-original-defect 2px residual offset. Both new
assertions failed correctly (`Expected: <= 1`, `Received: 2`) at both call sites. Reverted,
re-confirmed identical to baseline by `diff`, re-ran green. Also re-ran the pre-existing
`position: absolute`mutation (the property the coordinator specifically required to survive this
fix) to confirm it is still caught, unaffected by the new rule: still fails on the`measurePage`geometry`toEqual`, exactly as before.

### Gates for this follow-up -- every one run and checked by `$?`

1. `pnpm lint` -- exit 0.
2. `pnpm format:check` -- exit 0.
3. `pnpm typecheck` -- exit 0.
4. `pnpm test` -- exit 0, 615/615 (`apps/web`), 75/75 (`packages/screenplay-editor`) -- no new unit
   tests added by this follow-up; the new coverage is entirely in the Playwright spec.
5. `pnpm test:coverage` -- exit 0, unaffected (this follow-up touched only `styles.css` and the
   Playwright spec, no package source).
6. `pnpm check:bundle-budget` -- exit 0, unchanged (a CSS-only change; entry 111.65 kB/120 kB, lazy
   editor chunk 141.97 kB/200 kB, CSS 6.53 kB/20 kB).
7. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/api test:integration` -- exit 0, 39/39.
8. `TEST_DATABASE_URL=<...> pnpm --filter @finaler-draft/collab test:integration` -- exit 0, 8/8.
9. `TEST_DATABASE_URL=<...> pnpm test:system:persistence`, three consecutive runs -- exit 0 all
   three times, **20/20 every time**, matching the count the coordinator verified.
10. `pnpm test:system` -- exit 0, 40/40.

No `git add`/`commit`/`push`. No `railway` commands. No `.env` edits -- the disposable database used
for live measurement was created and dropped for this check only, with its own freshly generated,
throwaway secret; the owner's real `.env`, database, and Resend account were never touched. No test
weakened, skipped, or made more permissive; the new placement assertion is strictly additive and was
proven, by mutation, to fail on an offset well inside the original defect's own magnitude.

# Remote cursor click-through

Branch `fix/remote-cursor-click-through`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/cursor-clickthrough`, off `8503d71`.

## The defect, in the owner's words

"When another user's cursor is somewhere I want to be, it makes it hard to click into that spot.
When another user's cursor is clicked on, it should move your cursor there as if you had clicked on
the spot without any other cursor there."

`.remote-cursor-caret` (`apps/web/src/styles.css`) deliberately keeps a hit target wider than its
painted stripe -- `padding-inline`/`background-clip: content-box`, roughly 8px wide against a 2px
painted width -- so the writer's name is easy to reach on hover (the owner's own slice-2 decision).
That wide hit target is what a stray click lands on instead of the manuscript underneath.

**`pointer-events: none` was rejected as the fix.** It would make the whole widget unhoverable and
silently remove the name-on-hover reveal slice 2 shipped. The fix keeps the caret fully
hit-testable and forwards the click, in JavaScript, to the position it would have landed at with no
widget there at all.

## Where the handler lives, and why two implementations

**The manuscript body** (`packages/screenplay-editor/src/presence.ts`, `remoteCursorClickThroughPlugin`

- `forwardRemoteCursorClick`, both exported): registered as one more ProseMirror plugin inside
  `createRemotePresenceExtension`, alongside `yCursorPlugin` and the heartbeat plugin. It uses
  `EditorView.posAtCoords`, ProseMirror's own pixel-to-document-position mapping, which measures the
  _underlying text's own rendered rects_ rather than asking the browser which element is topmost at a
  point. Because `.remote-cursor` is `position: absolute` with no layout footprint of its own (the
  "displaces nothing" property `presence-persistence.spec.ts` already measures), the widget never
  shifts where `posAtCoords` believes the surrounding text to be -- the same `(x, y)` resolves to the
  same document position whether or not a widget sits on top of it. `Selection.near` is the exact call
  ProseMirror's own default mousedown handling falls back to (`prosemirror-view`'s `LeftMouseDown.up`,
  via `updateSelection`) once it has a position and no other plugin has claimed the click, reused here
  rather than re-derived, so this plugin's placement agrees with an ordinary click by construction.

**The title page** (`apps/web/src/titlePageCursors.ts`, `forwardTitlePageRemoteCursorClick` +
`resolveCaretFromPoint` + `suppressPointerEvents`, all exported except the last): wired into
`useTitlePagePresence`'s existing remote-render effect via a `mousedown` listener on the `.title-page`
container. The title page is bare `contentEditable` divs, not a ProseMirror document, so there is no
`posAtCoords`-equivalent to lean on -- the only tool available is the DOM's own point-to-caret lookup
(`document.caretPositionFromPoint`, with `document.caretRangeFromPoint` as the WebKit fallback for
Safari, which does not implement the standard method as of this writing). Unlike `posAtCoords`, that
lookup _is_ ordinary hit-testing: it resolves to whichever element is topmost at the point, respecting
`pointer-events` exactly like a real click would. Landing on `.remote-cursor-caret` would therefore
resolve to a position _inside the widget_, not the field text under it -- the defect this exists to
fix. `suppressPointerEvents` closes that gap: it sets the caret's own `pointer-events` to `none` for
the single synchronous duration of the lookup call, then restores whatever value was there before.
This is deliberately not the same thing as the rejected CSS-level fix -- the CSS warning is about a
_permanent_ rule that would make the widget unhoverable for as long as it is mounted; this toggle
exists for one synchronous call inside one mousedown handler, with no repaint in between the `none`
and the restore, so `:hover` never has a chance to visibly drop.

**Two small, surface-specific implementations, not one shared abstraction.** The two hit-testing
models are genuinely different: one measures text geometry directly and is immune to DOM z-order,
the other is native point-in-element hit-testing that has to be told, per call, to look through one
specific element. Forcing them through one shared function would mean branching on which model
applies inside a supposedly-shared abstraction, which is not sharing, it is one function pretending
to be two.

## mousedown, not click

Both surfaces register on `mousedown`, not `click`. Text selection -- both the browser's native one
and ProseMirror's own -- begins on mousedown; `click` fires only after mouseup, by which point the
browser's own default mousedown handling of the `contentEditable="false"` widget has already run,
which is the defect itself. Only `mousedown` can pre-empt it.

For the body, `handleDOMEvents.mousedown` is checked (via ProseMirror's `runCustomHandler`) _before_
ProseMirror's own built-in `handlers.mousedown` for the same event -- confirmed by reading the
installed `prosemirror-view` source, not assumed. Returning `true` skips ProseMirror's own handling
entirely for that event, including the `LeftMouseDown` tracker that turns a mousedown into a
drag-selection on subsequent `mousemove`.

**Drag is out of scope, by construction.** A drag that _starts_ with the mouse down on a remote
cursor's widget always collapses to a single caret placement at the click point on both surfaces:
the caret moves there, and the subsequent drag is inert (no selection extends) until the writer
releases and presses down again somewhere ordinary. A drag that only _passes over_ a remote cursor
after already starting elsewhere is unaffected on the body (no plugin runs the check there is
nothing to claim) and on the title page (the `mousedown` listener only ever fires for the mousedown
event itself, never for a `mousemove` crossing the widget mid-drag).

## The 8px hit target

Left unchanged. It exists to make hover easy, and clicks now pass through it regardless of its
width, so that rationale survives intact -- shrinking it would only make the name harder to find on
hover, for no remaining benefit now that a stray click on it does the right thing.

## Proving click-through equivalence, not "somewhere reasonable"

Two Playwright tests (`apps/web/e2e/presence-persistence.spec.ts`,
`apps/web/e2e/titlepage-cursors-persistence.spec.ts`), each clicking the _literal same pixel_ twice:
once with nothing drawn over it (the control), once with a peer's remote-cursor widget sitting
exactly on it (the click-through case). Both reads go through the real, native DOM `Selection` --
for the body, the one ProseMirror keeps in sync with its own document selection
(`view.updateState`'s own `selectionToDOM`); for the title page, the selection _is_ the position,
since the fields are plain `contentEditable`. No debug hook was added to the app for this, and
nothing is ever typed-then-undone; the resulting position is read directly. Each test also asserts
the widget's own bounding box genuinely contains the click point before the second click, so the
test cannot pass by coincidence of the widget missing the point entirely.

The body test's own click point is the real rendered rect of a collapsed `Range` at the very end of
a short block's text (`endOfBlockPoint`), not "anywhere past the end of the line" (a wider technique
this file's _other_ tests use to move a caret, which tolerates any x on the line because it only
needs the resulting position to be right). This test additionally needs the widget itself to land
within a few pixels of the point it clicks a second time, and the widget renders at the real
end-of-text column, not at the block element's own right edge -- a first version of this test used
the wider technique and its click-through assertion never converged, because the chosen pixel and
the widget's own position were never near each other at all. The title page's equivalent
(`endOfFieldPoint`) reads the identical kind of anchor, since title-page fields are
centred/right-aligned text with no fixed grid to click "past the end" of reliably.

## Proving hover survived

One Playwright test per surface, isolated from the typing-glow reveal (`data-remote-cursor-active`,
already covered by this file's other tests) by waiting the glow window out first, so the only thing
that can be revealing the label by the time each test hovers is a real `:hover` match. Checked via
`toHaveCSS('opacity', ...)` against `.remote-cursor-label`, not merely `toBeVisible()` (which would
pass at `opacity: 0` -- the label is never `display: none`).

## Both mutations, and what each caught

**Mutation 1 -- reintroduce `pointer-events: none` on `.remote-cursor-caret`** (`styles.css`,
applied by hand, run, reverted by hand -- never committed). Re-run against both hover tests: both
failed, and not with a mismatched assertion but with a hard 60-second timeout --
`Locator.hover()` could not even deliver the hover to an element the browser will not hit-test at
all. The click-through equivalence tests, run in the same pass, still passed under this mutation:
with the caret pointer-transparent, native hit-testing already resolves straight through to the
underlying text on both surfaces, coincidentally reproducing the right _position_ while destroying
hover -- confirming this is specifically a hover regression, not a click-through one, exactly as the
brief's own framing implied.

**Mutation 2 -- remove the click-forwarding handler on each surface**, run and reverted separately
per surface:

- Body: commented out `remoteCursorClickThroughPlugin()`'s registration in
  `createRemotePresenceExtension` (`presence.ts`). Re-ran `presence.test.ts`: the one test built to
  prove the real wiring ("a real mousedown dispatched at the remote cursor's own caret element
  forwards the click...") failed (`event.defaultPrevented` read `false`, selection never moved).
  Every other test, including the direct calls to `forwardRemoteCursorClick` itself, still passed --
  correctly, since those call the function directly rather than through the plugin.
- Title page: commented out `container.addEventListener('mousedown', handleMouseDown)` in
  `useTitlePagePresence` (`titlePageCursors.ts`). Re-ran `titlePageCursors.test.tsx`: the equivalent
  real-dispatch test failed identically, and the direct-call tests for
  `forwardTitlePageRemoteCursorClick` again correctly stayed green.

Each mutation was re-run against the suite meant to prove that specific property -- a different
suite going red would have proven nothing, per this repo's own standing caution about that exact
mistake.

## Must-not-regress properties, rechecked

- The caret's `content-box`/explicit-width CSS is untouched -- neither fix touches
  `.remote-cursor-caret`'s box model.
- The negative `margin-left` anchor compensation is untouched.
- The name label still appears on hover and briefly on typing, and still expires on its own (proven
  above, and by the pre-existing glow tests, unchanged and still green).
- `page-rendering-persistence.spec.ts` and `presence-persistence.spec.ts`'s own geometry
  measurements (`measurePage`, `measureCaretPaint`, `measureCaretPlacement`) all still pass --
  nothing about this fix touches layout.
- Remote cursors remain `aria-hidden` and `contentEditable="false"`; neither fix adds a `tabindex`
  or any other means of reaching them by keyboard.

## Nothing left unproven

Every property named in the brief has a real-browser or real-DOM-event proof behind it: click
equivalence (two-context, same-pixel, twice), hover survival (real `:hover`, isolated from the
glow), drag scope (reasoned from the confirmed `runCustomHandler`/`LeftMouseDown` mechanism -- not
independently re-tested with a live drag simulation, since the mechanism precludes it by
construction rather than by a race that could flake), and both mutations against the suites that are
supposed to catch them.

## Rebased onto slice 3, and re-verified there

This branch was cut from `8503d71` while collaboration slice 3 (offline and durable updates) was
still in review, and was rebased onto `d211af1` once that merged. The rebase was clean -- slice 3
touched the collaboration server, the database package and `App.tsx`, while this change touches the
two cursor modules, their tests and the two browser specs, so the two never overlap.

Every gate below was re-run on the rebased tree, not carried over from the pre-rebase run. The
combined unit counts confirm both changes are present together: `apps/web` 667, `packages/
screenplay-editor` 99, `apps/collab` 92, and `test:system:persistence` 30 (slice 3's 26 plus this
change's 4).

**One reported number did not reproduce.** The pre-rebase run recorded the lazy editor chunk at
152.02 kB. Measured on the rebased tree it is **144.12 kB**, against `main`'s own 143.66 -- a delta
of 0.46 kB, which is the size this change should be. The 152.02 figure could not be reconciled and
is recorded here rather than quietly replaced; what ships is the rebased tree, and it was measured
directly.

**An independent mutation of the click-forwarding was run by the lead**, distinct from the two
below: short-circuiting `forwardRemoteCursorClick` so that every real click falls through to the
widget again. Exactly one test failed -- the body click-through _equivalence_ test -- with the other
29 in the suite passing. That is the sensitivity that matters: the assertion fails for this defect
and for nothing else.

## Gates

Run from this worktree, in order, each checked and reported verbatim in the delivery message.

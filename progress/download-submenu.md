# The File menu's Download submenu

Branch `feature/download-submenu`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/download-submenu`, off `cdd43b5` (current `main`).

## Why this scope exists

The owner's ask, verbatim:

> "move the download options in the file dropdown to a sub dropdown. So it will say something like
> 'Download >' and if you hover over it you get the download options"

The File menu carried `Download FDX…`, `Download DOCX…`, `Download PDF…` as three flat, independent
items. They become one `Download` parent with a disclosure affordance, opening a submenu holding the
three on hover — with full keyboard operability, since a hover-only submenu would make three working
exports unreachable without a mouse, which is a regression from today's flat menu.

## What shipped

**`apps/web/src/components/OverflowMenu.tsx`** — one level of submenu, added as a new optional field,
`submenuItems`, on `OverflowMenuItem`. An item that sets it becomes a submenu parent: hovering it, or
pressing Enter/Space/ArrowRight while it has focus, opens a nested `role="menu"` holding its children
instead of calling `onSelect` (a submenu parent has none). Only one level deep is rendered — an item
inside `submenuItems` that itself sets `submenuItems` is treated as an ordinary leaf, matching the one
real caller.

**`apps/web/src/App.tsx`** — the three download items moved under one parent:

```
{
  label: 'Download',
  submenuItems: [
    { ariaLabel: 'Download FDX…', disabled: !projection.valid, disabledReason: exportDisabledReason, label: 'FDX…', onSelect: … },
    { ariaLabel: 'Download DOCX…', disabled: !projection.valid, disabledReason: exportDisabledReason, label: 'DOCX…', onSelect: … },
    { ariaLabel: 'Download PDF…', disabled: !projection.valid, disabledReason: exportDisabledReason, label: 'PDF…', onSelect: … },
  ],
}
```

No `disabled`/`disabledReason` set on the parent itself — see "Deriving the parent's disabled state"
below.

**`apps/web/src/routes/projects/$projectId.screenplays.$screenplayId.revisions.$revisionId.diff.tsx`**
— the read-only revision comparison's own copy of the File menu (a second, independent instantiation
of the same three items, all permanently `disabled: true`) got the identical grouping, so both File
menus stay structurally identical, which `screenplay-diff-persistence.spec.ts` asserts directly (see
below). This file was not named in the brief but carries the same three items under the same `Download`
label; leaving it flat would have made the two File menus diverge for no reason.

**`apps/web/src/styles.css`** — `.overflow-menu-submenu-group` (a positioning context per submenu-
parent row), `.overflow-menu-submenu-trigger` (flexes the label and disclosure glyph to opposite
ends), `.overflow-menu-disclosure`, and `.overflow-menu-submenu` (repositions the shared
`.overflow-menu-list` box to open rightward from its own row, the correct direction for a cascading
submenu on a menu that itself opens below-left of its trigger).

**Tests**: `apps/web/src/components/OverflowMenu.test.tsx` gained 18 tests (21 → 39) under a new
`describe('submenu', …)` block. `App.test.tsx`, `App.historicalRevision.test.tsx`, the diff route's
own test file, and `screenplay-diff-persistence.spec.ts` were updated for the new structure — see
"Test-file updates" below.

## Design decisions

### Hover-plus-keyboard, and the 200ms close delay

Hover opens the submenu, per the owner's own words. A zero-delay close would make it unusable with a
mouse: the cursor's path from the "Download" row to its flyout is diagonal, not along either box's own
edge, and crosses space that belongs to neither element along the way — closing the instant that gap is
crossed would drop the submenu before the mouse ever reaches it.

**200ms**, picked deliberately (comment at `SUBMENU_CLOSE_DELAY_MS` in `OverflowMenu.tsx`): comfortably
covers that diagonal at an ordinary, unhurried pointer speed, in the same range (roughly 150–300ms)
desktop menu implementations commonly use for the same reason, without the menu feeling sluggish to
dismiss when the writer genuinely moves away. The delay governs only the pointer's own path; it does
nothing while focus is inside the submenu except, if it does elapse, return focus to the submenu's
own trigger first rather than let it fall to `document.body` once the focused button is removed from
the document (`scheduleSubmenuClose`'s `submenuRef.current?.contains(document.activeElement)` check).

Every export stays reachable without a mouse:

| Key                                      | Effect                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| ArrowRight / Enter / Space on "Download" | Opens the submenu, moves focus to its first enabled item.              |
| ArrowLeft / Escape (inside the submenu)  | Closes the submenu, returns focus to "Download". File menu stays open. |
| ArrowUp / ArrowDown (inside the submenu) | Move within the submenu's own three items only.                        |
| Escape (focus still on a top-level row)  | Closes the whole File menu, returns focus to its trigger — unchanged.  |

### `focusableItems()` scoping — the trap in the brief

`focusableItems()`'s original query, `menuRef.current.querySelectorAll('[role="menuitem"]:not(:disabled)')`,
is not scoped to direct children. Once the submenu exists inside `menuRef` (which it does whenever it
is open, including via hover with focus still on a different top-level row), its own items match the
same selector and would be swept into the _parent_ menu's ArrowDown/ArrowUp order.

Fixed by filtering on the nearest `role="menu"` ancestor rather than on DOM depth:

```ts
return Array.from(candidates ?? []).filter((el) => el.closest('[role="menu"]') === menuRef.current);
```

A top-level item's closest `role="menu"` ancestor is `menuRef.current` itself; a submenu item's is the
nested submenu `div`, which is always closer. This survives however many wrapper elements sit between a
top-level item and `menuRef` (the submenu-parent row does need one, for CSS positioning — see
`.overflow-menu-submenu-group`), which a plain `:scope > …` direct-child selector would not have.

The existing `:not(:disabled)` clause — the one that fixed the "disabled first item makes the whole
menu keyboard-inert" defect recorded in this function's own doc comment — is untouched and still load-
bearing; this is an additional filter, not a replacement.

**The regression test** (`'never lands on a submenu item while arrowing through the parent menu, even
while the submenu is open'`): opens the File menu, opens "Download"'s submenu **by hover**, leaving
focus on a different top-level row (so the submenu exists in the DOM but was never entered), then
arrows through the parent menu and asserts the cycle is exactly `First → Download → Last → First` —
three stops. Reverting the `.closest` filter makes the second arrow land on "FDX…" instead of "Last"
(confirmed below, under "Mutation testing").

### Deriving the parent's disabled state from its children

Requirement: when every child is disabled, the parent is too, carrying the shared reason, so a writer
is never invited to open a submenu with nothing usable in it; when only some are disabled, the parent
stays enabled. This is computed in `OverflowMenu.tsx`, not passed in from `App.tsx`:

```ts
const allChildrenDisabled = children.length > 0 && children.every((child) => child.disabled);
const disabledReason = allChildrenDisabled
  ? children.find((child) => child.disabledReason)?.disabledReason
  : undefined;
```

`OverflowMenuItem.submenuItems`'s own doc comment states that a submenu-parent item's own
`disabled`/`disabledReason` fields are ignored outright — not merely redundant, ignored — specifically
so there is only ever one place this fact can be computed, rather than a second, independently-set flag
on the parent that the three children's own flags could drift out of sync with. `App.tsx`'s three
download items already share one `disabled: !projection.valid` expression and one `exportDisabledReason`
string; the parent item sets neither.

### Labels: short visible text, `aria-label` carrying the full sentence

Children render `FDX…`/`DOCX…`/`PDF…` — the parent already says "Download", and repeating it on every
child read as noise once they moved into its submenu. But a screen reader feature that jumps straight
to an item by name (a rotor, a "list all items" gesture) rather than arrow-navigating in — where
"Download"'s own context is still fresh — would announce a bare, ambiguous "FDX…". `ariaLabel` (a new
field on `OverflowMenuItem`, rendered as the button's `aria-label`) keeps the full `Download FDX…` as
the accessible name regardless of how the item was reached, at zero cost to the sighted label. This
also kept most of the existing test suite's `getByRole('menuitem', { name: 'Download FDX…' })` queries
unchanged in spirit — they still query by the same accessible name, just after a step that opens the
submenu first.

### ARIA

The parent carries `aria-haspopup="menu"` and an `aria-expanded` that reflects _its own_ submenu's open
state (not the outer File menu's). The submenu container is `role="menu"`; its children stay
`role="menuitem"`, matching the existing leaf-item contract exactly.

## The real bug this surfaced: hover-before-click silently drops a keyboard-style open

A mouse click is preceded by the browser's own hover (`mouseenter` fires before `mousedown`/`click` —
`@testing-library/user-event`'s `click()` reproduces this faithfully, and real browsers do it too).
The first implementation tracked "move focus into the submenu on open" with a plain `useRef<boolean>`
set just before `setOpenSubmenuLabel(label)`, in a `useEffect` keyed on `[openSubmenuLabel]`. That broke
under exactly this sequence:

1. Hover reaches "Download" first (as part of any real click): `openSubmenu(label, { focusFirstItem:
false })` sets the ref `false` and calls `setOpenSubmenuLabel('Download')`. State changes from
   `null`, the effect runs, sees the ref `false`, does nothing — correct so far.
2. The click itself then fires: `openSubmenu(label, { focusFirstItem: true })` sets the ref `true` and
   calls `setOpenSubmenuLabel('Download')` **again** — but the value is already `'Download'`. React
   does not re-render on a `setState` call with an unchanged value, so the effect never runs a second
   time, and the `true` the click just wrote to the ref is never read. **A writer who clicks "Download"
   with a mouse never gets focus moved into the submenu**, silently.

Found by running the new tests with `userEvent.click` rather than `fireEvent.click` (five tests failed
with focus landing back on "Download" instead of "FDX…") and confirmed with direct logging of the ref's
value at the moment the effect ran.

**Fix**: replace the ref with a counter, incremented unconditionally by every keyboard-driven open
regardless of whether `openSubmenuLabel`'s value actually changed:

```ts
const [submenuFocusRequestId, setSubmenuFocusRequestId] = useState(0);

function openSubmenu(submenuLabel: string, { focusFirstItem }: { focusFirstItem: boolean }) {
  cancelScheduledSubmenuClose();
  setOpenSubmenuLabel(submenuLabel);
  if (focusFirstItem) setSubmenuFocusRequestId((id) => id + 1);
}

useEffect(() => {
  if (submenuFocusRequestId === 0) return;
  focusableSubmenuItems()[0]?.focus();
}, [submenuFocusRequestId]);
```

A counter always changes, so the effect always re-runs. `openSubmenu` calls both setters inside the
same event handler, which React batches into a single render, so this still runs after the submenu's
own DOM exists — the two state updates commit together, and effects run after the commit that applies
both. The hover path never touches the counter, so hovering still previews without stealing focus,
which is the property the ref existed to preserve in the first place.

## Verifying the Safari dismissal path still holds for the submenu

The long comment above the dismissal effect in `OverflowMenu.tsx` records the real defect: an
`onBlur`-based close made every menu in the app inert in Safari, because WebKit does not focus a
`<button>` pressed with a mouse, and a blur-driven close saw `relatedTarget === null` and closed the
menu before the pressed item's `click` ever dispatched. The fix — capture-phase `pointerdown` and
`focusin` listeners on `document`, with an exclusion for focus landing on `document.body` — was already
in place and untouched by this change. What needed verifying, not assuming, is that it still treats a
press inside the submenu as "inside the menu": the submenu renders nested inside the existing
`containerRef` wrapper, not a portal, so `containerRef.current.contains(target)` should already be
`true` for anything inside it.

Two new tests confirm this rather than assuming it:

- `'activates a submenu item whose press moves no focus into it, the shape Safari dispatches'` — the
  exact hand-dispatched event sequence (`pointerdown`, `mousedown`, `focusout` with `relatedTarget:
null`, `focusin` on `document.body`, `pointerup`, `mouseup`, `click`, with the item never actually
  focused) the existing top-level test uses, now against a submenu child. Passes; `onSelect` is called
  and the whole menu closes.
- `'a pointerdown inside the open submenu does not dismiss the menu the way an outside press does'` — a
  bare `pointerdown` on a submenu item, asserting the menu (both `role="menu"` elements) is still
  present immediately after.

Both are mutation-killed by removing the `document.body` exclusion from `handleFocusIn` (see table
below) — confirming they exercise the real protection, not a coincidence of the test harness.

## Test-file updates

- **`App.test.tsx`**, **`App.historicalRevision.test.tsx`**: every `getByRole('menuitem', { name:
'Download FDX…' })` (etc.) site now opens the submenu first — `await
user.click(screen.getByRole('menuitem', { name: 'Download' }))` — before querying the child, since
  the children no longer exist in the DOM until the submenu is open.
- **`App.test.tsx`**'s `'disables the export menu items with a reason…'` test was rewritten to
  `'disables the Download submenu parent with a reason…'`: with every child disabled, the parent is
  disabled too, which makes the children themselves unreachable by click in this state (there is
  nothing to assert on them directly) — the new assertion is that `Download` itself is disabled with
  the shared reason, and that clicking it never reveals `FDX…`.
- **The diff route's test file** (`…revisions.$revisionId.diff.test.tsx`): the top-level menuitem
  enumeration (`textContent`, not accessible name) now reads `'Download ›'` once instead of the three
  `'Download FDX…'`/`'Download DOCX…'`/`'Download PDF…'` lines — `textContent` includes the parent's
  `aria-hidden` disclosure glyph, which the accessible name (and every `getByRole(..., { name })` query
  elsewhere) correctly excludes.
- **`screenplay-diff-persistence.spec.ts`**: the cross-frame parity assertion (editor vs. comparison
  File menu, same item names, only disabled state differs) updated the same way — one `'Download ›'`
  entry replaces the three `Download FDX…/DOCX…/PDF…` lines in the comparison's disabled-items list.
  This spec is excluded from `pnpm test:system` (`playwright.config.ts`'s `testIgnore`, because it
  creates real accounts against a real database) and runs only through `test:system:persistence`,
  which could not be run here — see "Gates not run" below. The edit is correct by inspection and by
  the same reasoning the component-level test (which _did_ run) already confirms, but is not itself
  verified executing.

## What was rejected

- **A wrapper `<div>` breaking direct-child scoping, "fixed" with a `:scope > …` selector.** Early
  draft used `:scope > [role="menuitem"]` on `menuRef`, which only works if every top-level item is a
  literal direct child — true for leaf items, but the submenu-parent row needs its own wrapper `<div>`
  (`.overflow-menu-submenu-group`) as a CSS positioning context for the flyout. `.closest('[role="menu"]')
=== menuRef.current` doesn't care how many wrapper elements sit in between, so the wrapper and the
  scoping fix stopped fighting each other.
- **Closing a sibling's submenu immediately on hovering a different top-level item.** Considered, to
  avoid a brief moment where "Download"'s submenu visually lingers while the pointer is already over
  "Share…". Rejected to keep exactly one code path governing when the submenu closes (the delay timer),
  rather than two that could disagree about timing; the delay already closes it shortly afterward
  regardless, and the File menu has only one submenu-parent item today, so the double-open this would
  prevent is not reachable in practice.
- **Pure CSS `:hover`-driven submenu (no React state for open/closed).** Would have kept the submenu's
  DOM permanently mounted (just hidden), which is exactly the shape of the `focusableItems()` scoping
  trap the brief warns about — and would have made the keyboard contract (ArrowRight/Enter opening it
  with focus, Escape/ArrowLeft closing it with focus returned) impossible to implement without a second,
  parallel state model fighting the CSS. Conditional rendering driven by one state value, with both
  hover and keyboard writing to it, is the simpler and the more correct shape.
- **Reading `openSubmenuLabel` in the submenu-focus effect's dependency array**, to satisfy
  `exhaustive-deps` by habit. Including it would re-run the focus-move on _every_ submenu open,
  including a hover-only one, reintroducing the "hover steals focus" defect the counter exists to
  avoid. Left out deliberately; the effect intentionally does not track everything it reads.

## Mutation testing

Every new guard was broken, confirmed to fail the test(s) that should catch it, then restored.

| #   | Mutation                                                                               | Result                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | `focusableItems()`'s `.closest('[role="menu"]') === menuRef.current` filter removed    | Killed — exactly `'never lands on a submenu item while arrowing through the parent menu…'`.                                                                                                                                    |
| M2  | `scheduleSubmenuClose` closes synchronously instead of after the delay                 | Killed 9 tests: the 3 delay-specific tests directly, plus 6 click-path tests whose `userEvent.click` sequence includes an incidental hover-leave — the exact "unusable with a mouse" failure mode the delay exists to prevent. |
| M3  | `allChildrenDisabled` forced to `false`                                                | Killed — `'derives the parent's disabled state from its children: disabled… only when every child is'`.                                                                                                                        |
| M3b | `children.every(…)` changed to `children.some(…)`                                      | Killed the other direction — `'leaves the parent enabled when only some children are disabled'` (M3 itself doesn't catch this direction; M3b does).                                                                            |
| M4  | `aria-label={child.ariaLabel}` removed from the submenu child button                   | Killed — `'uses ariaLabel as the submenu child's accessible name…'`.                                                                                                                                                           |
| M5  | Submenu's `Escape`/`ArrowLeft` branch disabled (`if (false) { closeSubmenu(…) }`)      | Killed both: the ArrowLeft and the Escape submenu-close tests.                                                                                                                                                                 |
| M6  | `openSubmenu` stops incrementing `submenuFocusRequestId` (the real bug, reintroduced)  | Killed 12 tests — every click- and keyboard-driven submenu-opening test.                                                                                                                                                       |
| M7  | `handlePointerDown` made to treat a press inside the submenu as outside (closes on it) | Killed 3 tests: the dedicated pointerdown-inside test and both submenu Safari-dispatch/selection tests, which also press inside the submenu.                                                                                   |
| M9  | Submenu child's `onClick` stops calling `setOpen(false)`                               | Killed — `'selecting a submenu item closes the whole menu (not only the submenu)…'`.                                                                                                                                           |
| M10 | `handleFocusIn`'s `document.body` exclusion removed                                    | Killed **both** the pre-existing top-level Safari test and the new submenu one — confirms the new test exercises the same real protection, not a coincidence.                                                                  |
| M11 | Parent's `aria-expanded` hardcoded to `false`                                          | Killed — `'carries aria-haspopup and an accurate aria-expanded on the parent…'`.                                                                                                                                               |

Not separately mutation-tested: the empty-`submenuItems`-array guard (`children.length > 0 && …`) has
no caller that reaches it (`App.tsx` always supplies exactly three children) and no dedicated test;
noted here rather than silently skipped.

## Gate results (all from the worktree, after `pnpm install`)

1. `pnpm build:packages` — clean, exit 0, every package.
2. `pnpm lint` — clean, exit 0 (`eslint . --max-warnings=0`).
3. `pnpm typecheck` — clean, exit 0, across every package, both apps, and `astro check` for
   `apps/landing` (0 errors / 0 warnings / 0 hints).
4. `pnpm test` — exit 0. `apps/web`: **954 tests**, 63 files, all passing (`OverflowMenu.test.tsx`
   39 tests, up from 21). `apps/api` 317 passed / 76 skipped (integration, no database). `apps/collab`
   169 passed / 32 skipped (same reason). `packages/pdf` 61 passed.
5. `pnpm test:system` (`PLAYWRIGHT_CHANNEL=chrome`) — **76 passed**, 0 failed. This run excludes
   `screenplay-diff-persistence.spec.ts` by `playwright.config.ts`'s own `testIgnore` (it needs a real
   database); see below.
6. `pnpm check:bundle-budget` — entry chunk **111.95 / 120 kB**, lazy editor chunk **145.33 / 200 kB**,
   CSS **7.82 / 20 kB**. All within budget with headroom.
7. `pnpm format:check` — run bare (not piped through `tail`), **exit 0**, after this file was written.

### Gates not run

- **`pnpm test:integration`** and **`pnpm test:system:persistence`** — both require a local
  PostgreSQL with `TEST_DATABASE_URL` set. Postgres is not running on this machine. Not attempted, and
  not reported as passing. `screenplay-diff-persistence.spec.ts`'s edit (see "Test-file updates" above)
  is therefore unverified by execution — it is correct by inspection and by the same reasoning the
  component-level diff test (which did run, and passed) already exercises, but that is not the same as
  having run it.

## Known limitations / things not done

- **No immediate close on hovering a sibling top-level item.** Rejected deliberately above; the File
  menu's one submenu-parent item makes this unreachable today, but a second one added later would show
  a brief overlap before the delay closes the first.
- **Only one level of submenu nesting is implemented.** `OverflowMenuItem.submenuItems`'s own doc
  comment states this; an item inside a submenu that itself sets `submenuItems` renders as a plain
  leaf. Not a limitation for the one real caller.
- ~~Visual position of the flyout is asserted nowhere.~~ **This limitation was real and the flyout
  was in fact broken because of it. Both are now fixed -- see "The positioning defect" below.**
- **`screenplay-diff-persistence.spec.ts`'s edit is unexecuted**, for the Postgres reason above.

## The positioning defect, found by the owner after the first round

The owner's report: _"it opens on top of the parent menu. It needs to be to the side."_ Correct, and
the cause was a cascade loss rather than a wrong value.

The flyout element carries **both** `.overflow-menu-list` (for its box styling) and
`.overflow-menu-submenu` (for its position). That means every `<ancestor> .overflow-menu-list` rule
in the stylesheet also matches it -- including `.menu-file .overflow-menu-list { right: auto; left: 0 }`
at specificity 0-2-0. `.overflow-menu-submenu` was a single class, 0-1-0. So inside the File menu --
the only place a submenu is actually used -- `left: 0` beat `left: 100%`, and the flyout rendered
directly over the menu that opened it.

`left: 100%` was present and correct the entire time. Nothing about the declaration was wrong; it
was simply being overridden, which is why reading the rule in isolation looks fine.

**The fix** raises the selector to `.overflow-menu-submenu-group .overflow-menu-list.overflow-menu-submenu`
(0-3-0), above any single-ancestor `.overflow-menu-list` rule. Deliberately _not_ solved by moving
the rule later in the file: equal specificity decided by source order would break again the moment
someone adds another `<ancestor> .overflow-menu-list` rule below it.

**Why no existing test caught it, and what now does.** The "limitation" struck out above was the
whole problem. jsdom performs no layout -- every `getBoundingClientRect()` is zero -- so a flyout
sitting exactly on top of its parent satisfied all 39 of `OverflowMenu.test.tsx`'s assertions. DOM
structure, ARIA, focus and keyboard behaviour were all genuinely correct; only the geometry was
wrong, and geometry was the one thing nothing measured.

`apps/web/e2e/submenu-position.spec.ts` now measures it in real Chromium, following
`text-contrast.spec.ts`'s harness (load a page so the real stylesheet applies, inject the exact
markup the component renders, measure). It asserts a _relationship_ between two boxes -- the
flyout's left edge at or beyond the parent's right edge, and its top tracking the trigger row --
rather than a pixel offset or a computed `left` string. A test pinning `left: 100%` would have
passed in the broken state, since that declaration was there and losing.

The spec was written **before** the fix and confirmed failing against the defect
(`Expected: >= 160, Received: 5` -- the flyout's left edge sitting at the parent menu's left edge).
Reverting the selector to its single-class form reproduces exactly that failure.

`test:system` is now **77 passing**, up from 76.

**One honest note on the fix.** `right: auto` in that rule is redundant today: every submenu renders
inside `ApplicationMenubar`'s `.menu-file` wrapper, which already sets it, and mutating it away
leaves the new spec green. It is kept for the base `.overflow-menu-list { right: 0 }` case, where a
submenu in any other menu would resolve both `left` and `right` and stretch across the gap instead
of sizing to its content. That reasoning is now stated in the stylesheet itself rather than implied,
so the next reader does not take it for load-bearing.

**Lesson worth keeping:** a component whose correctness is partly geometric cannot be fully tested
in jsdom, and naming that gap in a limitations list is not the same as covering it. The gap was
documented accurately and shipped broken anyway.

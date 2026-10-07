# Shared application chrome

Split out of the screenplay-diff branch at the owner's request, so the editor-side refactor can be
reviewed and reverted independently of the comparison feature that motivated it. This branch contains
**no diff code at all**: no diff engine, no comparison route, no diff styling. It is a pure
refactor of the editor's own chrome plus one defect fix.

## What moved out of `App.tsx`

| Module                   | Renders                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `applicationShell.tsx`   | `<main className="application">` and its rows, from slots                                                 |
| `applicationMenubar.tsx` | File menu, the inert labels, the canvas toggle                                                            |
| `applicationToolbar.tsx` | The whole toolbar, plus `ToolButton`                                                                      |
| `navigatorPanel.tsx`     | Navigator frame, WAI-ARIA tabs, entry list, footer                                                        |
| `inspectorPanel.tsx`     | Inspector frame: heading, close, section rhythm                                                           |
| `zoomPresets.ts`         | Range, step, presets, `clampZoomPercent` (`zoom.ts` re-exports every name, so no existing import changed) |

Each takes data and callbacks as props and holds no editing behaviour, no `Y.Doc` and no ProseMirror.
The editor passes live state and real handlers. A second consumer -- the revision comparison, on its
own branch -- passes read-only data and disabled states, which is the point: one set of components
rather than two lookalikes that drift.

## `.application` stopped using grid auto-placement

Each chrome element now names its own area against a six-row `grid-template-areas`, and each optional
row's height is a custom property (`--fd-shell-menubar-row` and friends) that a `.shell-without-*`
modifier collapses to `0px`. Auto-placement could not express a _missing_ row at all.

**The rendered geometry is unchanged by construction**, not merely by assertion:

|                     | row track list                                                                       |
| ------------------- | ------------------------------------------------------------------------------------ |
| before, no banner   | `38px 31px 47px minmax(0, 1fr) 30px`                                                 |
| before, with banner | `38px 31px auto 47px minmax(0, 1fr) 30px`                                            |
| after               | `38px 31px 0px 47px minmax(0, 1fr) 30px`, banner `auto` under `.has-readonly-banner` |

A `0px` track contributes no height and no gap, so this resolves to the same list as before: the four
fixed heights still sum to 146 and the workspace `1fr` still resolves to 574 at 1280x720.

Two side benefits. The cascade failure `styles.css`'s own comment records -- an extra grid child
pushing the toolbar into the workspace row, the workspace into the status bar's, and the status bar off
the end of the track list -- is now structurally unreachable, because every chrome element names its
area. And the `max-width: 600px` block no longer restates the whole track list, removing the drift risk
that block's comment flagged.

## A real defect fixed on the way

`OverflowMenu` focused the first `[role="menuitem"]` on open and arrow-navigated the full list. A
disabled `<button>` cannot take focus, so a menu whose _first_ item is disabled swallowed the opening
focus move, left `indexOf(document.activeElement)` at `-1`, and left Escape unhandled (its handler is
on the list) -- keyboard-inert while looking open. **The editor has had this latent all along** for a
read-only screenplay, where `editingAllowed` disables that same first item. Fixed by focusing and
navigating `:not(:disabled)` items and handling Escape on the trigger too.

Mutation-tested: reverting the selector fails exactly two tests -- "moves opening focus past a disabled
first item, to the first one that can take it" and "skips disabled items when the arrow keys move
between them" -- and nothing else.

## The editor is unchanged

- **Behaviour:** `apps/web/src/App.test.tsx` is **byte-identical to `main`** (`git diff --stat` reports
  nothing). Its coverage of toolbar tooltips, the element selector, every zoom interaction, Navigator
  tabs and derived lists, and the Inspector's active element was not touched. Web tests went to 759
  entirely through new files.
- **Layout:** `page-rendering-persistence.spec.ts` gained a shell-geometry measurement (additive --
  nothing in that file was edited): six declared rows resolving to 38 / 31 / 0 / 47 / `1fr` / 30, each
  element at its declared row's height, rows tiling the viewport with the status bar's bottom as the
  fold, the document never scrolling, and the in-flow children of `.application` being exactly the five
  chrome rows. Deep-equal to itself at 100% and 50%. The manuscript character-grid assertions that file
  already made are unchanged and still pass.

Mutation-tested: changing `--fd-shell-titlebar-row` from `38px` to `40px` fails exactly one test, with
`Expected: 38 / Received: 40`.

## Gates

`pnpm lint` 0, `format:check` 0, `typecheck` 0, `pnpm test` 0 (web 759), `test:coverage` 0,
`check:bundle-budget` 0, `test:integration` 0 (5 + 44 + 23), `test:system:persistence` 31/31,
`test:system` 40/40.

**One bundle note.** The lazy editor chunk is 145.74 kB here against a 200 kB budget. On the combined
branch, where the comparison route also consumes these components, Rollup splits them into a shared
chunk and the editor chunk falls to 143.99 kB. With one consumer there is nothing to share with, so
they stay inlined. Both figures are well inside budget; the number moves down, not up, once the second
consumer lands.

## Not proven

Every claim here is resolved computed style, resolved grid tracks and real geometry from Chrome, plus
the unit suites. Nothing was checked visually on this branch -- it changes no appearance by design, and
the measurements are what establish that.

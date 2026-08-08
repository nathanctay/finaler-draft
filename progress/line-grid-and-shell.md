# Scope: line-grid-and-shell

Branch: `fix/line-grid-and-shell`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/line-grid-and-shell`
Base: `main` @ `e95dcdf`
Owner: Sonnet implementation agent, advised by the lead.

## Why this scope exists

Two defects the owner found while using the editor after `fix/page-viewport-geometry` landed.

**1. Inter-element spacing is off the line grid.** `.script-body [data-screenplay-block]` applies a uniform `margin-bottom: 13px` plus `padding-top: 12px` between every block — 25 px, or 1.5625 lines at 16 px — regardless of which two elements meet. The specification requires whole lines, and requires **zero** blank lines inside a speech.

Measured cost on the page budget:

```
a three-line speech (character / parenthetical / dialogue)
  now:      3 lines + 2 gaps x 1.5625 = 6.12 line-equivalents
  correct:  3 lines + 0 gaps          = 3.00 lines
```

A speech occupies twice the vertical space it should. Since every blank line consumes one of the 54 to 55 lines on a page, this directly falsifies page count.

**2. The application shell scrolls instead of the editor.** `.application` uses `min-height: 100vh`, which lets the grid grow past the viewport. Measured at an 800 px viewport: the shell computes to 1290 px, the status bar's bottom edge lands at 1290 px — 490 px below the fold — and the editor region is not scrolling at all, its `scrollHeight` equal to its `clientHeight` at 1144 px. The owner did not know the status bar existed until scrolling into it by accident.

## The element-name labels: decided

`.script-body [data-screenplay-block]::before` renders the element name in 8 px sans-serif, and the
`padding-top: 12px` exists solely to stop it overlapping the text. That padding is what pushes
spacing off the grid.

The owner's decision: **labels are hidden by default, behind a view toggle.**

**The toggle must not change layout in either state.** A label that reserves space — 9 px, 12 px, any
value that is not a whole line — moves every element off the six-per-inch grid and changes where
pages break, so the same screenplay would report different page counts depending on an editor
setting. Render the label as an overlay instead: absolutely positioned, `pointer-events: none`, zero
layout space, offset roughly 9 px from the block per the owner's preference for a tighter look. That
offset is a visual position, not padding.

`padding-top` on the block drops to zero and never comes back.

The toggle is **view state, not document state.** It is an editing affordance, so it belongs in local
UI state — never in document settings and never in the canonical screenplay, which travels between
users and machines. Place it in the toolbar beside the existing Navigator and Inspector toggles, so
it sits with the other view controls and inherits their accessible pattern. Default off.

Prove the invariance: the measurement test must assert that element positions on the line grid are
**identical with labels on and off**. If that assertion cannot be written, the implementation is
wrong.

## Acceptance criteria

### 1. Vertical spacing is whole lines on the six-per-inch grid

Implement the "Vertical spacing between elements" table in `plan.md`: one blank line before scene heading, action, character, transition and shot; **zero** before parenthetical and dialogue.

- Express spacing in the shared geometry module as **line counts**, not pixels, alongside the existing constants. One blank line renders as exactly one line box; zero renders as zero.
- A speech is contiguous in every combination: character to dialogue, character to parenthetical, parenthetical to dialogue, and dialogue to a mid-speech parenthetical.
- No pixel value may appear in any spacing rule. Derive from the line height already exposed as a custom property.

### 2. Prove the grid holds, by measurement

Extend `apps/web/e2e/page-geometry.spec.ts`, reusing its existing `requireCourierPrime` guard:

- A character block followed by a dialogue block occupies exactly two consecutive line boxes with no gap.
- Character, parenthetical, and dialogue together occupy exactly three.
- An action block following a dialogue block is separated by exactly one blank line.
- Every element's top edge falls on a six-per-inch boundary relative to the first line of the body.

State the tolerance and why. Measure in real Chrome, as the existing specs do.

### 3. The shell is fixed to the viewport

- `.application` occupies exactly the viewport height so `minmax(0, 1fr)` constrains the editor row rather than expanding to fit the page. Prefer `100dvh` over `100vh` so mobile browser chrome does not clip the status bar.
- Title bar, menu bar, toolbar, and status bar remain visible at all times.
- The editor region is the only thing that scrolls with the page.
- Navigator and Inspector scroll their own content independently when it overflows, and keep their existing overlay behaviour at narrow widths.
- `document.documentElement.scrollHeight` must equal the viewport height with a screenplay open: the application itself never scrolls.

### 4. Zoom moves to the toolbar

Move the zoom controls out of the status bar and into the toolbar, beside the other controls that act on the document view.

Preserve exactly: the zoom range, the accessible labels already present, keyboard operability, and the `output` element reporting the current level. This is a relocation, not a redesign.

### 5. Icon-only controls get tooltips

Every icon-only control shows a tooltip on hover. Today they carry an `aria-label`, so assistive
technology announces them, but a sighted user hovering a glyph gets nothing — the owner specifically
raised the Navigator and Inspector toggles.

Cover all of them, not only the two named:

- The four `ToolButton` instances: undo, redo, Navigator, Inspector — plus the new element-label toggle.
- The panel close buttons, currently `aria-label="Close navigator"` and `"Close inspector"`.
- The zoom controls once relocated, currently `aria-label="Zoom out"` and `"Zoom in"`.

**One string per control, used for both the accessible name and the tooltip.** `ToolButton` already
takes a `label` prop and applies it as `aria-label`; add `title` from that same prop rather than
introducing a second literal that can drift out of sync. Do the same for the controls that do not use
`ToolButton`.

A native `title` is the right starting point: no dependency, no new component, and consistent with
not adopting a component-library look. Its limitations are real and should be recorded rather than
hidden — roughly a one-second delay, no styling control, and **it does not appear on keyboard focus**,
so a sighted keyboard user still gets no visual hint. Assistive technology is unaffected because the
accessible name already exists. If a styled tooltip that also responds to focus is wanted later, that
is its own slice; do not build one here.

### 6. The status bar keeps its remaining content and stays visible

Active scene, word count, and **save state** remain. Save state is the writer's only signal that work is persisted and must never sit below the fold.

## Out of scope

Do not implement: pagination or page breaks; `(MORE)` and `CONT'D`; the document settings dialog; the title page; scene numbers; Navigator character-extension stripping; the layout package. All of that is the next slice.

Also out: `.script-title` and `.script-meta`, which still render inside `.page` and are still flagged for a later decision — leave them; `packages/config` split; Zod unification; rate limiting; Resend; Stripe; anything under `apps/api`.

Do not introduce raw colour literals. Reuse the existing tokens.

## Checkpoints — report to `main`

1. After the spacing constants and CSS are in place, with the measured line-box positions, **before** the shell work. Wait for a reply.
2. When verification is complete.

The previous slice skipped its middle checkpoint and both defects the lead subsequently found were in exactly that layer. Observe this one.

## Verification required before handoff

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck` — clean tree, no prior build
4. `pnpm test:coverage`
5. `pnpm build`
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`
7. `TEST_DATABASE_URL=<ask the lead> PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence`
8. `git diff --check`

**Kill any server on port 4173 before running the system gate.** `playwright.config.ts` sets `reuseExistingServer` outside CI, so a stale server silently serves an old build and a green run can be meaningless. This cost the lead a verification cycle on the previous slice.

## Rules

- Do not stage, commit, merge, rebase, force-push, reset, or create/delete worktrees. The user controls all Git write operations. This includes `git reset`: if you find files unexpectedly staged, report it and leave them alone.
- Do not read, print, or commit `.env` files or any credential.
- No TODO, FIXME, or placeholder comments. No emojis.
- If anything contradicts the specification, stop and report rather than adjusting the specification.
- If a command hangs for more than a few minutes, stop and report rather than polling.

## Log

### 2026-08-08 — lead — scope drafted

Status: ready-for-implementation
Specification committed on `main` at `e95dcdf`; this worktree contains it.

### 2026-08-08 — implementation agent — both defects fixed, checkpoints observed

Status: ready-for-review

**Part 1 — vertical spacing on the six-per-inch grid (checkpoint 1, approved).**

- `packages/screenplay/src/pageFormat.ts`: added `BLANK_LINES_BEFORE`, a whole-line-count record per
  `ScreenplayElementKind` (scene_heading 1, action 1, character 1, dialogue 0, parenthetical 0,
  transition 1, shot 1). No pixel value anywhere in it.
- `apps/web/src/pageGeometryCss.ts`: generates one `--fd-blank-lines-before-<element>` CSS custom
  property per entry, following the file's existing routing convention (pageFormat.ts is the only
  place that reads the number; CSS only ever consumes `var()`).
- `apps/web/src/styles.css`: `margin-bottom: 13px; padding-top: 12px` replaced with a single
  `margin-top: calc(var(--fd-blank-lines-before) * var(--fd-type-size) * var(--fd-line-height))`,
  set per element via attribute selectors. `padding-top: 0` permanently. `margin-top` only, never
  `margin-bottom`, so there is nothing for adjacent siblings to collapse against.
- The element-name label `::before` is now a true overlay: `position: absolute`,
  `pointer-events: none`, `top: -9px`, zero layout space in both states of a new
  `.show-element-labels` class on `.script-body`. Proven identical by a dedicated e2e test
  (below), not just asserted.
- **`:first-child` forced to `margin-top: 0`, regardless of element type.** Flagged to the lead at
  checkpoint 1 and confirmed correct, but recording the known limitation the lead asked for: the
  actual rule is not "the first element of the document," it is "the first element on each page."
  With a single continuous editor view and no real pagination yet, `:first-child` is an exact
  approximation. It will become silently wrong the moment the pagination slice introduces real
  page boundaries — the first element after every page break would inherit a leading blank line it
  shouldn't have, shifting content down one line per page and drifting the page count as the
  script grows. **The pagination slice must replace this selector with per-page suppression, not
  extend it.** The lead is recording the underlying rule in plan.md's page-break section as
  specification; this worktree is pinned at `e95dcdf` and doesn't see that update, but the
  consequence is captured here for whoever picks up pagination next.
- Measured in real Chrome (`PLAYWRIGHT_CHANNEL=chrome`), a 10-block mixed sequence, offset from the
  page content box in px: scene_heading 96, action 128, character 160, parenthetical 176, dialogue
  192, character 224, dialogue 240, transition 272, scene_heading 304, shot 336. Every value an
  exact multiple of 16px (0px fractional remainder). The character/parenthetical/dialogue speech
  spans 160 to 208 = 48px = exactly 3 line-equivalents (was 6.12 before this change).

**Part 2 — the shell, zoom, tooltips, and the label toggle.**

- `apps/web/src/styles.css`: `.application` changed from `min-height: 100vh` to `height: 100dvh`
  (fixed, not a floor; `dvh` over `vh` so mobile browser chrome doesn't clip the status bar).
  `.panel` gained `overflow-y: auto` so Navigator and Inspector scroll their own content
  independently. The narrow-width panel-overlay `height: calc(100vh - 141px)` updated to `100dvh`
  for the same reason. `.zoom-controls` resized from a 22px status-bar control to a 31px toolbar
  control (matching `.tool-button`/`.element-selector`) and moved to sit with the other toolbar
  rules.
- `apps/web/src/App.tsx`: zoom controls relocated from the status bar into the toolbar, unchanged
  range (70-150%), unchanged `aria-label`s ("Zoom out"/"Zoom in"/"Zoom level"), unchanged `<output>`
  element — a relocation, not a redesign. Added a `showLabels` state (view state, default off,
  never touches document state) driving a new "Toggle element labels" `ToolButton` beside
  Navigator/Inspector, which toggles `.show-element-labels` on `.script-body`. `ToolButton` now
  renders `title={label}` alongside `aria-label={label}` — one string, both purposes. The two panel
  close buttons and the two zoom buttons (not `ToolButton` instances) got the same `title` treatment
  by hand. Status bar keeps active scene, word count, and save state; only the zoom controls were
  removed from it (relocated, not deleted).

**New tests.**

- `apps/web/e2e/app-shell.spec.ts` (new): 4 tests at a pinned 1280x800 viewport (matching the bug
  report's own numbers) proving `.application` height equals the viewport, the document itself
  never scrolls, the editor region is the one thing that does (`scrollHeight > clientHeight`,
  inverse of the old defect where they were equal), all four chrome regions stay within the
  viewport when editor content overflows, and Navigator/Inspector scroll independently.
  - **Fixture pitfall worth recording**: my first draft simulated overflowing panel content with a
    single `<div>` given an inline `height: 3000px`. Chrome's flexbox algorithm shrank it to fit
    the available space instead of overflowing (`clientHeight === scrollHeight === 654`, both
    exactly the container's stretched height). Root cause: `.panel` is a column flex container, so
    that div is a flex item on the main axis, and a flex item's automatic minimum size is its
    _content-based_ minimum, not its specified height, unless overflow is non-visible on the item
    itself — for a near-empty div, that content-based minimum is close to zero, so the shrink
    algorithm was free to compress it all the way down. This is a fixture artifact, not a defect in
    the shipped CSS or `App.tsx`: I confirmed against realistic markup (150 real `<li>` rows,
    matching the actual Navigator's structure) that genuine stacked content does not collapse this
    way — a block box's min-content size in the block (height) axis is its natural content height,
    not a compressible minimum the way width can wrap to shrink. Fixed the fixture with
    `flex-shrink: 0` on the synthetic content div rather than changing the component to satisfy a
    broken test. Recording this so a future reader who hits the same "impossible" equal
    clientHeight/scrollHeight in a synthetic flex-column fixture finds the explanation instead of
    re-deriving it or, worse, patching the real component to chase a phantom.
- `apps/web/src/App.test.tsx`: 3 new tests — label toggle flips the class and `aria-pressed` without
  touching document state; every icon-only control's `title` matches its accessible name; zoom now
  lives in the toolbar and clamps at the same 70/150 bounds as before the move.
- `packages/screenplay/src/pageFormat.test.ts`: `BLANK_LINES_BEFORE` table and the
  contiguous-speech invariant (character 1, parenthetical/dialogue 0 unconditionally).
- `apps/web/src/pageGeometryCss.test.ts`: the 7 new `--fd-blank-lines-before-*` variables.
- `apps/web/e2e/page-geometry.spec.ts`: 5 new tests — character/dialogue and
  character/parenthetical/dialogue contiguity, the one-blank-line gap before action, the
  six-per-inch-boundary check across a 10-block sequence, and the labels-on/labels-off invariance
  proof required by the brief.

**Verification, all green, port 4173 (and 4174 for the persistence run) killed before each system
run:**

1. `pnpm format:check` — clean
2. `pnpm lint` — clean, `--max-warnings=0`
3. `pnpm typecheck` — clean tree
4. `pnpm test:coverage` — all packages pass their 80% gates; `apps/web` 96.47% stmts / 91.25%
   branch / 96.94% funcs / 96.47% lines; exit 0
5. `pnpm build` — clean
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` — 16/16 passed
7. `TEST_DATABASE_URL=<supplied by the lead> PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence`
   — 2/2 passed (`session-routing.spec.ts`, `persistence.spec.ts`)
8. `git diff --check` — clean, no whitespace errors

**Noticed but left out of scope**: the `:first-child` limitation above (belongs to the pagination
slice); the mobile toolbar's `.tool-button:nth-of-type(n+7)` overflow rule still only counts direct
`<button>` children of `.toolbar` (the new label-toggle button brings the total to 5, still under
7, so behaviour is unchanged, but a future toolbar addition should re-check this); `.script-title`
and `.script-meta` untouched, per the brief. A file named `apps/web/e2e/zz-lead-shell-audit.spec.ts`
appeared in the worktree during the lead's independent review; left untouched as it isn't part of
this slice's deliverable.

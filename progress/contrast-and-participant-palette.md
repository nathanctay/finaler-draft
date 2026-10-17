# Text contrast, and the collaborator palette

Branch `fix/contrast-and-participant-palette`, worktree
`/Users/nathan/Documents/finaler-draft-worktrees/a11y`, off `e089872` (current `main`).

## Why this scope exists

An accessibility pass over the shipped stylesheet found every rule that draws muted or inactive text
below WCAG 1.4.3's 4.5:1, and the eight-colour collaborator palette failing three separate
properties at once. The owner's priority, in his words:

> "Contrast is more important than color blind stuff because a lot of color blind people have
> filters on their screens to help avoid that, but we can take care of the blue and violet issue you
> mentioned, and any other glaring ones."

So: contrast first, then the palette's colour-vision collapse, then the two things the first audit
could not settle (the dark theme, and any text painted over the participant colours or the diff
marks).

Every number below is measured, not estimated. The "before" column is the shipped stylesheet and the
shipped palette; the "after" column is read back out of a **real browser** for the CSS cases
(`apps/web/e2e/text-contrast.spec.ts`) and computed from the palette's own values for the colour
cases (`apps/collab/src/participantPalette.test.ts`).

## Part 1: the muted and inactive greys

### What was wrong

Two shared tokens carried every failing rule: `--text-04` (`#a3adb2`) and `--text-07` (`#78848a`).

| rule                                  | surface                  | before    | floor | after    |
| ------------------------------------- | ------------------------ | --------- | ----- | -------- |
| `.ruler` (10px)                       | `--surface-07` `#e8ebec` | **3.21**  | 4.5   | **4.75** |
| `.muted` (11px), white dialog         | `#fff`                   | **3.84**  | 4.5   | **5.69** |
| `.muted`, Inspector / panels          | `--surface-03` `#f7f8f8` | **3.61**  | 4.5   | **5.35** |
| `.muted`, project & revision screens  | `--surface-09` `#e7e8e3` | **3.12**¹ | 4.5   | **4.62** |
| `.scene-list small` (13px)            | `--surface-03`           | **3.61**  | 4.5   | **5.35** |
| `.navigator-empty` (11px)             | `--surface-03`           | **3.61**  | 4.5   | **5.35** |
| `.toast-message` (12px)               | `--surface-01` `#fff`    | **3.84**  | 4.5   | **5.69** |
| `.title-page-line-remove` (12px)      | white title page         | **3.84**  | 4.5   | **5.69** |
| empty-block placeholder hint          | white page               | **2.29**  | 4.5   | **5.69** |
| title-page placeholder hint           | white title page         | **2.29**  | 4.5   | **5.69** |
| `.smarttype-ghost`                    | white page               | **2.29**  | 4.5   | **5.69** |
| `.element-menu-key`, unselected row   | `--surface-01` `#fff`    | **2.29**² | 4.5   | **5.69** |
| `.element-menu-key`, selected row     | `--surface-05` `#edf0e9` | **1.99**  | 4.5   | **4.95** |
| `.primary-button:disabled`            | `--surface-11` `#d8dde0` | **1.67**  | 3     | **3.10** |
| `.tool-button:disabled`               | `--surface-03`           | **2.15**  | 3     | **3.99** |
| `.text-button:disabled`               | `--surface-09`           | **1.86**  | 3     | **3.45** |
| `.overflow-menu-list button:disabled` | `--surface-01` `#fff`    | **2.29**² | 3     | **4.25** |

¹ The audit's two `.muted` rows were white (3.84) and app chrome (3.61). Its darkest light surface
is neither: `--surface-09` `#e7e8e3`, the `.project-screen` background behind the Deleted and
revision-history pages, where it measured **3.12** — the worst `.muted` case, and the one the new
value is held to.

² The audit listed these two at 2.15 against chrome. Both panels declare `--surface-01` (white) and
have no `.dark` variant, so the real figure is 2.29. Again, both failed either way.

### What was changed, and why each

**Both tokens were retuned rather than overridden per rule.** Seventeen rules were failing across two
tokens; seventeen overrides would be seventeen places for the next person to miss one. What made a
token nudge safe was first separating the two tokens _by the floor they answer to_ rather than by how
faint they look:

- **`--text-04` is now the inactive-control token.** Four rules: `.tool-button:disabled`,
  `.text-button:disabled`, `.primary-button:disabled`, `.overflow-menu-list button:disabled`.
  `#a3adb2` → **`#6f7d84`**, which is the darkest-surface case (`--surface-11`, the disabled primary
  button) at exactly 3.10:1 and white at 4.25:1.
- **`--text-07` is now the muted-real-text token.** `#78848a` → **`#5f686d`**, holding 4.5:1 against
  every light surface any of its rules sits on, the binding one being `--surface-09` at 4.62:1.

**Four rules moved from `--text-04` to `--text-07`.** The two `:empty::after` placeholder hints, the
SmartType ghost completion, and `.element-menu-key`. They were on the inactive-control token at
2.29:1 while being, in every case, text a reader has to read — `.element-menu-key`'s own comment in
the stylesheet already said so ("It is real text, not a decoration — a screen reader reads it as part
of the row's name"). This is the one judgement that darkens something previously faint on purpose:

- The **SmartType ghost** was not on the audit's list, but it is the same token on the same surface
  as the placeholder hints that were, so it measured the same 2.29:1. It was left faint deliberately
  (its rule calls it "a preview of text that does not exist yet"), and the argument for raising it
  anyway is that you cannot decide whether to accept a completion you cannot read. It is still
  obviously not manuscript text: 5.69:1 against the page, where real manuscript text is 14.7:1.
- Nothing else deliberately faint was touched. `--text-03`/`--text-05`/`--text-06` are unchanged.

**The cost, stated plainly:** `--text-04` and `--text-07` used to sit 17 lightness points apart and
now sit 6. The muted/faint distinction in the scale is much weaker than it was. They are kept as two
tokens because they answer to different floors (3:1 vs 4.5:1) and collapsing them would darken every
disabled control to the stricter of the two for no reason. The scale's ordering is preserved — 04 is
still lighter than 07.

### The dark theme: the same failure, unlisted

Neither token was redefined under `.dark`, so the greys `:root` chose for a near-white chrome were
being painted on `#29343d`-`#34424b` panels. Measured:

| rule (dark theme)          | surface                       | before         | floor | after    |
| -------------------------- | ----------------------------- | -------------- | ----- | -------- |
| `.muted`, Inspector        | `--surface-03` dark `#34424b` | **2.70**       | 4.5   | **4.65** |
| `.scene-list small`        | `#34424b`                     | **2.70**       | 4.5   | **4.65** |
| `.navigator-empty`         | `#34424b`                     | **2.70**       | 4.5   | **4.65** |
| `.ruler`                   | `--surface-07` dark `#2d3941` | **3.08**       | 4.5   | **5.32** |
| `.primary-button:disabled` | `--surface-11` dark `#1f282f` | 6.54 ok        | 3     | **6.54** |
| `.tool-button:disabled`    | `#34424b`                     | *not painted*³ | 3     | **4.53** |

³ See "the fourth finding" below.

`--text-04` was, it turns out, always correct in the dark theme — 4.53:1 on the lightest dark panel.
Its only fault was being used on white as well. So `.dark` restores `--text-04: #a3adb2`, the exact
value it held before this pass, and sets `--text-07: #a7afb3` to reach 4.5:1 as real text.

Darkening the light-theme values makes the dark theme strictly worse, and no single value fixes both:
4.5:1 against white needs relative luminance ≤ 0.183, and 4.5:1 against `#34424b` needs ≥ 0.330.
There is no overlap. A `.dark` redefinition is forced, not chosen.

**The complication, and how it is handled.** `.dark` goes on the editor shell
(`applicationShell.tsx`), and several surfaces _inside_ that shell stay white in both themes: the
manuscript page, the title page, dialogs, toasts, the File menu's dropdown, and the element menu.
A plain `.dark { --text-07: #a7afb3 }` would put a light grey on those white panels.

So the always-white containers re-assert `:root`'s values:

```css
.page,
.title-page,
.dialog,
.toast,
.element-menu,
.overflow-menu-list {
  --text-07: var(--text-07-on-white);
}
.element-menu,
.overflow-menu-list {
  --text-04: var(--text-04-on-white);
}
```

This is the technique and the reason `--fd-diff-added-surface` already exists for in this stylesheet
(its own comment: declared on `:root` "precisely so that `.dark`'s redefinition of `--surface-10`
does not follow it onto a page that stays white"). Two new tokens, `--text-04-on-white` and
`--text-07-on-white`, exist only so the literal is written once.

Containers, not rules, deliberately. `.muted` alone appears in the dark Inspector, on the
comparison's dark canvas, on three light screens, and inside a white dialog; enumerating callsites
would leave the next `.muted` silently wrong, while "this element's background is white, so muted
text on it reads against white" cannot drift.

`--text-04` is re-anchored on only the two floating menus, not on `.dialog`. The only `--text-04`
rule a dialog contains is `.primary-button:disabled`, whose _background_ is `--surface-11`, which
`.dark` does redefine — so inside a dark shell that button is dark and its text must follow the
theme, not the dialog.

### The disabled controls

WCAG 1.4.3 exempts inactive controls outright, so none of the four disabled rows was a standards
failure. They were raised anyway, to a 3:1 floor on every surface, because the comparison view this
project just shipped is deliberately almost entirely disabled controls: what used to be a rare state
is now a whole screen, and `.primary-button:disabled` at 1.67:1 was not a label but a rumour. None of
the four is argued to stay as it was.

3:1 rather than 4.5:1 is a real choice: a disabled control still has to _read as disabled_, and the
only remaining signals are its colour and `cursor: default`. Holding the binding case
(`--surface-11`) to 3:1 incidentally puts the same token at 4.25:1 on white, which is fine — the
floor is a floor.

### The fourth finding: a disabled toolbar button painted as enabled

Found while measuring, and a different defect from the one this pass was about.
`.dark .tool-button, .dark .menubar button, … { color: inherit }` has the same specificity as
`.tool-button:disabled` (two classes each) and comes later in the file, so in the dark theme it won
the cascade outright: a disabled toolbar button was painted in exactly the colour an enabled one is,
with `cursor: default` the only thing left saying otherwise. That is `app-shell.spec.ts`'s own
reported defect ("a disabled instance rendered visually identical to an enabled one") in a theme that
spec does not exercise.

Fixed by restating `.dark .tool-button:disabled { color: var(--text-04) }` rather than reordering —
moving `.tool-button:disabled` below that block would put a disabled state's declaration hundreds of
lines from the control it belongs to, and the next rule added to the block would silently re-break
it. Guarded by its own assertion (enabled and disabled must not resolve to the same colour, in both
themes), because a contrast test cannot see this: the enabled colour has excellent contrast.

## Part 2: the collaborator palette

### What was wrong

`PARTICIPANT_COLOR_PALETTE` (`apps/collab/src/presence.ts`) is used twice, both times as a swatch
with a name on top of it: the remote caret's hover label (`buildRemoteCursorWidget`) and the status
bar's coloured initial (`ParticipantIndicator`). Both paired an inline background from awareness data
with a hardcoded `color: #fff` in the stylesheet — a contrast assertion about every colour the
palette might ever hold, made where nothing could check it.

| colour           | caret on the white sheet (floor 3) | label text, best of white or ink (floor 4.5) |
| ---------------- | ---------------------------------- | -------------------------------------------- |
| rose `#e11d48`   | 4.70                               | 4.70 white                                   |
| orange `#ea580c` | 3.56                               | **4.34 FAIL**                                |
| amber `#ca8a04`  | **2.94 FAIL**                      | 5.25 ink                                     |
| green `#16a34a`  | 3.30                               | **4.68**⁴                                    |
| teal `#0d9488`   | 3.74                               | **4.12 FAIL**                                |
| blue `#2563eb`   | 5.17                               | 5.17 white                                   |
| violet `#7c3aed` | 5.70                               | 5.70 white                                   |
| pink `#db2777`   | 4.60                               | 4.60 white                                   |

⁴ Green clears 4.5:1 _with ink_ — the audit listed it as failing at 4.47, which is its ratio against
white, the colour the stylesheet actually painted. With the hardcoded `#fff` it failed; with the
per-colour choice this pass introduces, it would have passed. Orange and teal fail with either.

The amber **caret** at 2.94:1 is the failure that matters independently of any colour-vision
question: that cursor was hard for everyone to see.

And the colour-vision collapse, by CIEDE2000 across normal vision plus simulated protanopia,
deuteranopia and tritanopia (Viénot/Brettel/Mollon 1999):

| pair           | vision       | dE2000                     |
| -------------- | ------------ | -------------------------- |
| blue vs violet | deuteranopia | **0.59** — the same colour |
| green vs teal  | tritanopia   | **3.74**                   |

(The first audit quoted dE 1.4 and 4.8 for these two using a different simulation matrix. The
absolute numbers move with the model; the ordering and the conclusion do not, and both are far below
the ~2.3 just-noticeable difference for the worst pair.)

### The three constraints, and why one more was needed

1. caret vs the white sheet ≥ 3:1 (WCAG 1.4.11 — the caret is a 2px painted stripe, not a glyph)
2. label text ≥ 4.5:1, choosing white or ink per colour rather than hardcoding `#fff`
   (constraint 2 was later restated in APCA — see the revision section at the end)
3. mutually distinguishable under normal vision and all three dichromacies

A fourth constraint had to be added after measuring the first proposal: **each colour must stay
dE2000 ≥ 25 from the manuscript's own ink.** Constraints 1 and 2 together are satisfiable by making
every colour very dark, and a near-black caret is legible but unreadable _as someone else's_ — it is
indistinguishable from the writer's own. The first proposed palette put blue at dE 16.1 from the ink,
violet at 20.9 and teal at 26.0; three of its eight carets would have read as black stripes.

This was never a defect of the shipped palette (its worst was violet at 30.2, which passes) — it is a
constraint on the _fix_, added because the obvious way to satisfy 1 and 2 breaks something nothing
was measuring.

### The design decision, with numbers

The owner raised an alternative worth testing: a fixed dark label background with the participant
colour as a mere accent, which would leave only constraint 1 binding and let the palette stay vivid.
**Measured, it is worse, and the reason is instructive.**

An accent on a dark label has to clear 3:1 against _that_ label to be a cue at all, which bounds the
colour from below (relative luminance ≥ 0.1645) while constraint 1 bounds it from above (≤ 0.30) — a
1.8× luminance band for all eight colours. Keeping the label background _as_ the colour bounds it
only from above, leaving the whole range below free. Luminance is the one channel dichromats still
have in full, so the wider range wins:

| design                                         | best achievable worst dichromatic pair |
| ---------------------------------------------- | -------------------------------------- |
| label background = participant colour (chosen) | **dE2000 12.98**                       |
| fixed dark label + colour accent               | dE2000 6.04                            |
| the shipped palette, for reference             | dE2000 0.59                            |

(Both figures from the same constrained search over hue/saturation/lightness with the same floors.)

**So the tradeoff taken is the owner's own:** the label background stays the participant colour, the
label _text_ is chosen per colour, and the palette gets more muted as the price. It is more muted
than the audit's starting proposal was in a different way — less dark, more mid-toned — because of
the fourth constraint above.

### The new palette

```
rose   #b85162    orange #be865b    amber  #887306    green  #015a1e
teal   #10a2a0    blue   #345fdf    violet #af79e2    pink   #9e0067
```

> **Superseded in part.** The `label text` column below is what WCAG's ratio chose. The label
> decision was changed to APCA afterwards and all eight now read white — see
> "Revision: the label colour is ranked by APCA, not WCAG" at the end of this document. The palette
> itself is unchanged, so every other column still stands.

| colour           | caret vs sheet | label text | label ratio | dE2000 from ink |
| ---------------- | -------------- | ---------- | ----------- | --------------- |
| rose `#b85162`   | 4.78           | white      | 4.78        | 37.8            |
| orange `#be865b` | 3.11           | ink        | 4.96        | 46.4            |
| amber `#887306`  | 4.66           | white      | 4.66        | 40.9            |
| green `#015a1e`  | 8.46           | white      | 8.46        | 30.2            |
| teal `#10a2a0`   | 3.14           | ink        | 4.92        | 44.7            |
| blue `#345fdf`   | 5.46           | white      | 5.46        | 30.1            |
| violet `#af79e2` | 3.16           | ink        | 4.89        | 42.4            |
| pink `#9e0067`   | 7.93           | white      | 7.93        | 30.1            |

Worst pair across normal vision and all three dichromacies: **dE2000 12.98** (rose vs amber under
tritanopia), against 0.59 before — a 22× improvement on the binding pair. Every pair under every
simulated vision type clears 10.

The three ink-label colours all land within a few hundredths of 3.1:1 on the caret, and that is
structural, not sloppy: a colour light enough for 4.5:1 ink text has luminance ≥ 0.2789, and a colour
dark enough for 3.1:1 against white has ≤ 0.2887. The ink band is 4% of a luminance unit wide. Any
palette using ink labels has its caret ratios pinned there.

### The per-colour text mechanism

`participantLabelTextColor(color)` in `packages/screenplay-editor/src/contrast.ts` returns whichever
of `#ffffff` (the sheet) or `#20252b` (`--text-19`, the manuscript's ink) has more contrast against
the colour. Both painters call it — `buildRemoteCursorWidget` sets `label.style.color`,
`ParticipantAvatar` sets the initial's `color` — and the two `color: #fff` declarations in
`styles.css` are gone, with no fallback, because a fallback would only hide a future failure to set
it.

It lives in `packages/screenplay-editor` because `apps/collab` (which owns the palette) and
`apps/web` (which owns the status-bar indicator) have no dependency on each other and both already
depend on that package. Five of the eight colours resolve to white and three to ink, so neither
branch is dead — `participantPalette.test.ts` asserts exactly that, so a future palette cannot
quietly make the mechanism vestigial.

The mechanism is a _necessary_ condition, not a sufficient one: a mid-toned colour can fail with
either choice (orange and teal did). The palette is still constrained, and the test is what holds it.

## Part 3: the two things the first audit could not settle

**The dark theme** is Part 1 above — the same failure, worse, in four rules, plus the disabled-button
cascade defect.

**Text over the participant colours or the diff marks.** All measured, nothing else failing:

| what                                                            | measured | floor |
| --------------------------------------------------------------- | -------- | ----- |
| diff `<del>` text, `--text-13` on `--fd-diff-removed-surface`   | 8.70     | 4.5   |
| diff `<ins>` text, `--text-16` on `--surface-10`                | 10.50    | 4.5   |
| diff gutter label, `--text-08` on the white sheet               | 4.99     | 4.5   |
| diff gutter glyph, `--feedback-error` on the white sheet        | 7.30     | 4.5   |
| diff "moved" note, `--border-11` on the white sheet             | 4.64     | 4.5   |
| `.element-menu-option` text, `--text-17` on a selected row      | 11.86    | 4.5   |
| statusbar text, `--text-10` on `--surface-07`                   | 4.77     | 4.5   |
| `.dark` statusbar text, `--dark-text-03` on `--surface-07` dark | 9.12     | 4.5   |
| `.dark` `--feedback-error` on `--dark-surface-02`               | 6.39     | 4.5   |
| the client's `FALLBACK_COLOR` `#6b7280`, label text             | 4.83     | 4.5   |

The diff `<ins>` mark keeps `--fd-diff-added-surface` under `.dark` (the sheet stays white), so its
10.50 holds in both themes.

**One thing found and deliberately not fixed.** `.participant-avatar` is a 16px circle on the status
bar; the _initial inside it_ now clears 4.5:1 against its own swatch, but the circle's own edge
against the bar does not always clear 3:1 — the three ink-label colours measure 2.60-2.63 against
`--surface-07` in light mode, and green 1.40 / pink 1.49 against its dark counterpart. (The shipped
palette had the same gap: amber measured 1.29 against the dark bar.) Not fixed here: the chip is
`aria-hidden`, its identity is carried by the parent's `aria-label` and by the high-contrast initial
inside it, and the obvious remedy (a hairline ring) is a visual design change nobody asked for. A
one-line `box-shadow` would close it if the owner wants it.

## The regression guard

Four files, split by what can actually observe each property.

**`apps/web/e2e/text-contrast.spec.ts`** (36 tests, runs under `pnpm test:system` — the ordinary
Playwright config, no database). Injects markup using the app's own classes onto an already-served
route, reads `getComputedStyle`, walks up to the nearest painted background the way the browser does,
and computes the WCAG ratio. Seventeen rule/surface cases, in both themes where both exist, plus the
disabled-state and swatch-ownership assertions.

A real browser rather than a unit test, for the reason `apps/landing/e2e/header-contrast.spec.ts`
already records: every colour here arrives through a `var()` chain, and what matters is what the
cascade resolves it to on a given element — which depends on which theme class an ancestor carries
and which container re-anchored the token. A test parsing `styles.css` would have to model the
cascade, and a modelling error is a false green.

**`apps/collab/src/participantPalette.test.ts`** (30 tests, `pnpm test`). All four palette
properties, computed from the palette's own values. No hex colour is named in any assertion.

**`packages/screenplay-editor/src/contrast.test.ts`** (16 tests, `pnpm test`). Pins the arithmetic
itself against values WCAG's own documentation states — 21:1 for black on white, the per-channel
coefficients, `#767676`/`#777777` as the canonical pass/fail pair. Without this, a wrong luminance
formula would make every computed-property test above green simultaneously and silently, which is
the one failure mode a computed guard has that a hex-pinning one does not.

**`presence.test.ts` and `ParticipantIndicator.test.tsx`** both gained assertions that the painted
text colour is the better of the two available choices, measured against the swatch the code actually
painted — not by calling `participantLabelTextColor` again, which would only restate itself.

### Mutation testing

The repo has shipped four assertions that passed with the thing they guarded removed. Each new guard
was therefore run against a restored defect, and only against the suite meant to prove that property.

| mutation                                    | suite                        | result                                                                                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| amber restored to `#ca8a04`                 | `participantPalette.test.ts` | **2 failed, 28 passed** — the caret ratio for `#ca8a04` (2.94 < 3) and the tritanopia separation (`#be865b` vs `#ca8a04`, dE 2.99 < 10). Its _label_ assertion correctly still passed: amber's label was never the failure.                          |
| `--text-07-on-white` restored to `#78848a`  | `text-contrast.spec.ts`      | **21 failed, 13 passed** — including `.ruler` light (3.21), all four `.muted` cases, both placeholder hints, the ghost, and both `.element-menu-key` rows. `.ruler` _dark_ correctly still passed, confirming the two tokens are genuinely separate. |
| `.dark { --text-07 }` restored to `#78848a` | `text-contrast.spec.ts`      | **4 failed, 30 passed** — exactly the four dark-chrome rules (`.ruler`, `.muted` in the Inspector, `.scene-list small`, `.navigator-empty`), and no light-theme case.                                                                                |

The third was not required but the dark theme's own value is a new claim, so it was mutated too.

## What is not proven

- **Nothing here was checked visually.** Every claim is a measured ratio or a computed colour
  difference. Whether the new palette is _pleasant_ — eight more muted colours instead of eight vivid
  ones — is a judgement the owner should make by looking at it, and it is the deliberate cost of
  keeping the label background on the participant's own colour.
- **The dichromat simulation is an approximation.** Viénot 1999 is one of three published models; a
  different matrix set moves the absolute dE figures by a few units. The floors are set with real
  headroom (10 against an achieved 12.98) so the test catches a _collapse_, which every model agrees
  on, rather than certifying a precise distance.
- **Colour-vision deficiency is modelled as full dichromacy only.** Anomalous trichromacy (the
  common case) is not simulated, and the owner's own point stands: many people affected run a
  correction filter, which this cannot account for either way.
- **`.participant-avatar`'s edge against the status bar** is below 3:1 for some colours in one theme
  or the other, measured and left (see Part 3).

## Lead verification

The implementing agent stalled before it reached the gates, so every gate below and both mutations
were run by the lead on the finished tree.

**The palette was re-derived independently**, not taken on trust. All three constraints hold with
zero failures:

|                  | caret on the white page (needs 3:1) | label text (needs 4.5:1) |
| ---------------- | ----------------------------------- | ------------------------ |
| rose `#b85162`   | 4.78                                | 4.78 white               |
| orange `#be865b` | 3.11                                | 4.74 ink                 |
| amber `#887306`  | 4.66                                | 4.66 white               |
| green `#015a1e`  | 8.46                                | 8.46 white               |
| teal `#10a2a0`   | 3.14                                | 4.70 ink                 |
| blue `#345fdf`   | 5.46                                | 5.46 white               |
| violet `#af79e2` | 3.16                                | 4.67 ink                 |
| pink `#9e0067`   | 7.93                                | 7.93 white               |

Worst pairwise distance across normal vision and all three simulated dichromacies: **dE 12.6**
(tritanopia, amber vs violet), against **dE 1.4** before (deuteranopia, blue vs violet -- literally
the same colour). Blue and violet are now dE 30.3 apart under normal vision and comfortably separated
under every simulation.

Worth recording that this palette is _less_ mathematically optimal than one the lead computed
beforehand (worst dE 19.9) and better as a product decision: that one reached its headroom by pushing
rose, blue and violet to near-black, which would have read as a palette of muddy darks rather than
eight recognisable collaborator identities. 12.6 is comfortably above the threshold where two colours
read as distinct, and the set still looks like rose, orange, amber, green, teal, blue, violet, pink.

**A concern the lead raised and then disproved by tracing it.** `--text-04-on-white` is `#6f7d84`,
which is 4.25:1 on white and 3.99:1 on chrome -- both under 4.5. That would be a remaining failure if
anything holding real text still used it. It does not: all five remaining `var(--text-04)` rules are
`:disabled` controls (`.tool-button`, `.text-button`, `.overflow-menu-list button`, and the `.dark`
variant), which WCAG 1.4.3 exempts and which were held to 3:1 deliberately. The placeholder hints and
the SmartType ghost -- which are _not_ exempt, being real text a writer reads -- were moved to
`--text-07`, resolving to `#5f686d` at 5.69:1 on white. The split is correct; the token that stayed
weak is the one that is allowed to be.

**Both mutations run against the suite that owns the property:**

- Amber reverted to `#ca8a04` -> `apps/collab/src/participantPalette.test.ts` fails two tests, and
  names the colour in the failure: "draws a caret on the white sheet that clears WCAG 1.4.11 at
  #ca8a04", plus the tritanopia separation test. One mutation, both of that colour's faults caught.
- `--text-07-on-white` reverted to `#78848a` -> `apps/web/e2e/text-contrast.spec.ts` fails five
  tests (`.ruler`, `.muted` in three different surroundings, `.scene-list small`), each naming the
  surface it measured against.

Neither guard pins a hex value, so retuning a token is caught by the ratio rather than by a literal.

**Gates, all run by the lead:** `lint` 0, `format:check` 0, `typecheck` 0, `pnpm test` 0 (web 876,
screenplay-editor 135, collab 158, api 243, screenplay 172), `test:coverage` 0,
`check:bundle-budget` 0 (entry 111.95 kB, lazy editor 145.09 kB, CSS 7.61 kB), `test:integration` 0
(11 + 58 + 27), `test:system:persistence` 33/33 first run with no flake, `test:system` **76/76** (up
from 40 -- the new contrast spec).

**Unproven:** nothing here was checked visually. Every claim is a computed ratio or a simulated
dichromacy distance from real Chrome. Whether the new palette _looks_ right as eight collaborator
identities, and whether the darker greys read as intended rather than as heavier chrome, is a
judgement the measurements cannot make.

## Revision: the label colour is ranked by APCA, not WCAG

Added after the palette above shipped to the branch, on Nathan's observation while looking at it in
the browser: the violet and orange labels were reading in dark ink, and white looked better to him.

He was right, and the reason is a known limitation rather than a bug in the palette. WCAG 2.x
contrast is a ratio of relative luminances, with no model of polarity, and it mis-ranks
light-on-colour against dark-on-colour for mid-toned saturated backgrounds. APCA (Accessible
Perceptual Contrast Algorithm) has polarity-specific exponents precisely because that ranking is
not symmetric. On the three colours in question the two metrics disagree, and APCA agrees with his
eye:

| colour           | WCAG white | WCAG ink | WCAG picks | APCA white | APCA ink | APCA picks |
| ---------------- | ---------- | -------- | ---------- | ---------- | -------- | ---------- |
| orange `#be865b` | 3.11       | **4.96** | ink        | **63.4**   | 42.4     | white      |
| teal `#10a2a0`   | 3.14       | **4.92** | ink        | **63.3**   | 42.5     | white      |
| violet `#af79e2` | 3.16       | **4.89** | ink        | **63.8**   | 41.9     | white      |

APCA prefers white on all eight entries — agreeing with WCAG on five and overruling it on exactly
the three that looked wrong. The clearest way to see the asymmetry is a neutral grey ramp: WCAG
crosses over from preferring white to preferring ink at `#808080`, APCA not until `#a6a6a6`, so for
all 38 greys in between the two metrics disagree.

`participantLabelTextColor` now ranks by `apcaContrast`. Every label in the product reads white.

### What this costs, stated plainly

**The three colours above no longer meet WCAG 1.4.3 at normal text size.** White on them measures
3.11–3.16:1 against a 4.5:1 floor. This was Nathan's decision, made with both sets of numbers in
front of him, to favour the metric that predicts legibility over the one that is the formal
standard.

**APCA does not certify them either.** Its conformance is a font-size-and-weight lookup, and at the
10px/600 of `.remote-cursor-label` and the 9px/700 of `.participant-avatar` the required Lc is far
above the ~63 these reach. Neither standard passes a label this small at any colour. The honest
claim for this change is narrow: of the two colours available, the more legible one is now the one
used.

**The real remedy is the font size, and it has not been applied.** 10px and 9px are the binding
constraint on these labels; no choice of text colour fixes that. Left alone because the user asked
for a colour change, and enlarging a presence chip and a hover label is a visual-design decision
with its own consequences for the status bar's layout.

The palette was deliberately **not** retuned. Darkening orange, teal and violet until white cleared
4.5:1 would have satisfied both metrics at once, and was offered; Nathan's answer was "I like the
colors as they are now." Under APCA the old squeeze that produced those three mid-tones no longer
binds, so the only reason to move them would be a metric that is no longer making the decision.

### Where the rule and its floor now live

- `apcaContrast(text, background)` in `packages/screenplay-editor/src/contrast.ts` — signed Lc,
  positive for dark-on-light and negative for light-on-dark. `relativeLuminance` could not be
  reused: APCA uses a plain 2.4-power curve and a soft black clamp, so the two metrics disagree
  about what luminance _is_.
- `contrastRatio` stays, and stays WCAG. The caret's 1.4.11 floor and every fixed colour in
  `apps/web/e2e/text-contrast.spec.ts` are conformance checks stated in WCAG's terms, and APCA has
  no standing there. Only the paper-or-ink ranking moved.
- `PARTICIPANT_LABEL_MINIMUM_LC = 60` — the palette floor, replacing the 4.5:1 row in
  `participantPalette.test.ts`. Its job is to fail loudly if a colour pale enough that _neither_
  paper nor ink reads on it is ever added, which is the one case "pick the better of two" cannot
  rescue. The palette's worst entry measures 63.3.
- `participantPalette.test.ts` also now asserts that all eight resolve to paper. That is a
  constraint on the palette, not a restatement of the rule: one pale entry would make a single
  collaborator's name read dark while the rest read white, and it should fail rather than ship.
  The ink branch's liveness moved to `contrast.test.ts`, against explicitly pale colours.

### Verification

The TypeScript APCA implementation is pinned against Lc **106.04** for black on white and
**−107.88** for white on black — the two figures APCA's own material quotes, and the standard way to
confirm an implementation. Both were computed independently in Python first and matched.

**Three mutations, each against the suite that owns the property:**

- Ranking reverted to `contrastRatio` → fails in all four suites, every failure naming the affected
  colours: `contrast.test.ts` 4, `presence.test.ts` 2 (`#10a2a0`, `#af79e2`),
  `participantPalette.test.ts` 4, `ParticipantIndicator.test.tsx` 3 (`#be865b`, `#10a2a0`,
  `#af79e2`).
- Reverse-polarity exponent 0.65 → 0.56 → fails the pinned extremes and the crossover test.
- Soft black clamp removed → fails the extremes, the asymmetry test and the crossover test.

**Unproven:** the same caveat as the original pass. Nathan has now seen the dark-ink labels and
judged white better by eye, which is what prompted this; he has not yet seen the result with two
real accounts, which still needs the visual check the measurements cannot make.

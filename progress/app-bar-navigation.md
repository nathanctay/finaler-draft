# One app bar on every screen

> "We need an easier UI to navigate. Right now when you click into a project, you lose the account
> dropdown in the top right and the finaler draft logo in the top left."

The owner chose this over a left rail after interacting with a mockup of both. Their reasoning is
worth keeping, because half of it expires and half does not:

- **A rail only helps you go back.** _"Theres no way of knowing where a user would want to go
  forward, unless you have every project in the sidebar, and then it would need to expand and
  collapse on over."_ True today. Phase 4's Beat Board and Outline Editor are forward destinations
  _within_ a screenplay, so this argument genuinely weakens then, and the rail question should be
  allowed to reopen as a within-screenplay rail.
- **A rail reads as a modern dashboard.** _"the app bar fits our sites more retro aesthetic."_ This
  does not expire. The Georgia brand mark, Courier Prime manuscript, File/Edit/View menubar, flat
  2-3px radii and near-absent elevation are desktop-application vocabulary, and a proposal can be
  individually sensible and still wrong here for pulling toward contemporary SaaS.

## What was actually wrong

Broader than the report. Surveyed before any code was written:

| screen           | logo                 | account menu                                   | up-navigation                  |
| ---------------- | -------------------- | ---------------------------------------------- | ------------------------------ |
| Projects list    | brand, not a link    | real `OverflowMenu`                            | —                              |
| Project          | none                 | none                                           | bare `Projects` text link      |
| Deleted items    | none                 | none                                           | bare `Projects` text link      |
| Billing          | none                 | none                                           | bare `Projects` text link      |
| Revision history | none                 | none                                           | bare "Back to screenplay" link |
| Editor           | brand to `/projects` | **a dead `<span className="account-button">`** | logo only                      |
| Revision diff    | same titlebar        | same dead span                                 | —                              |

Seven screens, **five** hand-rolled `<header className="project-header">` blocks, and one shared
`ApplicationTitlebar` — and the two families did not even share a ground colour (`.titlebar` is
dark `--surface-16`, `.project-header` was light with a bottom border).

The dead span is its own defect: it rendered "FD", looked like a control, and did nothing. Same
family as the export buttons in `progress/paste-sanitization.md`.

**Two of those seven were missed in the original brief** (billing and revision history) and were
converted afterwards by the lead. Worth recording because the omission is instructive: the brief
named the screens it had surveyed, and a `grep` for the remaining `project-header` occurrences
after the fact is what found the rest. Scope a chrome unification by grepping for the thing being
replaced, not by listing the screens you remember.

## The seam, and why the bar owns no navigation

`ApplicationTitlebar` takes the account menu and the breadcrumb trail as **nodes**, and stays free
of both `@tanstack/react-router` and `@tanstack/react-query`.

The owner pushed back on exactly this: why not just make the bar router-aware? Fair question, and
the answer is not the one the lead gave first. Three measurements:

- `App.tsx` imports neither library. The only matches for those names are comments explaining that
  the independence is deliberate.
- `App.test.tsx` provides neither context and calls `render(<App …>)` in 67 places, in a suite of
  over a thousand tests.
- The account menu needs **both** — `navigate` for its destinations and a react-query mutation for
  sign-out. So it is two dependencies, not one.

But the real reason is structural, not a test count: **the bar is a single row carrying both
route-level and editor-level concerns.** Brand, breadcrumb and account are route-level. The
document title — inline-renameable, owner-gated, with its own mutation and local state — and the
save indicator are editor state, and they sit in the middle of that same row. Something crosses
that boundary whichever side renders the bar. Injecting router-aware leaves into a dependency-free
bar costs one `ReactNode`; the reverse pushes the rename mutation up into the route.

**Stated fairly, the alternative is defensible** and reads more simply at each call site. It loses
on the component boundary, not on line count.

## One pattern, applied twice

Both router-aware pieces are single components passed in as nodes:

- **`accountMenu.tsx`** owns its own `navigate` calls, its own `signOut` mutation, and the single
  definition of its items. Every screen renders `<AccountMenu />`. The first draft of the brief
  allowed each route to pass its own _item list_ instead, which would have recreated the drift this
  slice exists to remove — the same mistake as five hand-rolled headers, one layer up.
- **`routeBreadcrumb.tsx`** derives the trail from `useMatches()` plus a per-route
  `staticData.breadcrumb`, typed through a `declare module '@tanstack/router-core'` augmentation.
  This is why `@tanstack/router-core` is now a version-pinned devDependency: under pnpm's strict
  linking you cannot augment a module you do not declare.

Hand-assembled trails were the first instinct and were rejected on the owner's "we're building for
the future" reframe. A per-route array encodes the hierarchy in N places, and N grows: Phase 4 nests
a Beat Board and an Outline Editor beneath a screenplay, so the trail becomes
`Projects / project / screenplay / Outline`. Adding a route now means declaring one label.

**The ancestor crumbs live on the pathless `$projectId` layout route**, once, so every
project-scoped descendant inherits `Projects` and the project title for free — including the two
screens converted late, and including whatever Phase 4 adds. A route with no shared ancestor
(`/deleted`, `/billing/subscription` — top-level siblings of `/projects`, confirmed against
`routeTree.gen.ts`) declares its own fixed crumb.

**A crumb whose `label` resolves to `undefined` is omitted, never rendered as a placeholder.** The
real case: a screenplay reached through screenplay-scoped sharing, where the viewer is not a project
member, so `['projects']` does not contain it and the title genuinely cannot be resolved.
`Projects / Act One` with the project silently dropped is honest; a placeholder would not be.

**The editor's final segment is never route-derived.** It remains the existing inline-renameable
title with its `title-type` suffix and save indicator — editor state with an owner gate and a
mutation. The rename's own appearance and hit-area specs stayed green throughout.

## Verification

`test:system` is **89**, including two new specs.

`app-bar-navigation.spec.ts` measures, in real Chromium: brand left / trail centre / account right;
that the bar is the dark surface **on every screen**, not just the editor; that the current
non-navigating segment reads differently from an ancestor link beside it; and that the account
trigger clears WCAG 1.4.3 against the bar behind it.

`app-bar-logo.spec.ts` measures: that at rest only the logo is in view, with the label fully outside
the brand's box; that hovering slides one out and the other in — a wipe, not a fade; that keyboard
focus wipes identically with no pointer involved; that the accessible name states the destination
_before_ any hover and is unchanged by it; and that `prefers-reduced-motion` removes the transition
while the label still swaps.

Both were written before the CSS. That discipline is not optional here: three visual defects have
reached the owner's eye through a green unit suite on this project — a submenu flyout rendering over
its own menu, the title rename rendering as a white box, and that control's hit area ending at the
last glyph. jsdom performs no layout and resolves no stylesheet, so it cannot see any of them.

**Mutations, all run by the lead against the finished branch:**

| mutation                                                          | result                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| editor logo targets `/projects` instead of the project            | kills "gives the editor a real way back to its own project via the brand mark, not the dashboard"                         |
| the wipe becomes an opacity fade                                  | 2 specs fail in `app-bar-logo.spec.ts`                                                                                    |
| `.titlebar` background set to a light surface                     | 2 specs fail — the luminance assertion, **and** the account trigger's contrast collapsing to 1.04:1 against a 4.5:1 floor |
| `$projectId`'s `staticData.breadcrumb` removed                    | 3 tests fail, naming each crumb it contributes                                                                            |
| revision-history crumb pointed at the project, not the screenplay | kills "points back at the live screenplay, labelled with its real title"                                                  |

**One mutation initially killed nothing, and the gap was closed rather than recorded.** Replacing
the revision-history loader's return with `{}` left every crumb test green, because those tests feed
`loaderData` in directly and never exercise the loader — the half that can silently cost the trail
its screenplay segment. A loader test was added, mirroring the project layout's own; the same
mutation now fails it.

## Gates

Run by the lead against the finished branch, after the two late conversions:

- `pnpm install --frozen-lockfile` — exit 0
- `pnpm lint`, `pnpm typecheck` — 0
- `pnpm test` — **1090** in `apps/web`, zero failures
- `pnpm test:integration` — 0, against an isolated `postgres:16` on 55437
- `pnpm test:coverage` — 0, no threshold failures
- `pnpm build`, `pnpm check:bundle-budget` — 0. Entry **112.22 kB** / 120 (up from 111.95: the
  breadcrumb and account menu are now in every route's graph); lazy editor closure **166.65 kB** /
  200 across 6 chunks; CSS **8.18 kB** / 20
- `pnpm test:system` — **89** passed
- `pnpm test:system:persistence` — failed once on `presence-persistence.spec.ts`'s click-through
  case, then 36/36 on re-run. **Confirmed the known flake by mechanism, not just by a passing
  re-run**: that test works in coordinates, and this branch changes chrome, so the obvious worry was
  a shifted manuscript. It is not possible — the titlebar occupies a fixed 38px grid track
  (`--fd-shell-titlebar-row`), and the only height this branch changed is the new wipe label's
  26px to 22px, inside that fixed track. The manuscript cannot have moved.
- `pnpm format:check` — run bare, last, exit code reported below

## Unproven

How the dark bar reads on the three plain screens is a judgement no measurement settles. The specs
prove it _is_ the dark surface everywhere and that the account trigger clears 4.5:1 against it;
whether the projects list looks better for it is the owner's call on sight.

## Two defects the owner found on sight

### The project's own name rendered twice

> "I click into a project called 'project 2' and the top bar is 'Projects/Project2/Project2', with
> the first 'project2' seeming to be a link, but obviously it does not go anywhere different
> because thats where we are."

The `$projectId` layout contributes the project's crumb so that every descendant inherits it, and
the project screen also passes `documentTitle={projectTitle}`. On that one screen those are the same
thing, so the name appeared twice — once as a link to the page already open, once as the current
segment.

Fixed in `RouteBreadcrumb`, not on the screen: a crumb resolving to the current location is not an
ancestor, so it is not part of the trail. Doing it on the screen (by passing no `documentTitle`)
would have left a link to the current page in the trail and fixed only this instance. The property
is "an inherited ancestor crumb resolved to the current page", which any future screen can
reproduce — the Beat Board and Outline Editor will both sit beneath a screenplay whose crumb they
inherit, and the screenplay screen itself has the same shape as the project screen does now.

Paths are compared with trailing slashes normalised, since the router is not consistent about
emitting them and one would put the duplicate straight back.

### The bar collapsed to a thin strip off the editor grid

> "The top bar is also much too thin. There does not seem to be any vertical padding."

`.titlebar` has `padding: 0 12px` — no vertical padding at all — and no height of its own. Its only
height came from `grid-area: titlebar` inside `.application`, whose `grid-template-rows` reserves
`--fd-shell-titlebar-row` for it. The four plain routes now wearing the same bar are not that grid
(`.project-screen` has no rule in the stylesheet at all), so there it sized to its content:
**15px against the editor's 38px**, measured.

Fixed with `min-height: var(--fd-shell-titlebar-row)` on `.titlebar`, so one variable drives both
contexts and a future change to the shell's track moves them together. Vertical padding was the
other option and is worse: it would need to be kept in step with the track by hand, and inside the
grid it would add to the 38px rather than fill it.

**The first attempt at this silently did nothing, which is the part worth keeping.**
`--fd-shell-titlebar-row` was declared on `.application`, not `:root`. On a plain route it resolved
to nothing, the `min-height` declaration was therefore invalid, and the bar kept collapsing — with
the rule sitting in the file looking entirely correct. The variable is now on `:root`, with a
comment saying why it lives there while the shell's other four row tracks do not: nothing outside
the editor renders a menubar, toolbar, banner or status bar, so those have no second context to be
shared with.

### Verification

`test:system` is **90**. The new case measures the bar in both contexts and asserts they are equal
and both real, rather than reading the stylesheet — the only way to tell "the rule is present" from
"the rule applies", which is exactly the distinction the failed first attempt turned on.

| mutation                                               | result                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `--fd-shell-titlebar-row` moved back to `.application` | fails: off-grid height **15px**, the silent no-op reproduced |
| `min-height` removed outright                          | fails: off-grid height **15px**                              |
| self-referential crumbs no longer dropped              | 2 unit tests fail, including the trailing-slash case         |
| trailing-slash normalisation removed                   | 1 unit test fails                                            |

Gates after both fixes: `lint` 0, `typecheck` 0, `pnpm test` **1093** zero failures,
`test:integration` 0, `test:system` **90**, `check:bundle-budget` 0.

### Still open for the owner

Whether the editor should show the whole trail or only the screenplay name. It is the same
`ApplicationTitlebar` on every screen, so the trail is shared rather than bolted onto the editor —
and with the duplicate gone the editor reads `Projects / <project> / <screenplay>`, where the middle
segment is the same one-click way back to the project that the brand's wipe offers. Trimming it to
the name alone is a one-line change if the owner still wants it after seeing it fixed.

## The editor shows the screenplay's name alone

The owner's call after seeing the trail working: _"Lets have just the screenplay name on the
editor."_

So the editor's bar is brand, screenplay title, account menu — no path. The editor route simply
stops passing a `breadcrumb`, which is the whole change: `App` forwards whatever it is handed and
builds nothing itself, so one line in one route decides it. The revision-comparison view next door
keeps its own trail, independently, because it supplies its own.

Nothing becomes unreachable. The project crumb's destination is the same place the brand's "Return
to project" wipe goes, so removing the trail stops the editor's bar saying the same thing twice
rather than removing a way out. That the two coincided is also why this was the right screen to trim
and the plain screens were not: on those the brand goes to the dashboard, so the trail is the only
way up one level.

Reverting is adding `breadcrumb={<RouteBreadcrumb />}` back to the editor route, and the comment
there says so.

The route test was inverted rather than deleted: it now asserts the editor is handed **no**
breadcrumb, so restoring one is a deliberate act that fails a test first instead of drifting back in
unnoticed. Mutation: re-adding the prop fails exactly that test, named for the decision.

## The hover reveal became a clipping edge, not a slide

The owner, after living with the sliding version: _"What I was imagining was more where both start
in place, but only the logo is visible, and on hover it wipes so the visibility on the logo goes
away from right to left on hover, like one of those image comparers where you can drag a line in
the middle to reveal one image or the other."_

Entirely doable, and cheaper than the slide it replaced. The markup was already two panels stacked
in one box, so this is a CSS change plus its specs — deliberately nothing else, so reverting it is
reverting two files.

**Neither panel moves now.** `clip-path: inset()` on both, with complementary insets so there is one
boundary rather than two reveals: the logo's _right_ inset grows 0 to 100%, cutting it away from its
right edge leftward, while the label's _left_ inset shrinks 100% to 0, bringing it in from the same
edge. At any moment the logo holds everything left of the boundary and the label everything right of
it — the draggable-divider mechanic the owner described.

Rejected alternatives, both of which were tried as mutations and fail the specs: `transform`, which
is what this replaced — translating the panels slides them past the box, so the logo's leftmost
characters leave first and the two never share a boundary; and `opacity`, which cross-fades in place
with no edge at all. `clip-path` is compositor-animated, so it costs no more than the transform did.

### A test of mine that claimed more than it proved

The first version of the spec asserted that the two panels' visible fractions sum to the whole box
at both ends of the transition, and its comment claimed this caught a regression that clipped both
panels from the same side. **It did not.** Clipping both from the same side still leaves the logo
whole at rest and the label whole on hover, so the sums agree at exactly the two moments a test can
sample reliably; the arrangements differ only mid-transition. The mutation passed, which is how the
overclaim surfaced.

Fixed by asserting the _direction_ each panel is clipped from — the logo must retreat from its right
edge, the label must arrive from its left — which is deterministic and needs no timing. The sum check
stayed, with an honest comment: it catches a clip cutting from the right side by the wrong amount,
which the direction check alone would not.

A second self-inflicted bug worth recording: `getComputedStyle(...).clipPath` does **not** resolve
percentages to pixels. An authored `inset(0 0 0 100%)` comes back as `inset(0px 0px 0px 100%)`,
mixing units in one value, so parsing every side with a bare `parseFloat` read `100%` as `100px` and
reported a fully-clipped panel as roughly half-visible. The helper is unit-aware now.

| mutation                                 | result                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| back to `transform` (the previous slide) | 4 of 5 specs fail                                                             |
| `opacity` cross-fade instead of a clip   | 3 of 5 specs fail                                                             |
| both panels clipped from the same side   | 1 spec fails — only after the direction assertion was added; it passed before |

Gates: `lint` 0, `typecheck` 0, `pnpm test` 0, `test:system` **90**, `test:integration` 0
(11 + 101 + 32), `check:bundle-budget` 0, `format:check` 0 bare and last. Reduced motion and the
accessible-name behaviour are unchanged and still covered — the name states the destination before
any hover, and `prefers-reduced-motion` removes the transition while the swap still happens.

### Then sequenced: the logo leaves before the label arrives

> "Is there a way we could have the logo fully wipe away before the 'return to projects' wipes in"

Yes, and it is a timing change rather than a mechanism one — the clipping stays exactly as above,
each panel just gets its own phase. `--fd-brand-wipe-phase` (100ms) is both panels' duration _and_
the trailing one's delay, so the whole gesture is 200ms in two halves.

**The delays live on the resting rules as well as the hovered ones, so the order reverses with the
direction.** Hovering: the logo clips away first, the label waits out that phase. Leaving: the label
clips away first, the logo returns after it. Without the resting delays, moving the pointer off
would play both halves simultaneously and look nothing like the entrance — a detail easy to miss,
because the entrance is the only half anyone tests by hand.

One custom property rather than two literals because the delay must _equal_ the duration: shorter
overlaps the halves back into the single edge, longer leaves a visible gap of empty bar between
them. Two numbers could drift; one cannot.

The reduced-motion block now lists the hovered selectors too, at matching specificity, and zeroes
the delay explicitly. `transition: none` on the base rules alone is in fact sufficient — with no
transition property there is nothing for a delay to postpone — but `.brand-wipe:hover .brand-face`
is two classes to that block's one, so its delay still wins the cascade, and stating both is cheaper
than making the next reader deduce that the delay is inert.

**The endpoint states are identical to the single-edge version**, which is precisely why this needed
a test of its own: every other case in `app-bar-logo.spec.ts` passed unchanged after the sequencing
landed, because none of them can see timing. The new case reads computed `transition-duration` and
`transition-delay` in both states rather than sampling the clip mid-animation, which would have to
race a 200ms gesture and would flake.

| mutation                                      | result                                        |
| --------------------------------------------- | --------------------------------------------- |
| all delays zeroed (back to one shared edge)   | fails: hover label delay 0, expected >= 100   |
| resting delays not reversed                   | fails: leaving would play both halves at once |
| duration raised to 300ms, delay left at 100ms | fails: the halves overlap                     |

### And slowed down, because 200ms was imperceptible

> "Can we try making them a bit longer. Its hard to even tell whats happening. I wasn't sure it was
> doing what I asked until I screen recorded and watched it slower."

`--fd-brand-wipe-phase` is 200ms rather than 100ms, so the whole gesture is 400ms in two halves.

The diagnosis matters more than the number. 100ms sits around the floor at which motion registers
as motion at all, so a _staged_ animation assembled from two of them cannot read as staged — the
ordering was correct the whole time and simply invisible. Needing a screen recording to confirm the
behaviour is the symptom of a tempo problem, not of a mechanism one, which is why nothing about the
clipping changed here.

The spec now fences the tempo on both sides instead of only capping it:

- a **floor** of 150ms per phase, so a future tuning cannot quietly return it to a blur — the thing
  that was wrong, and that no previous assertion could have caught;
- a **ceiling** of 600ms on the whole gesture, raised from 400ms, which the doubling would otherwise
  have sat exactly on. A ceiling is still right: nothing depends on the animation completing, since
  the destination is in the control's accessible name either way, so a reveal on a brand mark can
  afford a longer gesture than a functional control could — but not an unbounded one.

**A test bug the change exposed.** Three specs waited a hardcoded `300ms` for the gesture to settle.
That was already only just sufficient at 200ms total and became wrong at 400ms, so they failed on a
partially-complete clip rather than on anything real. They now derive the wait from the elements'
own computed duration and delay, which is the only form that survives the custom property being
tuned — and being tunable from one declaration is the point of it.

| mutation              | result                        |
| --------------------- | ----------------------------- |
| phase back to 100ms   | fails the floor: 100 < 150    |
| phase raised to 400ms | fails the ceiling: 1200 > 600 |

## Both reveals kept, the slide active

> "I like both the slide and sequenced transitions so much... Could we do the slide transition for
> now, but include the sequenced transition in the code, perhaps commented out, so switching is as
> easy as switching which line(s) is commented"

Done, and it is a **deliberate, bounded exception** to this project's "keep only active code" rule
rather than an oversight. What keeps it bounded: exactly one of the two blocks in `styles.css` is
ever live, they are the only place either mechanism is expressed, and the specs do not know which
is which.

**That last part is what makes it a genuine one-edit switch, and it required restructuring the
tests.** `app-bar-logo.spec.ts` previously asserted the staged clip's own mechanics -- clip
directions, transition delays, a tempo floor and ceiling. Leaving those in place would have meant
flipping the comment also broke four specs, which is precisely the friction the toggle exists to
remove. They now assert only what both mechanisms share:

- the logo in view at rest, the label in view on hover **and** on keyboard focus
- reversible: leaving puts the logo back
- geometric, never a cross-fade (opacity untouched in both states)
- neither panel growing the bar it sits in

Measured by **hit-testing across the brand's box** rather than by computed styles, because that is
the one measure both mechanisms move: a region translated out of the box and a region clipped away
are equally absent from it, and `clip-path` removes a region from hit-testing just as
`overflow: hidden` removes a translated one.

**Verified in both directions**: the full suite passes with either block live. That was run, not
assumed -- the comments were flipped, the suite re-run clean, and the slide restored.

The staged clip's own timing assertions are gone with it. That is the honest cost of the toggle: the
inactive mechanism is not covered by anything, so switching back means re-adding its floor/ceiling
and delay-order assertions from this document or from its own commit. Recorded so nobody assumes
the alternative is still under test.

`--fd-brand-wipe-phase` is now read only by the commented block, and its own comment says so, so a
reader finding it apparently unused knows why before deleting it.

**When one is settled on, delete the other.** Both are recorded here in full and each shipped as its
own commit, so removing the loser loses nothing.

## A back-arrow on the label

> "an arrow to the left of 'Return to project'"

A separate `aria-hidden` element inside the label rather than part of the `wipeLabel` string,
because that string doubles as the control's accessible name -- "Finaler Draft — ← Return to
project" is not something anyone should hear. Same treatment the overflow menu's `›` disclosure
glyph already gets, for the same reason.

The e2e fixture's markup was updated to mirror the component's, since a fixture that drifts from
what ships stops testing it.

| mutation                              | result                                                     |
| ------------------------------------- | ---------------------------------------------------------- |
| arrow folded into `wipeLabel` instead | fails the editor's accessible-name test in `App.test.tsx`  |
| `aria-hidden` dropped from the arrow  | fails the new contract test in `applicationShell.test.tsx` |

## The reveal window narrowed to 175px

> "I don't want to shorten the time. I want to shorten the length. It looks like its about 190 px
> wide on my current screen. I think 175 px would be a little better"

`.brand`'s `min-width`, 190px to 175px. The owner's measurement was exact -- that was the value.

Worth naming why this is a motion change and not only a size one: `.brand-wipe` clips to this box,
so the box _is_ the distance the incoming label travels. At 190px the arrow appeared at the far edge
well before its text followed it across, which is what read as "coming from somewhat far to the
right". Narrowing the window shortens the journey without touching the 180ms.

**A floor now guards it.** `app-bar-logo.spec.ts` asserts both panels' content fits the box, from
each panel's own `scrollWidth` rather than a pinned pixel figure -- so it stays correct if the
wordmark, the label or the type scale change, any of which moves where the real floor sits. The
panels are `position: absolute; inset: 0`, so `scrollWidth` equals the box until content actually
overflows, which is exactly the signal a truncation check wants.

Verified by sweeping the width rather than reasoning about it: **150px and 130px pass, 110px and
90px fail.** So the true floor is near 130px (the label "Return to project" plus its arrow is the
binding panel, not the wordmark), and 175px leaves roughly 45px of headroom. Anything tighter than
about 130px starts cutting real words and fails that spec instead of silently truncating.

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

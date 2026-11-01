# Three headers that claimed a parent they do not have

Three small corrections after `feature/app-bar-navigation` merged, all the same mistake in different
places: a breadcrumb asserting a hierarchy that does not exist.

> "On the manage subscriptions and deleted items pages, it shouldn't say projects before the page in
> the header. That doesn't make sense. It should just say 'Manage Subscription' or 'Deleted items'."

> "The compare revision page also still shows 'Projects/PROJECT NAME' even though the regular editor
> page doesn't."

## Why each was wrong, and why they are not the same fix

**`/deleted` and `/billing/subscription` are not inside anything.** Both are reached from the account
menu on every screen, not by descending from the dashboard. Each had been given a _fixed_ `Projects`
crumb precisely because it has no shared parent route to inherit one from -- which should have been
the clue: a route with no ancestor in the tree has no ancestor to name. Both the `staticData`
declaration and the rendered trail are gone; the brand still returns to the dashboard, so nothing
became unreachable.

**The comparison view is inside a screenplay**, and it inherited its ancestors from the `$projectId`
layout rather than declaring any. So only the rendered trail is removed here; the layout keeps its
declaration, because the project screen and the revision-history list both still render it. On this
view, as on the editor, the brand already returns to the screenplay's project -- so the project crumb
pointed exactly where the brand goes and the trail only repeated it.

That leaves `RouteBreadcrumb` used by two screens, both of which still earn it: the project screen
shows `Projects /` before the project's name, and the revision-history list shows
`Projects / <project> / <screenplay>` before "Revision history". The mechanism is not becoming dead
code.

## The nav landmark deliberately stays

`nav[aria-label="Breadcrumb"]` still wraps each page's own name, which carries `aria-current="page"`,
so a screen-reader user can still jump straight to "where am I" on a screen with no ancestors. The
first version of these tests asserted that landmark was _gone_ and failed for that reason. What must
not exist is a **link** claiming the page sits under another one, so the assertions target
`.breadcrumb-link` instead.

## Verification

All three are asserted as absences, so re-adding a trail fails a test before it reaches anyone.

| mutation                                     | result               |
| -------------------------------------------- | -------------------- |
| Deleted items trail + declaration back       | its route test fails |
| Manage Subscription trail + declaration back | its route test fails |
| Comparison view trail back                   | its route test fails |

**One of those assertions was vacuous and had to be fixed.** The comparison view declares no crumb of
its own, so only the rendered-trail check applies there -- and `routeState.matches` defaults to `[]`
in the harness, which makes `RouteBreadcrumb` render nothing whether the prop is passed or not. The
mutation passed. The test now populates a real match stack (the `$projectId` layout's own crumbs,
which this route sits beneath), and the mutation fails as it should. The two routes that _do_ declare
a crumb were never vulnerable to this, because they also assert
`Route.options.staticData?.breadcrumb` is `undefined`.

## And the revision-history list, plus the way back it needed

> "Lets include the revision history list page. Something else on that page that I want is a 'Back to
> screenplay' button... just aligned on the right side."

**These two are one change, not two.** On that page the brand points at the dashboard, and the
screenplay crumb was the only route back to the screenplay whose history was being read. Removing
the trail without adding the button would have stranded the reader, so they ship together.

It is also the reverse of a decision made one slice earlier: the app-bar pass _replaced_ this page's
original "Back to screenplay" link with a breadcrumb segment, on the reasoning that two affordances
saying the same thing was one too many. That reasoning held right up until the trail itself was
judged noise -- at which point the explicit control is the one worth keeping, because it says where
it goes.

Also removed: this route's `loader`, whose only consumer was that crumb's label.

The link is a router `Link`, not a button calling `navigate`: it is a navigation to a known route, so
it should open in a new tab and preview its destination on hover like every other link on these
screens. `.section-head` puts it on the heading's own row, right-aligned, aligned on `baseline`
rather than `center` -- the action is small text beside a much larger heading, and centring the two
boxes leaves it sitting visibly high.

| mutation                    | result               |
| --------------------------- | -------------------- |
| trail put back on this page | its route test fails |
| the Back link removed       | its route test fails |

### Two test failures worth recording, both mine

**An absence assertion that proved nothing.** Re-adding the breadcrumb prop passed the test, because
`routeHarness`'s `routeState.matches` defaults to `[]` and `RouteBreadcrumb` renders nothing from an
empty match stack regardless. The test now populates a real ancestor stack, and the mutation fails as
it should. The comparison view's own assertion, added earlier on this branch, had the identical fault
and the identical fix -- this has now happened four times across two sessions and is recorded in the
lead's own notes as a pattern to check for, not a one-off.

**A whole test file silently not running.** After the loader was removed, this page's suite errored
at collection, because a `describe` body still dereferenced `Route.options.staticData!.breadcrumb!`.
The summary read `Tests 1086 passed` with no `×` lines -- a collection failure produces none -- and
only the `Test Files 1 failed | 71 passed` line gave it away. Read that line, not just the test count.

### Still a difference from its siblings

The editor and the comparison view both put the _screenplay's_ name in the bar's title slot and the
view's kind in `documentType` ("Screenplay", "Comparison"). This page puts "Revision history" in the
title slot and declares no type, so with the trail gone nothing in the chrome names which
screenplay's history is on screen. The heading and the Back link both say "screenplay" generically.

Left alone deliberately -- changing it means reading the screenplay title in the component, which
needs a `useLoaderData` mock the harness does not have, and it is beyond what was asked. Recorded
because it is a real, if small, loss of orientation, and the fix that matches the siblings is
`documentTitle={screenplayTitle}` with `documentType="Revision history"`.

## The way back as a button, matching "Back to revisions"

> "Can we do 'back to screenplay' as a button rather than just a link? try doing it like the 'back to
> revisions' button"

`primary-button` instead of `text-button`, matching the comparison view's own way out -- which turns
out to be the ideal precedent, because **that control is also a router `Link` wearing
`primary-button`**, not a `<button>`. So this keeps link semantics (opens in a new tab, previews its
destination on hover) while looking like the button the owner pointed at. A `<button>` calling
`navigate` would give both of those up for nothing.

Two consequences in CSS, neither optional:

- **`align-items: center`, not `baseline`.** Baseline is right for a bare text link, which this was
  an hour earlier; for a padded filled control beside a 28px heading it hangs the button's box below
  the heading's baseline so it reads as sitting low. Measured: 5.5px off a shared centre line.
- **The heading's `margin: 8px 0 28px` moved to the row**, with the heading zeroed inside it. In a
  flex row those margins remain part of the heading's box, so centring against them pushes the
  button upward by half the 28px. Hoisting keeps the page's vertical rhythm identical to the version
  that had no button at all.

### Measured, because none of this is visible to jsdom

`apps/web/e2e/section-head-action.spec.ts` asserts, in real Chromium: the action's right edge meets
the row's; it begins after the heading ends; both share a row; their centres agree within a pixel;
the control has a real fill rather than being transparent; and the 28px of rhythm below the row is
applied once, not twice or not at all.

| mutation                                 | result                           |
| ---------------------------------------- | -------------------------------- |
| `baseline` alignment restored            | fails: 5.5px off centre          |
| `justify-content: space-between` removed | fails: 309px of gap at the right |
| the heading's own margin left in place   | fails: 10px off centre           |

**A mutation of mine that lied, worth recording.** The `justify-content` mutation first appeared to
pass. The replacement string `align-items: center;\n  justify-content: space-between;` occurs seven
times in `styles.css`, and an unguarded `.replace(..., 1)` edited the first one -- a different rule
entirely. `.section-head` was never touched, so the spec passed correctly and the _mutation_ was the
broken thing. Scoped to the `.section-head` block it fails as it should. Every mutation script needs
its match asserted, and a count of exactly one.

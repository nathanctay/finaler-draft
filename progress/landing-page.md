# A landing page to give Stripe

Branch `feature/landing-page`, worktree `/Users/nathan/Documents/finaler-draft-worktrees/landing`,
off `a146d04` (current `main`).

## Why this scope exists

Stripe account activation and tax setup require a URL showing what is sold, at what price, with
terms and a refund policy. The product itself is not deployed yet, and collaboration ships before
it does (see the memory note on the roadmap) -- so this is a "coming soon" page, not the finished
marketing site, and it is the first non-Vite app in this workspace.

The name and domain are both provisional. Nothing about that could be worked around; it had to be
designed for, which is most of what shapes the structure below.

## What shipped

**`apps/landing`** -- a static Astro 5 app (`output: 'static'`, no adapter, no server, no API
call). `pnpm-workspace.yaml` already globs `apps/*`, so it needed no workspace wiring beyond that.

**Configuration, not literals** (`apps/landing/src/site.config.ts`):

- `PRODUCT_NAME = 'Finaler Draft'` -- the one literal, exactly where the brief asked for it.
- `TAGLINE` -- the owner's exact sentence, unchanged.
- `APP_ORIGIN` and `SITE_URL` -- read from `PUBLIC_APP_ORIGIN` / `PUBLIC_SITE_URL` at build time
  (`import.meta.env`, Astro's own convention for env values a page may need), each validated to be
  a bare origin (`new URL(...)`, reject anything carrying a path/query/hash) with a local-dev
  fallback so `astro dev` / `astro build` work with no `.env` file. A malformed value throws at
  build time rather than silently shipping a broken link.
- `PRICE_MONTHLY` / `PRICE_ANNUAL` -- `{ amount: 500, currency: 'usd', interval: 'month' }` /
  `{ amount: 5000, currency: 'usd', interval: 'year' }`, the owner's figures, exclusive of tax
  (the pricing card says so explicitly; Stripe Tax adds the real amount at checkout per plan.md).

Every "Sign in" link (`Header.astro`, the Pro card's CTA in `PricingTable.astro`) reads
`APP_ORIGIN`; nothing hardcodes a domain. The header's monogram (`{PRODUCT_NAME[0]}`) and the
generated favicon (`src/pages/favicon.svg.ts`, a build-time route, not a static file under
`public/`) both derive the same initial from `PRODUCT_NAME` rather than baking in "F" as a
separate literal -- a static SVG favicon would have been exactly the kind of stale artifact a
rename search-and-replace exists to catch.

**A rename plus a domain purchase touches exactly:** `PRODUCT_NAME` in `site.config.ts`, and the
two Railway environment variables (`PUBLIC_APP_ORIGIN`, `PUBLIC_SITE_URL`) on the two services.
Nothing in `src/pages`, `src/components`, or `src/styles` needs to change.

**Legal pages** (`src/content.config.ts`, `src/pages/legal/[slug].astro`,
`src/lib/legalNav.ts`): a content collection (`legal`) globbing Markdown files with frontmatter
out of `src/content/legal/`, currently empty (`.gitkeep` only -- no LLM-drafted terms, refund
policy, or privacy policy; see "What I did not write" below). `[slug].astro`'s `getStaticPaths`
builds one static page per entry that exists, so an empty collection means the URL genuinely does
not exist rather than existing and saying nothing. `legalNavItems` is the single function that
turns whatever exists into footer links -- both the page-generation side and the footer-linking
side read the same collection, so there is exactly one place "no content -> no link" is decided.

**Visual language** (`src/styles/global.css`): a token set related to, but independent of,
`apps/web/src/styles.css` -- same font (IBM Plex Sans, via `@fontsource/ibm-plex-sans` as this
app's own dependency), the same near-black-blue header and teal-green accent family, a square
monogram matching `.brand-mark`'s shape. Dark mode follows `prefers-color-scheme` rather than a
stored toggle, since this page carries no per-user state to remember one in. None of the app's own
2500-line stylesheet is imported.

**Pages**: `index.astro` (hero with a "Coming soon" eyebrow, the tagline, an honest description of
what ships today's plan describes -- proper formatting, a keyboard-driven writing flow, PDF/FDX/
DOCX export -- and the pricing table), `legal/[slug].astro` (renders when content exists),
`favicon.svg.ts` (generated), `public/robots.txt` (static, `Allow: /`). `Layout.astro` owns
`<Header>` / `<Footer>` and the metadata: canonical link, OpenGraph and Twitter-card tags, a skip
link, proper landmark structure (`header` / `main` / `footer`), single `h1` per page.

**Pricing copy** is drawn directly from plan.md's "The free tier" section, not invented: one fully
editable screenplay with the complete authoring toolkit and export included on the free tier,
collaboration on a shared screenplay occupying that same one editable slot, Pro removing the
one-screenplay limit. No feature is claimed that plan.md does not already specify.

## What I did not write, and what the owner still owes

**No terms of service, refund policy, or privacy policy.** `src/content/legal/` holds nothing but
a `.gitkeep`. This is the blocker for the actual Stripe submission -- the page, the routing, and
the "don't link to nothing" mechanism are all built and tested, but Stripe still needs real,
owner-supplied copy in at least a terms-of-service and a refund-policy document before account
activation can complete. Dropping that copy in is exactly one Markdown file per document with a
`title` and `updatedOn` frontmatter field, placed in `src/content/legal/`; nothing else in the app
changes. This is a build limitation report, not a build defect.

## Tooling friction (this is the first non-Vite app in the workspace)

**`pnpm typecheck` is a manual filter chain, not `pnpm -r typecheck`.** Root `package.json`'s
`typecheck` script names every workspace member by `--filter` rather than running recursively, so
a new app is invisible to it by default. Added
`&& pnpm --filter @finaler-draft/landing typecheck` to the end of that chain. `landing`'s own
`typecheck` script is `astro check` (via `@astrojs/check`), not `tsc` directly -- plain `tsc`
cannot parse `.astro` files' template syntax; `astro check` is Astro's own language-server-backed
checker and is the standard substitute.

**`eslint.config.js` needed a real `.astro` block, not an ignore.** Added `eslint-plugin-astro`
(pinned to **1.7.0**, not latest) so `.astro` files parse and lint, plus a small block giving that
parser `tseslint.parser` for the frontmatter script and `extraFileExtensions: ['.astro']`. Latest
`eslint-plugin-astro` (3.x) requires ESLint >=10 and `typescript-eslint` >=8.61.0; this workspace
pins ESLint 9.34.0 and `typescript-eslint` 8.41.0, and bumping either for one new app was out of
scope and risky for the existing apps. 1.7.0 only requires ESLint >=8.57.0 and has no
`typescript-eslint` floor, so it installs with zero peer warnings against what's already pinned.
Left `flat/jsx-a11y-recommended` out: it hard-requires the separate `eslint-plugin-jsx-a11y`
package (ESLint refused to load the config without it -- "Key `jsx-a11y`: Expected an object"),
which is one more dependency and peer surface for a single app's worth of `.astro` files;
accessibility here was instead reviewed by hand (landmarks, heading order, focus-visible, a skip
link, `aria-label`s on icon-only controls).

**Prettier needed `prettier-plugin-astro`.** Added it plus an `overrides` entry in the root
`.prettierrc.json` mapping `*.astro` to the `astro` parser -- without it, `.astro` files either go
unformatted or fail to parse under Prettier's default parser inference. Four files needed one
`prettier --write` pass after being hand-written against the plugin's actual output style.

**Astro 7 (the current npm `latest`) does not work with this workspace's pinned `vitest@3.2.4`.**
Astro 7 depends on `vite@^8.0.13`; `vitest@3.2.4`'s own dependency range is
`^5.0.0 || ^6.0.0 || ^7.0.0-0` -- it does not accept vite 8 at all. Pinned `astro` to **5.18.2**
instead (vite `^6.3.6`, inside vitest's accepted range) rather than bumping the workspace's vitest,
which is shared by every other app and package and was out of scope to touch for one new app.

**Even on Astro 5, two `vite` majors coexist in the tree** -- `apps/web` pins `vite@7.1.3`
directly; Astro 5's own dependency resolves a separate `vite@6.4.3` for `apps/landing`. pnpm
installs both as distinct packages, so `vitest/config`'s `declare module 'vite' { interface
UserConfig { test?: ... } }` augmentation (needed for `vitest.config.ts`'s
`getViteConfig({ test: {...} })` pattern, which is Astro's own documented way to let Vitest import
`.astro` files and `astro:content`) lands on the `vite@7.1.3` copy, not the `vite@6.4.3` copy
`getViteConfig`'s own type signature is written against -- two structurally identical but
nominally distinct copies of the same interface. This is a real, if narrow, type-checking false
positive from the workspace's existing vite pin, not a defect in the config; the object is a valid
Vite test config at runtime either way (`astro check` and every test both confirm this). Resolved
with a single, fully-commented `@ts-expect-error` on that one property in `vitest.config.ts` --
narrower and more honest than excluding the file from typecheck, and it stops working (a real
future error there gets caught again) the moment the versions are ever unified.

**`pnpm check:bundle-budget` is unaffected** -- it already filters to
`pnpm --filter @finaler-draft/web build` specifically and reads only `apps/web/dist`'s manifest;
a second app changes nothing about what it measures. Confirmed by running it after `apps/landing`
existed: same three budgets, same numbers as before this branch.

**`pnpm test` (`pnpm -r test`) silently skips a package with no `test` script.** Confirmed by
running it across the whole workspace: `apps/landing` (which does have a `test` script) reported
its own 21 tests in the output; packages that define no `test` script at all (several under
`packages/`) produced no output and no error for that script, and the overall run still exited 0.
This is pnpm's documented default for `-r <script>` -- no `--if-present` flag was needed. Handled
deliberately by giving `apps/landing` a real `test` script rather than relying on that skip
behavior to paper over having none.

## Tests, and what each mutation caught

Proportionate to a static page, per the brief: pure-function unit tests for the data layer, plus
one Astro Container API render test per template-wiring seam that a unit test on the data alone
could not catch.

- **`src/site.config.test.ts`** (8 tests) -- `PRODUCT_NAME`/`TAGLINE` literals, `APP_ORIGIN`/
  `SITE_URL` fallback and override behavior (via `vi.stubEnv` + `vi.resetModules` + dynamic
  re-import, since these are module-load-time constants), and that a malformed or path-carrying
  origin throws instead of silently normalizing.
- **`src/lib/money.test.ts`** (5 tests) -- `formatPrice`/`formatPricePerInterval` against fixed
  amounts and against the real configured `PRICE_MONTHLY`/`PRICE_ANNUAL`.
- **`src/lib/legalNav.test.ts`** (3 tests) -- empty input produces an empty list, non-empty input
  sorts by id and builds the expected trailing-slash href, the input array is not mutated.
- **`src/pages/index.render.test.ts`** (3 tests) -- renders the real `index.astro` through
  `experimental_AstroContainer`, asserting the configured prices appear in the actual HTML, every
  `http(s)://` link on the page is either the canonical URL or `APP_ORIGIN` (never a stray
  literal), and the product name / tagline render exactly once as the `h1` / subheading.
- **`src/components/Footer.render.test.ts`** (2 tests) -- renders the real `Footer.astro` against
  the real (empty) `legal` collection, asserting no `legal-nav` and no `/legal/` link appear, and
  that the copyright line still renders.

**Six manual mutations, each reverted and confirmed byte-identical against the original
(`diff` after restoring from a backup copy) before moving to the next:**

1. `legalNavItems` always appending a phantom `{ id: 'terms', title: 'Terms' }` entry -- caught by
   both the empty-input unit test and the Footer render test.
2. `formatPricePerInterval` swapping its `/month` and `/year` suffixes -- caught by the "renders
   the configured monthly and annual prices exactly as this site displays them" test.
3. `site.config.ts`'s `readOrigin` dropping the path/query/hash rejection -- caught by exactly the
   one test written for it, no collateral failures elsewhere.
4. `Header.astro`'s "Sign in" link hardcoded to `https://example.com` instead of `{APP_ORIGIN}` --
   caught by the render test's "every link points at the configured origin" assertion.
5. `PricingTable.astro`'s Pro price hardcoded to `$1.00/month` instead of `{monthly}` -- caught by
   the render test's price assertion.
6. `Footer.astro`'s `legalLinks.length > 0 &&` guard removed, so an empty `<nav class="legal-nav">`
   renders even with zero legal documents -- caught by the Footer render test. This is the
   mutation closest to the brief's central constraint ("do not link to a page that says nothing"),
   and it is the one the tests were most deliberately built to catch.

## Gates

```
pnpm lint             -- clean, exit 0
pnpm format:check      -- exit 0 (after `prettier --write` on 4 hand-written files against
                           prettier-plugin-astro's actual output style)
pnpm typecheck         -- exit 0 (after fixing one real noUncheckedIndexedAccess strict-mode gap
                           in index.render.test.ts -- a regex capture group typed
                           `string | undefined`, not previously narrowed)
pnpm test              -- exit 0; apps/landing: 5 files, 21 tests passed; apps/web: 43 files, 645
                           tests passed; apps/api: 12 files (+3 skipped integration files), 215
                           tests passed (+40 skipped); every other workspace package unchanged.
                           No existing assertion was weakened or removed.
pnpm check:bundle-budget
                       -- exit 0; unaffected -- entry 111.65 kB/120 kB, lazy editor 115.58 kB/200
                          kB, CSS 6.31 kB/20 kB, same as main.
```

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' ".../.env" | cut -d= -f2-)" pnpm test:system:persistence
                       -- exit 0; 18/18 passed. Confirms the new static app changes nothing about
                          the real-database browser suite, as expected -- it touches no route, no
                          API, and nothing apps/web serves.
```

## Known limitations

- No Railway service exists yet for `apps/landing`; deploying it as its own service on the apex
  domain, alongside the existing API/web service on `app.`, is follow-up work outside this branch.
- `robots.txt` has no `Sitemap:` line -- no sitemap is generated. Worth adding once the domain is
  real; not needed for a single-route "coming soon" page today.
- Legal-document content is the owner's to write (see above) -- this is the one real blocker for
  the actual Stripe submission, and it is not something this branch could or should have worked
  around.

## Follow-up: dark-mode header contrast, a neutral app link, and a build-breaking test location

The owner reviewed the page and reported the header unreadable in dark mode, and asked for the
"Sign in" links to become session-agnostic. Both are fixed. Fixing the first also surfaced a real,
independent defect this branch had already shipped: `astro build` itself was broken, silently,
since the first render tests were added, and had never been re-run after that.

### The token bug

`apps/landing/src/styles/global.css`'s dark-mode block redefined `--text-inverted` to the exact
same value as `--surface-inverted` (`#101820`), so `.site-header`'s text painted in its own
background colour, and -- because `.button-ghost`'s `border-color: currentColor` inherits
whatever `color` resolves to -- the header's "Open app" button lost its border along with it.
Light mode was unaffected; the two tokens only collided in the dark-mode override.

**Renamed both tokens**: `--surface-inverted` -> `--surface-chrome`, `--text-inverted` ->
`--text-on-chrome`. The name was carrying real weight in the wrong direction: "inverted" reads as
"flip this in dark mode," which is the correct instruction for every _other_ token pair in this
file (they all do exactly that), but wrong for this one pair, whose entire purpose is a fixed dark
chrome bar that does _not_ invert with the scheme -- only `--surface-chrome`'s own shade may still
shift slightly per scheme (kept at `#101820` in dark mode, a deliberate, harmless choice, not the
bug), while its paired text/border colour must not. Renaming to a role ("chrome"), rather than a
scheme-relationship word ("inverted"), removes the ambiguity that produced the mistake -- the new
name gives no instruction to invert anything. Did not rename any other token: none of the
remaining pairs have this same "genuinely fixed regardless of scheme" property, so `--text-on-*`/
`--surface-*` elsewhere would be a stylistic rename with no defect behind it, which the owner
explicitly said not to do.

**Fix, mechanically**: removed `--text-on-chrome`'s dark-mode redefinition entirely, so it falls
through to its `:root` value (`#f4f7f8`) in both schemes -- the token is not redefined in the dark
block at all now, with a comment there pointing back to why. Verified in the compiled CSS
(`dist/_astro/*.css`) that the dark-mode `@media` block no longer contains `--text-on-chrome`.
Checked every consumer, not only `.site-header`'s own `color` line: `.skip-link` uses the same two
tokens identically (same fix covers it); `.brand`, `.brand-mark`, and `.site-nav a` all inherit
`color` from `.site-header` rather than setting their own, so they were never separately broken and
needed no separate fix; `.button-ghost`'s `border-color: currentColor` now resolves correctly as a
direct consequence of the `color` fix, with nothing to change in that rule itself.

### The neutral app link

The owner chose one neutral label over any form of session detection (he was offered a
credentialed cross-origin fetch, a non-sensitive hint cookie, or nothing, and chose nothing).
**Chosen label: "Open app."** It reads naturally as a nav item next to "Pricing," as a primary
hero CTA, and (composed as `"Open app to upgrade"`) as the Pro card's CTA -- and it is accurate
regardless of session state, because the app itself already routes a visitor to sign-in or to
their dashboard depending on whether one exists.

Added `APP_LINK_LABEL = 'Open app'` to `site.config.ts` as the single source, used by all three
call sites (`Header.astro`'s nav, `index.astro`'s hero button, `PricingTable.astro`'s Pro CTA --
the last composes it with a `" to upgrade"` suffix rather than duplicating a second literal).
`APP_ORIGIN`'s own doc comment now records, for whoever next considers detection: the apex and
`app.` subdomains remain different **origins** even once both are deployed on the same registrable
domain. A cookie scoped to `.example.com` would be readable from both (same registrable domain),
but a `fetch` from this static site to the app's API would still need CORS (different origins) --
same registrable domain does not make a credentialed request free, and this app does neither.

### A real defect this surfaced: `astro build` was broken

Setting up a browser test (below) meant actually running `astro build` again for the first time
since the render tests were added -- and it failed outright:
`Vitest failed to access its internal state`, thrown from inside Astro's own static-build page
discovery. Cause: `src/pages/index.render.test.ts` lived inside `src/pages/`, which Astro treats
as its page-routing directory and scans (importing every file to check whether it is a valid page
or endpoint) as part of every build. Evaluating a file that imports `vitest`'s `expect` outside of
a running Vitest process throws immediately, and that import happened even though the file exports
nothing routable. None of the gates run so far had caught this: `pnpm typecheck` runs `astro
check`, not `astro build`; `pnpm test` runs `vitest run`, not `astro build`; `pnpm
check:bundle-budget` and `test:system:persistence` never touch `apps/landing` at all. **The
production build itself was never exercised by any gate this branch had run**, and had been silently
broken since the render tests were added.

**Fix**: moved the file to `apps/landing/src/pageTests/index.render.test.ts` -- a sibling of
`src/pages/`, not a subdirectory of it (a `__tests__` folder _inside_ `src/pages/` would have the
identical problem: Astro's page scanner recurses). `Footer.render.test.ts` was never affected --
it already lived in `src/components/`, outside the routing tree. Re-ran `astro build` clean
afterward and confirmed `dist/` has the expected static shape (`index.html`, `favicon.svg`,
`robots.txt`, no server artifacts) rather than the SSR-shaped output the broken build had started
producing (`chunks/`, `manifest_*.mjs`, `renderers.mjs`) when it got far enough to write anything.

This is reported as what it is: a real defect in the original delivery, not a consequence of this
round's changes, caught only because this round happened to need a working `astro build`.

### The browser contrast test

**Judged proportionate, and added one.** jsdom has no computed styles worth trusting, so this is
exactly the class of defect this repo has already built real-browser infrastructure for five times
over in `apps/web/e2e/app-shell.spec.ts` (the not-saving dot, the disabled button, the read-only
banner, and others) -- the owner pointed at that precedent directly, and the reasoning transfers
without modification: a unit or Container-API render test asserting a class name or even the raw
CSS custom-property _source_ would have passed while this defect shipped, because the bug was in
what two properties independently _resolved to_ in a real browser, not in any class or attribute a
non-browser test can see.

**New**: `apps/landing/e2e/header-contrast.spec.ts`, two assertions per colour scheme (light and
dark, via `test.use({ colorScheme })`) -- the header's resolved text colour differs from its
resolved background, and the "Open app" button's resolved border colour differs from that same
background (the second assertion exists because `border-color: currentColor` is a second consumer
of the same token that a fix touching only `.site-header`'s own `color` could still leave broken).

**Wiring, since apps/landing had no browser-test setup of its own**: `playwright.config.ts`'s
`webServer` became an array (Playwright supports this) with a second entry --
`pnpm --filter @finaler-draft/landing build && pnpm --filter @finaler-draft/landing exec astro
preview --host 127.0.0.1 --port 4322` -- and a second `projects` entry (`name: 'landing'`) with
its own `testDir: './apps/landing/e2e'` and `baseURL`. The build-then-preview command is
self-contained deliberately: the root `build` script does not build `apps/landing` (documented
above), so the landing project's own webServer command builds it itself rather than depending on
that chain growing to include it.

**One real friction hit while wiring this**: `astro preview`'s default `--host localhost` bound
the server to `::1` only on this machine -- `curl http://127.0.0.1:4322` failed while
`curl http://localhost:4322` succeeded -- so Playwright's plain-IPv4 readiness probe against the
configured `url` timed out at 60s against a server that was, in fact, already up. Fixed with an
explicit `--host 127.0.0.1` on the preview command; this is now recorded in a comment on that
`webServer` entry so it isn't rediscovered the hard way again.

Confirmed the existing `chromium` project is unaffected: `playwright test --project=chromium
--list` still resolves the same 36 tests across the same 4 files as before this edit.

**Mutation tested**: restored `--text-on-chrome: #101820;` inside the dark-mode block (the exact
original defect, byte-for-byte), rebuilt, and re-ran `playwright test --project=landing`. Both
light-mode tests stayed green; both dark-mode tests failed, with the reported value on both sides
of the failing assertion (`rgb(16, 24, 32)`) -- the precise shape of the original bug. Reverted and
confirmed byte-identical restoration via `diff` against a backup taken before the mutation.

### Tests added this round

- `apps/landing/src/site.config.test.ts`: one new test asserting `APP_LINK_LABEL` is exactly
  `'Open app'` and matches neither `/sign in/i` nor `/dashboard/i`.
- `apps/landing/src/pageTests/index.render.test.ts` (relocated, see above): one new render test
  asserting the label appears exactly twice verbatim (the header and hero links) plus once more
  composed with `" to upgrade"` (the Pro CTA), and that the rendered page contains neither "Sign
  in" nor "Dashboard" anywhere. The existing "every link points at `APP_ORIGIN`" test's expected
  count moved from `>= 2` to `>= 3` -- the hero's own button was always a third app link that
  test's own comment had simply never enumerated.
- `apps/landing/e2e/header-contrast.spec.ts` (new file, see above): 4 tests (2 assertions x 2
  colour schemes).

### Gates, this round

```
pnpm lint              -- exit 0
pnpm format:check       -- exit 0 (no reformatting needed this round)
pnpm typecheck          -- exit 0
pnpm test               -- exit 0; apps/landing: 5 files, 23 tests passed (was 21; +1 in
                           site.config.test.ts, +1 in the relocated index.render.test.ts); apps/web
                           645, apps/api 215 (+40 skipped integration) -- both unchanged.
pnpm check:bundle-budget
                        -- exit 0; unaffected, same three numbers as before.
```

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' ".../.env" | cut -d= -f2-)" pnpm test:system:persistence
                        -- exit 0; 18/18 passed, unaffected.
```

```
playwright test --project=landing
                        -- exit 0; 4/4 passed (not one of the brief's original five gates, but the
                           new test this round added -- see mutation-testing note above for the
                           failing run against the reintroduced defect).
```

## Follow-up: content, the pre-launch app link, and a browser-test fix

The page read as bare -- essentially a name, a tagline, and a price. This pass writes the content,
makes the app link (and everything that depends on the app existing) conditional on configuration
rather than a hardcoded assumption, and fixes a real regression the conditional link caused in the
browser suite from the prior round.

### Claims: what the page says, and where each one comes from

Every capability claim was checked against the owner's own source-verified list, not invented or
drawn from a competitor's vocabulary. Nothing in `ProductOverview.astro`'s feature list or
`StatusSection.astro`'s built/planned split names anything not on that list.

**Hero** (`index.astro`): keeps `TAGLINE` verbatim. Adds one lede sentence naming what the product
_is_ -- "a screenwriting application: a structured editor for real screenplay elements, correct
pagination, and exports that hold up" -- because the tagline alone doesn't say that to someone
outside the project.

**"What it does"** (new `ProductOverview.astro`, section id `product`): leads with
differentiation (a structured editor with real elements, not a generic document with formatting
applied) and interchange (FDX), before any feature list. A dedicated "product commitment"
paragraph restates plan.md's free-tier export principle in this page's own words -- not a direct
quote of plan.md's "hostage situation" phrase, but the same idea: a screenwriting tool you can't
get your own pages out of isn't offering a free tier at all. The feature list (`<dl>` of eight
term/description pairs) maps one-to-one to the owner's "built and working today" list: structured
elements, keyboard-first authoring, deterministic pagination, SmartType, Navigator, title
pages/scene numbers/document settings, zoom/page views, export. Accounts/projects/soft-delete and
subscriptions are real but were left out of this list deliberately -- account-management plumbing
a visitor already expects a SaaS product to have, not a differentiator worth a line.

**Pricing** (`PricingTable.astro`): the Free card's collaboration bullet from the prior round was
removed. plan.md's free-tier text describes collaboration as part of the _designed_ free tier, but
collaboration is not built yet, and this round's brief was explicit that only shipped capabilities
belong in claims -- pricing bullets are exactly the kind of unmarked, undifferentiated list a
planned feature must not appear in (see the "planned items" note below). The intro line now states
plainly that free is a real tier, not a trial: "one full screenplay, the whole authoring toolkit,
export included."

**Status** (new `StatusSection.astro`, section id `status`): one honest paragraph that the product
is in active development and not yet deployed -- no invented launch date. Names exactly one
planned feature: real-time collaboration, built on Yjs, marked with a visually distinct "Planned"
badge (`.planned-item`/`.planned-badge`, styled with a dashed border and an accent-coloured pill,
unlike anything in the shipped feature list). Revision history and FDX import were considered and
cut: revision history has no comparable near-term commitment to point to, and FDX import is the
single claim most likely to draw a direct "does it import from Final Draft?" from exactly the kind
of visitor this page is written for -- fewer, better-supported claims over a complete roadmap dump,
per the brief's own instruction.

### What I was tempted to claim and cut

- **"No watermark, no time limit" on free-tier export.** The owner's shipped list confirms export
  itself works on every tier; it says nothing about watermarking or time limits. Asserting their
  _absence_ would have been inventing a claim about something never confirmed either way. Cut in
  favor of the plainer claim actually sourced: export ships free, full stop.
- **Revision history**, mentioned above -- cut for the same "no comparable timeline" reason
  collaboration was kept in.
- **FDX import**, likewise -- the owner said to leave it out entirely rather than disclose it as a
  gap, and that is what shipped: it is not named anywhere on the page, not even as a "not yet"
  line.
- **Any specific launch date.** Not written, not implied by a countdown or a season name -- "in
  active development and not yet deployed" is the entire claim.

### The app link, made conditional

`site.config.ts` gained `APP_IS_LIVE` (env `PUBLIC_APP_IS_LIVE`, parsed by a new `readBoolean`
helper alongside the existing `readOrigin`), **defaulting to `false`**. That default is the point:
the owner intends to deploy this site before the app exists specifically to have a URL for Stripe,
so an unset flag must never be read as "live." Every place that used to link unconditionally to
`APP_ORIGIN` now checks it first:

- `Header.astro`: the nav's app link renders only when `APP_IS_LIVE`; otherwise the nav is just
  "Pricing."
- `index.astro`'s hero: the primary "Open app" button is present only when live; "See pricing"
  becomes the hero's sole (and now primary-styled) action otherwise, rather than a hero with one
  dead button and one live one.
- `PricingTable.astro`'s Pro card: the CTA link becomes a plain, non-interactive
  `<p class="plan-note">Available when the app launches.</p>` when not live -- replaced with
  honest copy, not just removed, so the card doesn't look broken with no action at all.

**The tie-in the brief asked me to consider**: whether "the same configuration that controls the
pre-launch state" could also control planned-feature presentation, rather than relying on a human
to remember to update copy at cutover. `APP_IS_LIVE` now does both jobs. The hero's "Coming soon"
eyebrow and the entire `StatusSection` (which is where the one planned feature, collaboration, is
named) are both gated on `!APP_IS_LIVE` in `index.astro`, with a comment on each explaining why:
collaboration ships _before_ this app is deployed, so by the time `APP_IS_LIVE` could ever be
true, calling it "planned" would already be false. Rather than leave that stale claim rendered
forever after cutover, the whole section disappears with the banner the moment the flag flips --
a missing section is a loud, visible prompt for whoever deploys the app to add real "what's next"
copy if there is any; a stale claim silently left in place is not. Verified both directions with a
real `astro build`: default config renders no app links, "Coming soon," and the Status/Planned
section; `PUBLIC_APP_IS_LIVE=true PUBLIC_APP_ORIGIN=https://app.example.com` renders three
`https://app.example.com` "Open app" links and none of the pre-launch copy.

### The Playwright regression this caused, and the fix

Gating the header's "Open app" button on `APP_IS_LIVE` (default `false`) meant the button no
longer exists in the DOM the landing preview serves by default -- and `header-contrast.spec.ts`'s
border-colour assertion, written when the button always rendered, had nothing left to measure.
`playwright test --project=landing` went from 4/4 to 2 passed / 2 failed, both the border check,
in both colour schemes. This was caught, not self-diagnosed: a session interruption left the
mutation-testing pass for the app-link guard mid-flight, and the coordinator both restored the
in-progress mutation revert and ran the browser suite to confirm the regression.

**Fix, matching the coordinator's suggested split**: `playwright.config.ts`'s `landing` webServer
command now builds with `PUBLIC_APP_IS_LIVE=true` --

```
PUBLIC_APP_IS_LIVE=true pnpm --filter @finaler-draft/landing build && pnpm --filter @finaler-draft/landing exec astro preview --host 127.0.0.1 --port 4322
```

-- giving `header-contrast.spec.ts` a real button to measure again. This is deliberate, not the
site's actual default: the browser suite's whole reason to exist is measuring _computed colour_,
which only exists when there's an element to compute it on, while the complementary case -- no
link at all while `APP_IS_LIVE` is false, the state this site actually ships in -- is already
covered at the render layer, where an element's _absence_ is trivial to assert without a browser
(`index.render.test.ts`'s "renders no link to the app while APP_IS_LIVE is false" test, added this
round). Each layer tests what it's good at, rather than the browser project trying to special-case
a state its own assertions have nothing to check.

Did not delete or skip the border assertion, per the coordinator's explicit instruction -- it is
the exact seam (`.button-ghost`'s `border-color: currentColor`) that made the original dark-mode
bug bite two things instead of one, and remains real coverage of that inheritance path.

**Verified end-to-end, both directions**: rebuilt with the fixed command, `playwright
test --project=landing` -- 4/4 passed (both colour schemes, both the text-colour and border-colour
assertions). Then reintroduced the original token bug
(`--text-on-chrome: #101820;` inside the dark-mode block, byte-identical to the first round's
defect) and reran: both dark-mode tests failed, both light-mode tests stayed green, confirming the
fixed pipeline still catches the regression it exists to catch. Reverted and confirmed
byte-identical restoration via `diff`. Confirmed `--project=chromium --list` still resolves the
same 36 tests across 4 files, unaffected by the `webServer` command change.

### Tests added this round

- `site.config.test.ts`: `APP_IS_LIVE` defaults to `false` when unset; `readBoolean` parses
  `true`/`1`/`false`/`0` (case-insensitive) correctly; throws on an unrecognized value (`"yes"`).
- `index.render.test.ts`: rewritten to match the new content and the conditional link. The load-
  bearing one -- "renders no link to the app while APP_IS_LIVE is false, and says so honestly
  instead" -- opens with `expect(APP_IS_LIVE).toBe(false)` as a precondition (not a false-positive
  guard: if a future default ever flipped this to `true`, the test would silently stop testing
  what its name says it tests, so it asserts the precondition instead of assuming it), then checks
  no `href` starts with `APP_ORIGIN`, `APP_LINK_LABEL` never appears, and the Pro card's honest
  substitute text does. A second new test confirms "Coming soon" and the "Planned" /
  "Real-time collaboration" status render together, and that "revision history" and "FDX import"
  do not appear anywhere on the page.
- `header-contrast.spec.ts`: unchanged in content: the fix was in how its webServer builds, not in
  the spec itself.

Landing unit suite: 23 -> 31 tests (5 files, unchanged file count). Mutation-tested the app-link
guard directly (not just observed via the coordinator's confirmation): reverted `Header.astro`'s
`APP_IS_LIVE &&` guard to an unconditional render, reran `index.render.test.ts` -- the "renders no
link" test failed with the exact shape of the regression (`expected true to be false`); reverted.

### Gates, this round

```
pnpm lint              -- exit 0
pnpm format:check       -- exit 0
pnpm typecheck          -- exit 0
pnpm test               -- exit 0; apps/landing: 5 files, 31 tests passed (was 23); apps/web 645,
                           apps/api 215 (+40 skipped integration), packages/layout 72, packages/pdf
                           61 -- all unchanged.
pnpm check:bundle-budget
                        -- exit 0; unaffected, same three numbers as every prior round.
```

```
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' ".../.env" | cut -d= -f2-)" pnpm test:system:persistence
                        -- exit 0; 18/18 passed, unaffected.
```

```
playwright test --project=landing
                        -- exit 0; 4/4 passed after the webServer fix (was 2 passed / 2 failed
                           immediately after the app-link change, before the fix -- see above).
```

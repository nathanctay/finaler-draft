# Scope: design-tokens

Branch: `chore/design-tokens`
Worktree: `/Users/nathan/Documents/finaler-draft-worktrees/design-tokens`
Base: `main` @ `0ecdc42`
Owner: Sonnet implementation agent, advised by the lead.

## Why this scope exists

`plan.md` requires, under Phase 0: "Establish product shell/design tokens", and under the interface
direction: "Build a small design-token and component system from the product shell outward. Do not
adopt an unmodified Tailwind/shadcn visual language."

That system was never built. `apps/web/src/styles.css` is 746 lines with **zero CSS custom
properties** and **93 distinct colour literals** (91 hex, 2 `rgba`). Measured breakdown:

| Family       | near-white | light | mid | dark | near-black |
| ------------ | ---------- | ----- | --- | ---- | ---------- |
| green / teal | 13         | 12    | 4   | 8    | 2          |
| blue         | 2          | 10    | 7   | 11   | 7          |
| neutral grey | 3          | 1     | 10  | 1    | 0          |

Eighteen near-identical off-whites (`#f5f6f6`, `#f7f8f8`, `#f6fafb`, `#f4f7f8`, `#eef0f1`,
`#e8ebec`, `#e9eff1`, …) is the signature of values picked by eye rather than from a palette. This
is drift already in progress, and it is the mechanism by which the interface ends up looking
generic. The aesthetic itself is good and must not change.

## What is NOT in scope, deliberately

**Do not tokenise the type scale, the spacing scale, or border radius.** They are already
disciplined: eight font sizes across 746 lines, and radius values of only `1px`, `2px`, and the two
intentional `50%` circles. Tokenising them would be churn with no benefit and would bloat a diff
whose value lies entirely in colour. If a later branch finds real drift there, it can revisit.

This branch is colour tokens, the two elevation shadows, and one new semantic colour. Nothing else.

## Acceptance criteria

### 1. A token layer defined once, in CSS

- CSS custom properties on `:root`, in `apps/web/src/styles.css`. Not a TypeScript token module:
  the stylesheet is the design system and must stay the single source.
- Name tokens by **role, not by value**. `--surface-panel`, not `--green-100`. A token named for its
  colour is a rename waiting to happen the first time the palette shifts.
- Keep the set small. Aim for roughly 15-25 tokens. If a token is used once, it probably should not
  exist yet.

Cover at minimum: page and panel surfaces, raised and sunken surfaces, border subtle / default /
strong, text primary / secondary / muted / inverted, the accent and its hover state, the focus ring,
and the two existing shadow values.

### 2. Every colour literal is replaced by a token

- No bare hex or `rgba()` remains in a rule body. The only literals left are the token definitions
  themselves.
- **Consolidate aggressively.** The eighteen off-whites are not eighteen decisions; collapse them.
  Where two literals are visually indistinguishable, pick one. Where a difference is deliberate and
  load-bearing, keep it and say which in the progress log.
- Verify the consolidation is not a visual rewrite: this branch must not change how the application
  looks, beyond the deliberate additions in criterion 4.

### 3. Dark mode becomes token reassignment

`.dark` is currently **25 separate override blocks**, each restating colours. After this change it
should reassign the token values once and let every rule follow.

Note an existing inconsistency worth surfacing rather than silently resolving: the light theme is
built from greens and teals while `.dark` is built from blues (`#29343d`, `#34424b`, `#4a5961`,
`#e3e8eb`). Dark mode is not a darkened light mode, it is a different hue family. **Do not
unilaterally re-hue either theme.** Make the relationship explicit through the tokens, and record in
the progress log what you found so the owner can decide whether to converge them later.

### 4. An error colour, which does not currently exist

There is **no red anywhere in the file** — I checked every literal for hue and saturation. The
password-mismatch message in `sign-in.tsx` therefore renders as bold near-black text with no colour
at all, which was the right call when no error colour existed and is a real gap now.

- Add a semantic feedback colour with light and dark values, plus whatever text or border variant
  the existing error message actually needs.
- Apply it to `.field-error` and `.sign-out-error`.
- **Colour must not be the only signal.** The existing `role="alert"`, `aria-invalid`, and font
  weight all stay. This adds a channel; it does not replace one.
- Check contrast against the surface it sits on. Aim for WCAG AA on normal text (4.5:1). State the
  measured ratio in the progress log.
- Do not add success or warning colours. Nothing uses them yet.

### 5. No visual regression

The point is invisibility. Confirm by inspection, and state that you did, that the rendered result
is unchanged apart from the new error colour. If any consolidation shifts a colour perceptibly, say
so explicitly rather than letting it pass as cleanup.

## Out of scope

Do not touch: `prefers-color-scheme` support (dark mode is a manual class toggle today, and adding
system-preference detection is a behaviour change, not a token change); `prefers-reduced-motion`;
any component markup or structure; any route, hook, or API file; the type, spacing, or radius
scales; `@fastify/rate-limit`; Resend; Zod unification; `packages/config` split; Stripe; the autosave
state machine; delete/rename endpoints.

Changing a class name is out of scope. If a rule needs a token, give it a token; do not rename it.

## Verification required before handoff

Record actual output:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck` — from a clean tree, no prior build
4. `pnpm test:coverage`
5. `pnpm build` — and report the CSS bundle size before and after; tokens should not grow it
   meaningfully
6. `PLAYWRIGHT_CHANNEL=chrome pnpm test:system`
7. `TEST_DATABASE_URL=<ask the lead> PLAYWRIGHT_CHANNEL=chrome pnpm test:system:persistence`
8. `git diff --check`

Also report: the count of colour literals remaining in rule bodies, which must be zero, and the
final token count.

Chromium is not installed; `PLAYWRIGHT_CHANNEL=chrome` uses the installed Google Chrome.

## Rules

- Do not stage, commit, merge, rebase, force-push, or create/delete worktrees. The user controls all
  Git write operations.
- Do not read, print, or commit `.env` files or any credential.
- No TODO, FIXME, or placeholder comments. No emojis.
- The aesthetic does not change: rectangles stay rectangles, `border-radius` 0-2px, no new
  box-shadows, dense and compact. Microsoft Office, Adobe applications, and Google Docs — explicitly
  not Tailwind or shadcn. No pills, no gradients, no large rounded cards.
- Do not mark anything complete without pasted command output.
- If a command appears to hang for more than a few minutes, stop and report rather than polling.
- If the work seems to require going outside this scope, stop and ask the lead.

## Log

### 2026-08-07 — lead — scope opened

Status: ready-for-implementation
Colour inventory measured on `styles.css` at 746 lines: 93 distinct literals, no custom properties,
25 `.dark` override blocks, no red anywhere. Cannot start until `feature/auth-session-routing` is
merged, because that branch adds `.sign-out-button` and `.sign-out-error` to the same file and this
branch rewrites it wholesale.

### 2026-08-07 — lead — implemented directly after the delegated agent stalled

Status: verified, pending independent review
Scope: Colour tokens, dead-rule removal, and the new error colour. No other change.

Changes:

- `apps/web/src/styles.css`: 113 colour literals replaced by 63 role-named custom properties on
  `:root`. Zero literals remain in any rule body.
- Dark mode: five tokens are reassigned under `.dark`. Eight `.dark` rules survive because they set
  a property the base rule never sets — for example `.dark .menubar` adds a `border-color` that
  `.menubar` does not have — so collapsing them would have deleted the declaration outright. Those
  now reference dark-specific tokens rather than literals.
- Removed `.add-note` and `.dark .add-note`. The class is referenced by no source file; it carried
  six colours for a component that does not exist.
- Added `--feedback-error`, applied to `.field-error` and `.sign-out-error`, which previously
  rendered as near-black with no colour channel because the file contained no red at all.

Method: clusters were formed by complete-linkage on CIE Lab distance at deltaE 2.5, within matching
role and theme. Complete linkage rather than single linkage is load-bearing: single linkage chains,
so an earlier deltaE 2.3 pass produced a 7.39 worst-case shift. Complete linkage bounds the shift by
the threshold itself.

Verification:

- Static equivalence proof: 98 declarations compared between the original and tokenised stylesheets
  across both themes, resolving every `var()` through `:root` and `.dark`. Largest shift deltaE 2.48,
  zero problems, no dark value lost.
- Contrast: error colour 7.30:1 on the light surface, 6.39:1 on the dark surface. Both exceed WCAG AA
  for normal text. Colour is an added channel only; `role="alert"`, `aria-invalid`, and font weight
  are unchanged.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck` from a clean tree, `pnpm test:coverage`
  (59 web tests), `pnpm build`, `PLAYWRIGHT_CHANNEL=chrome pnpm test:system` (1 passed), disposable
  database `pnpm test:system:persistence` (2 passed), `git diff --check` — all pass.
- CSS bundle 11.84 kB to 14.21 kB raw, 3.28 kB to 3.63 kB gzip. The increase is the token block.

Review: An independent review has not been performed. The lead both implemented and verified this.

Risks/next: 63 tokens is an inventory with names, not yet a designed system. Reducing further changes
the visual design and is a product decision, deliberately deferred. The light theme remains greens
and teals while dark is blues; that split is preserved exactly and is surfaced by the tokens rather
than resolved. Token names are role-and-rank (`--surface-04`); renaming them to semantic intent is
worth doing when the palette is designed down.

# The bundle budget: enforcing it, and getting under it

Branches `feature/bundle-budget` (PR #18) and `feature/entry-chunk-budget` (PR #19). Three commits
across two pull requests, because the enforcement could not merge until the budget was actually met.

Backfilled after the fact; see `progress/README-backfill.md`.

## Why this needed doing before more features

plan.md documents a bundle budget and states it is "enforced in CI as a build step that fails on
regression". No such step existed — nothing in `.github/workflows/*.yml` or `package.json`. And the
budget was already broken:

| artifact          | budget | measured on main |
| ----------------- | ------ | ---------------- |
| lazy editor chunk | 200 kB | **291 kB**       |
| entry chunk       | 120 kB | **123.6 kB**     |
| CSS               | 20 kB  | 5.6 kB           |

An unenforced budget becomes a wrong number nobody notices. Every feature after this one would have
made it worse, and the fix gets harder the longer it waits.

## PR #18 — the editor chunk

`App.tsx` imported the FDX, DOCX and PDF exporters statically, so every writer downloaded a full PDF
engine to open a screenplay they might never export. Converting the three to `import()` at click
time:

| chunk                           | before | after        |
| ------------------------------- | ------ | ------------ |
| editor (`App-*.js`)             | 291 kB | **109.5 kB** |
| `pdfDownload-*.js` (new, lazy)  | —      | 180.3 kB     |
| `docxDownload-*.js` (new, lazy) | —      | 7.5 kB       |
| `fdxDownload-*.js` (new, lazy)  | —      | 2.7 kB       |

Confirmed against `dist/.vite/manifest.json` that `pdf-lib` lands in the lazy chunk and is reachable
from the editor only via `dynamicImports`.

**A second, unasked-for fix fell out of this.** Dynamic import makes all three call sites async, and
only PDF previously had a rejection path — FDX and DOCX called their trigger synchronously with
nothing catching anything, so a failure surfaced nowhere at all. Without handling, a chunk that fails
to load (offline, or a stale hashed chunk after a deploy) would have become an unhandled rejection.
All three now run through one `runExport` helper into the toast PDF already used, which closes the
pre-existing gap as well as the one dynamic import would have opened.

A comment in the PDF handler asserting that no user-facing error surface exists was corrected. It was
true when written and outlasted the toast that the same handler feeds.

**Worth recording for later:** when PDF moves server-side, the 180 kB `pdfDownload` chunk disappears
from the client entirely, and the size argument for splitting FDX and DOCX (10 kB together) mostly
evaporates. What survives regardless is the error handling.

## PR #19 — the entry chunk, and two false starts

The entry chunk was over by 3.6 kB, pre-existing and unrelated to the split. Two attempts each saved
essentially nothing, and the reason is the interesting part.

**Attempt 1 (50 bytes saved).** `apps/web/src/api.ts` imported `screenplaySchema` at module scope,
and `session.ts` reaches `api.session` from a route `beforeLoad`. Moving the screenplay-shaped API
call out did almost nothing.

**Attempt 2 (10 bytes saved).** `main.tsx` calls `applyPageGeometryCssVariables()` before first
render, and `pageGeometryCss.ts` imported `DEFAULT_DOCUMENT_SETTINGS` from the schema-bearing main
entry — while already importing thirteen sibling constants from the zod-free `pageFormat` subpath.
Moving that constant out did almost nothing either.

**The cause of both failures: there were two independent synchronous paths into the same module, and
cutting either one alone left the other holding it resident.** `@finaler-draft/screenplay`'s main
entry is a single compiled `dist/index.js` containing every zod schema, so one constant drags in the
whole tree. They had to go together.

The second path is the more instructive one. A route guard runs before any component renders, so
TanStack Router's `autoCodeSplitting` cannot defer it, and ESM evaluates a module's entire top level
on any import. One session check at sign-in therefore pulled in the canonical screenplay validation
tree.

Result: **123.6 kB -> 111.4 kB**, verified by grepping the built entry chunk for strings unique to the
schema tree (`"Parenthetical indent plus width must not cross the right margin"`,
`"endOffset must be greater than or equal to startOffset"`) and confirming they moved to a lazy
chunk. zod core remains, correctly — the shell validates its own session and project responses.

## The rule that made this work

The budgets are the specification. The implementing agents were told, in writing, not to raise them
and not to weaken the check; if something did not fit, report the number and stop. Both did exactly
that, which is why the enforcement step could be held back rather than shipped red.

**Enforcement that is born failing teaches everyone to ignore it.** PR #18 shipped the split alone;
PR #19 shipped the reduction and the check together, so the check was green the day it arrived.

## The check itself

`scripts/check-bundle-budget.mjs`, run as `pnpm check:bundle-budget` and wired into the quality
workflow after `pnpm build`. It classifies artifacts through Vite's manifest **by role, not by
filename**, since filenames are content-hashed: the entry chunk is the manifest entry marked
`isEntry`, the lazy editor chunk is resolved by walking the editor route's own `dynamicImports`.
Anything it cannot classify confidently — no entry, two entries, a dangling import, a missing file —
throws rather than passing quietly. A budget check that silently measures nothing is worse than none.

Proven to **fail**, not merely to pass: against a fabricated over-budget artifact, at exactly-at-budget
(passes, `measured > budget` is the only failure), one byte over (fails), and against the real
over-budget entry chunk before the reduction landed.

Vite's 500 kB uncompressed-chunk warning is deliberately left unsuppressed, per plan.md.

## Known gaps at merge

- The entry chunk sits at 111.4 kB against 120 kB. That is 8.6 kB of headroom, not 120 — zod core and
  the framework are the floor, and SmartType has since been added under it.
- A validation-removal mutation on the moved session parse was blocked by the implementing agent's
  own tooling; the lead ran it instead and confirmed two tests fail, so "no validation lost" is
  verified rather than asserted.

# `pnpm dev` starting against a stale build

Branch `fix/dev-requires-built-packages`.

## The defect

The owner pulled `main`, ran `pnpm install`, and started `pnpm dev`. The API refused to boot:

```
SyntaxError: The requested module '@finaler-draft/server-config' does not provide an export
named 'DEFAULT_API_RATE_LIMIT_MAX'
```

followed by a wall of `ECONNREFUSED` from Vite's proxy, because nothing was listening on the API
port. Sign-in appeared broken; the API had never started.

The export exists in the source and always did. `packages/server-config/dist` was three days stale,
from before the auth-hardening slice added it.

## Why it happened, and why it was going to happen to anyone

`apps/api` and `apps/web` import the workspace packages by their published entry points, which
resolve to each package's `dist`. **`pnpm install` does not build workspace packages.** So a fresh
clone has no `dist` at all, and an existing clone has whatever was built last -- which after any
`git pull` that touched a package is the wrong thing.

The error is actively misleading: it names an export that is right there in the file the reader
opens. Nothing points at the build. This is the same `dist` staleness that has already cost time
twice on this project during mutation testing (recorded in `progress/fdx-export.md` and
`progress/page-separation.md`); the difference is that this instance is on the path every
contributor takes on their first day.

## The fix

A `build:packages` script -- the workspace-package half of the existing `build` chain, without the
two app builds -- and `dev` now runs it first. Starting the dev server therefore cannot pick up a
stale package build.

The cost is a few seconds on each `pnpm dev`. The alternative is a failure mode that names the
wrong cause, which is worth far more than a few seconds.

`build:packages` is exposed rather than inlined into `dev` so it can be run on its own, which is
what you want when rebuilding after a pull without starting anything.

## Verified

Deleted `packages/server-config/dist` outright to simulate a fresh clone, ran `pnpm build:packages`,
confirmed the missing export present again and all nine package `dist` entry points rebuilt.

## Known limitations

- CI was never affected: the workflow runs `pnpm build` before anything that needs the packages, so
  this was invisible there. That is precisely why it survived -- every gate passed while the
  first-run path was broken.
- The app builds are deliberately excluded. `dev` runs Vite and the API in watch mode and does not
  need them; including them would add time for no benefit.

import { DEFAULT_COLLAB_DEV_PORT } from '@finaler-draft/config';

/**
 * The Hocuspocus collaboration server's WebSocket URL (`apps/collab`, its own Railway service on
 * its own subdomain -- plan.md's deployment-topology section: `wss://ws.example.com`, deploying
 * independently from this app and never proxied through a CDN). A Vite build-time environment
 * variable, not a runtime-configurable one -- `import.meta.env` values are inlined into the built
 * bundle, which is correct here: this app has exactly one deployed collaboration server per
 * environment, decided at build/deploy time, not per request.
 *
 * An explicit `VITE_COLLAB_WS_URL` always wins (production sets the real `wss://` address; the
 * system-test harness sets its own loopback address -- see `scripts/test-system-persistence.mjs`).
 * Absent that, `import.meta.env.MODE === 'development'` is true in exactly one situation: `vite`
 * running as the interactive dev server (`pnpm dev`, via `apps/web`'s own `dev` script), because
 * Vite defaults that command's mode to `'development'` unless overridden. It defaults to
 * `'production'` for `vite build` (what `pnpm build`, `check:bundle-budget`, and
 * `test:system`/`test:system:persistence`'s own build step all run) and to `'test'` under Vitest
 * (`vitest.config.ts` sets no `mode`, and Vitest's own default is `'test'`) -- so this fallback
 * cannot fire for either a production build or a unit test, only for a developer's own `pnpm dev`.
 * `import.meta.env.DEV` was rejected for this: Vite sets `DEV` to `!isProduction`, which is also
 * true under Vitest's default `'test'` mode, so gating on it would have pointed every unit test at
 * a real `HocuspocusProvider` instead of the local `Y.Doc` they are written against.
 *
 * The fallback address points at `DEFAULT_COLLAB_DEV_PORT` (`@finaler-draft/config` -- see that
 * export's own doc comment for why the port number itself lives in a shared package rather than
 * as two independently-maintained literals here and in `apps/collab/src/environment.ts`'s
 * `resolveCollabPort`) so that `pnpm dev`'s web process finds `pnpm dev`'s collab process with no
 * manual configuration: the defect this fixes was that local development never exercised the real
 * collaborative path at all (`VITE_COLLAB_WS_URL` was previously set in exactly one place, the
 * system-test harness), so `pnpm dev` looked collaborative while silently running on a local,
 * unconnected `Y.Doc`.
 *
 * `undefined` remains possible -- a build with `MODE` other than `'development'` that also never
 * set `VITE_COLLAB_WS_URL` (a misconfigured deployment, or a unit test / Storybook-style isolated
 * render that legitimately wants no server) -- and `App.tsx` still falls back to a local,
 * unconnected `Y.Doc` in that case: the editor is still Yjs-backed (so the same extensions and the
 * same `yUndoPlugin`-based undo run either way), it simply never syncs with anyone. See
 * `progress/collaboration-slice-1.md` for why that silent production fallback is a real risk this
 * slice deliberately did not resolve on its own.
 */
const DEFAULT_DEV_COLLAB_WS_URL = `ws://localhost:${DEFAULT_COLLAB_DEV_PORT}`;

export const COLLAB_WS_URL: string | undefined =
  import.meta.env.VITE_COLLAB_WS_URL ??
  (import.meta.env.MODE === 'development' ? DEFAULT_DEV_COLLAB_WS_URL : undefined);

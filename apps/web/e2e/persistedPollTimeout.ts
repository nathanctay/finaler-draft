/**
 * The poll budget every `expect.poll` in this test:system:persistence suite uses when waiting for
 * an edit to reach Postgres through `apps/collab`'s debounced `onStoreDocument`
 * (`apps/collab/src/database.ts`'s `createStore`) -- see `persistence.spec.ts`'s
 * `waitForPersistedText` and `page-rendering-persistence.spec.ts`'s `waitForPersistedBlocks`, and
 * the two sites in the latter that poll inline rather than through a helper.
 *
 * This number used to be `10_000`, carried over unexamined from the era before this slice
 * (`progress/element-menu-save-race.md`): a client-side 600ms debounce, where 10 seconds was
 * "well over the debounce plus margin." That margin silently disappeared when the save path moved
 * to `apps/collab`'s Hocuspocus server, whose own `debounce`/`maxDebounce` default to 2000ms and
 * 10000ms (confirmed against the installed `@hocuspocus/server`'s `defaultConfiguration`) --
 * against a poll budget of exactly `10_000`, that is zero headroom: under continuous typing, a
 * save can legitimately be forced as late as 10 seconds after the first pending edit, before this
 * poll has even started counting.
 *
 * Confirmed by direct reproduction: `pnpm test:system:persistence` run three consecutive times
 * against the unwidened `10_000` failed 2, 1, and 1 of 18 tests, always at a
 * `waitForPersistedBlocks`/`waitForPersistedText` poll, never the same test twice -- a genuine
 * race against `maxDebounce`, not a one-off. Widening this alone to `25_000` was tried first and
 * was not sufficient on its own: a fourth run still failed once, on the suite's heaviest fixture,
 * because real execution time (the store's own Postgres transaction, which also re-projects
 * `canonical_screenplay`), the poll's own HTTP round-trip, and ordinary event-loop scheduling
 * jitter under this suite's `workers: 3` parallelism (one shared `apps/collab` process and one
 * shared Postgres pool serving all three workers' documents at once, most contended right at
 * suite start when every worker's first heavy save lands at once) all stack on top of the
 * `maxDebounce` ceiling, not inside it -- so a client-side timeout alone was chasing a moving
 * target rather than fixing the actual budget.
 *
 * The real fix is `apps/collab/src/server.ts`'s own: `debounce`/`maxDebounce` are shortened to
 * 300ms/1000ms specifically under `FINALER_SYSTEM_TEST` (see that file's own comment), which is
 * what this suite's webServer sets. That shrinks the actual save latency this budget has to
 * absorb by roughly 10x, in production's own untouched-default terms -- production and normal
 * `pnpm dev` still see Hocuspocus's real 2000ms/10000ms, per the owner's explicit instruction to
 * tune those later against real use rather than guess now. `25_000` here is the remaining safety
 * margin on top of that -- generous relative to the new, much smaller expected latency, not the
 * primary lever holding this suite together.
 *
 * Neither change weakens what a broken save looks like: a `store` that never persists still never
 * satisfies a poll's predicate regardless of the debounce or the poll budget, so it still times
 * out and fails loudly. Verified directly: forcing `apps/collab`'s `store` to a no-op still fails
 * the same 11 of 18 tests with both changes in place -- if anything, it now fails faster, since
 * the shortened test-only debounce no longer stretches "never persists" out to a full production-
 * sized `maxDebounce` before the poll even starts noticing.
 */
export const PERSISTED_POLL_TIMEOUT_MS = 25_000;

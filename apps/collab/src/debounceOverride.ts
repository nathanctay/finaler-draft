/**
 * Test-only Hocuspocus debounce overrides, read from the environment and refused in production.
 *
 * Its own module rather than a helper inside `server.ts` for the reason every other small piece of
 * this app's startup logic is (`environment.ts`, `originGuard.ts`, `authenticate.ts`): `server.ts`
 * starts a listening server as an import side effect, so nothing in it can be unit-tested, and the
 * one property that most needs a test here is a negative one -- that production never honours these
 * variables.
 *
 * Why a *longer* debounce is the thing worth being able to ask for:
 * `gracefulShutdown.integration.test.ts` asserts that a checkpoint written during a `SIGTERM` is
 * attributable to the shutdown flush rather than to Hocuspocus's ordinary timer, and originally
 * established that by signalling inside the real 2s debounce window -- a fixed 250ms sleep against
 * a 2s timer. That margin held locally and failed twice on CI, in both directions, blocking a
 * deploy each time. Raising the debounce far past any plausible test duration makes the attribution
 * *stronger* rather than weaker: with a 30-second timer no ordinary debounce can fire during the
 * test at all, so a checkpoint can only have come from the flush.
 */
export interface CollabDebounceOverride {
  readonly debounce: number;
  readonly maxDebounce: number;
}

export interface CollabDebounceEnvironment {
  readonly COLLAB_DEBOUNCE_MS?: string | undefined;
  readonly COLLAB_MAX_DEBOUNCE_MS?: string | undefined;
  readonly NODE_ENV?: string | undefined;
  /**
   * Present so `process.env` (whose own type is an index signature) is assignable here. Without it
   * TypeScript's weak-type check rejects the real call site outright, since an all-optional
   * interface shares no required property with `ProcessEnv` -- the named keys above stay for
   * documentation, and this makes them a subset rather than the whole contract.
   */
  readonly [key: string]: string | undefined;
}

/**
 * Returns the override to spread into Hocuspocus's configuration, or an empty object when there is
 * none to apply.
 *
 * Both values must be present and parse as positive integers. A partial or malformed pair is
 * treated as absent rather than half-applied, so a typo degrades to Hocuspocus's documented
 * defaults instead of to some arbitrary timer -- a half-applied pair is the one outcome that would
 * be worse than ignoring the variables entirely, since `debounce` without `maxDebounce` silently
 * changes how long an edit can sit unflushed.
 */
export function collabDebounceOverride(
  environment: CollabDebounceEnvironment,
): CollabDebounceOverride | Record<string, never> {
  if (environment.NODE_ENV === 'production') {
    return {};
  }
  const debounce = Number(environment.COLLAB_DEBOUNCE_MS);
  const maxDebounce = Number(environment.COLLAB_MAX_DEBOUNCE_MS);
  if (!Number.isInteger(debounce) || debounce <= 0) {
    return {};
  }
  if (!Number.isInteger(maxDebounce) || maxDebounce <= 0) {
    return {};
  }
  return { debounce, maxDebounce };
}

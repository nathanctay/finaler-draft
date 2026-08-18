/**
 * Wraps a reachability probe (e.g. `select 1` against the shared database pool) so repeated
 * calls within `ttlMs` reuse the last result instead of re-running it. `/api/health` is
 * registered ahead of the auth hook (see app.ts) and shares its pool with every save request, so
 * it is reachable without a session and without rate limiting -- an unauthenticated flood of
 * health checks would otherwise queue real, in-flight autosaves behind a pool slot spent purely
 * on liveness checks. Concurrent calls that land while a probe is already in flight all resolve
 * to that same in-flight promise rather than each starting a new one, so a burst of simultaneous
 * requests costs at most one real database round trip, not one per request.
 */
export function cachedProbe(probe: () => Promise<boolean>, ttlMs: number): () => Promise<boolean> {
  let cached: { result: boolean; expiresAt: number } | undefined;
  let inFlight: Promise<boolean> | undefined;

  return async () => {
    const now = Date.now();
    if (cached && now < cached.expiresAt) return cached.result;
    if (inFlight) return inFlight;

    // A rejection is cached as `false`, the same as a resolved-false probe: an outage is exactly
    // the scenario this needs to keep protecting the pool through, not the one case it stops
    // caching for. `databaseReady` in server.ts already converts its own errors to `false`
    // before this ever sees them, so this is defensive symmetry for any other caller, not the
    // expected path.
    inFlight = probe()
      .catch(() => false)
      .then((result) => {
        cached = { result, expiresAt: Date.now() + ttlMs };
        inFlight = undefined;
        return result;
      });
    return inFlight;
  };
}

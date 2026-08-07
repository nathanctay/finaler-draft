import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api, type SessionUser } from './api.js';

/**
 * The single shared `['session']` cache entry. Route guards (`beforeLoad`, via
 * `queryClient.ensureQueryData`) and `useAuth` both read this definition so a guarded
 * navigation issues one session request, not one per consumer.
 *
 * `staleTime` is intentionally finite, not `Infinity`: a stale "signed in" answer would
 * let the UI keep offering actions the API then rejects once the session has actually
 * expired or been signed out elsewhere.
 */
export const sessionQueryOptions = queryOptions({
  queryFn: api.session,
  queryKey: ['session'] as const,
  staleTime: 30_000,
});

/**
 * The session lookup for a route guard specifically. `ensureQueryData` rejects when the
 * session request itself fails — a down or misconfigured auth backend, a network error —
 * not only when the visitor is signed out. A route guard is a UX boundary, so on doubt it
 * fails closed to signed-out rather than surfacing an infrastructure error as a broken
 * route; the API independently re-checks the real session on every request regardless of
 * what the guard decided. `useAuth` and other direct consumers still see the underlying
 * query's own error state and must not be routed through this helper.
 */
export async function guardSessionUser(queryClient: QueryClient): Promise<SessionUser | null> {
  try {
    return await queryClient.ensureQueryData(sessionQueryOptions);
  } catch {
    return null;
  }
}

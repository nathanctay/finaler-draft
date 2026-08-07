import { useQuery } from '@tanstack/react-query';
import type { SessionUser } from './api.js';
import { sessionQueryOptions } from './session.js';

export interface UseAuthResult {
  isLoading: boolean;
  user: SessionUser | null;
}

/**
 * The current signed-in user, for components that render around identity: an avatar,
 * a profile page, a sign-out control. Reads the shared `['session']` query cache and
 * never issues its own request.
 *
 * This is for rendering decisions only. Access control belongs in a route's
 * `beforeLoad`, which runs before the route commits; this hook runs during render,
 * after it already has.
 */
export function useAuth(): UseAuthResult {
  const session = useQuery(sessionQueryOptions);
  return {
    isLoading: session.isLoading,
    user: session.data ?? null,
  };
}

import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardSessionUser, sessionQueryOptions } from './session.js';

const user = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

function fakeQueryClient(ensureQueryData: () => Promise<unknown>): QueryClient {
  return { ensureQueryData } as unknown as QueryClient;
}

describe('guardSessionUser', () => {
  it('returns the resolved session user for a route guard', async () => {
    const queryClient = fakeQueryClient(() => Promise.resolve(user));
    await expect(guardSessionUser(queryClient)).resolves.toEqual(user);
  });

  it('returns null once signed out, rather than a resolved session', async () => {
    const queryClient = fakeQueryClient(() => Promise.resolve(null));
    await expect(guardSessionUser(queryClient)).resolves.toBeNull();
  });

  it('fails closed to signed-out when the session request itself fails, instead of breaking the route', async () => {
    const queryClient = fakeQueryClient(() => Promise.reject(new Error('auth backend down')));
    await expect(guardSessionUser(queryClient)).resolves.toBeNull();
  });
});

// Regression: `ensureQueryData` returns whatever is already cached, including a cached
// `null`, without refetching. A visit to /sign-in caches ['session'] = null; unless a
// successful sign-in removes that entry (not just invalidates it — see sign-in.tsx), the
// /projects guard sees the stale null and bounces a freshly signed-in visitor right back.
// This exercises a real QueryClient, not the simplified route-harness mocks, so it proves
// the actual TanStack Query cache semantics, not just that guardSessionUser forwards data.
describe('session cache handoff from sign-in to the /projects guard', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({ user }),
      ok: true,
      status: 200,
    } as Response);
  });

  it('sees the signed-in user once sign-in removes the stale cached null', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // The earlier visit to /sign-in cached exactly this signed-out answer.
    queryClient.setQueryData(sessionQueryOptions.queryKey, null);
    await expect(guardSessionUser(queryClient)).resolves.toBeNull();

    // What a successful sign-in must do before navigating to /projects.
    queryClient.removeQueries({ queryKey: sessionQueryOptions.queryKey });

    await expect(guardSessionUser(queryClient)).resolves.toEqual(user);
  });

  it('demonstrates the bug this guards against: the stale null survives without removal', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(sessionQueryOptions.queryKey, null);

    // No removeQueries call here: even though the backend would now report a real user,
    // ensureQueryData still hands back the cached null.
    await expect(guardSessionUser(queryClient)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

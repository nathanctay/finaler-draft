import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from './api.js';
import { resetRouteHarness, routeState } from './test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('./test/routeHarness.js')).reactQueryMock(),
);

const { useAuth } = await import('./useAuth.js');

const sessionUser: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

describe('useAuth', () => {
  beforeEach(resetRouteHarness);

  it('reports loading with no user while the session request is in flight', () => {
    routeState.query = { data: undefined, isError: false, isLoading: true };
    const { result } = renderHook(() => useAuth());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.user).toBeNull();
  });

  it('returns the signed-in user once the shared session query resolves', () => {
    routeState.query = { data: sessionUser, isError: false, isLoading: false };
    const { result } = renderHook(() => useAuth());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).toEqual(sessionUser);
  });

  it('returns null, not a loading state, once the session query resolves signed-out', () => {
    routeState.query = { data: null, isError: false, isLoading: false };
    const { result } = renderHook(() => useAuth());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).toBeNull();
  });
});

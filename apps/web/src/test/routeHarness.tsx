import type * as React from 'react';
import type * as ReactRouter from '@tanstack/react-router';
import { vi } from 'vitest';

export const projectId = '216ec49a-a6c6-49ff-8e2e-5994d5ca91dd';
export const screenplayId = '38d8a6db-43f1-4b47-b8fc-c15a96f9ac0e';

type QueryState = { data: unknown; isError: boolean; isLoading: boolean };

/**
 * Mutable state the route mocks read from. Tests assign to it between renders to
 * drive loading, error, and data states without a real router or query client.
 */
export const routeState: {
  editorMounts: number;
  mutationError: boolean;
  mutationErrorValue: unknown;
  navigate: ReturnType<typeof vi.fn>;
  query: QueryState;
  screenplayId: string;
} = {
  editorMounts: 0,
  mutationError: false,
  mutationErrorValue: undefined,
  navigate: vi.fn(),
  query: { data: undefined, isError: false, isLoading: false },
  screenplayId,
};

export const fetchMock = vi.fn<typeof fetch>();
export const invalidateQueries = vi.fn();
export const clearQueryCache = vi.fn();
export const removeQueries = vi.fn();

export function reactQueryMock(): Record<string, unknown> {
  return {
    queryOptions: (options: unknown) => options,
    useMutation: (options: {
      mutationFn: () => Promise<unknown>;
      onSuccess?: (value: never) => unknown;
    }) => ({
      error: routeState.mutationErrorValue,
      isError: routeState.mutationError || routeState.mutationErrorValue !== undefined,
      isPending: false,
      mutate: () =>
        void Promise.resolve(options.mutationFn()).then(
          (value) => options.onSuccess?.(value as never),
          (error: unknown) => {
            routeState.mutationErrorValue = error;
          },
        ),
      reset: () => {
        routeState.mutationError = false;
        routeState.mutationErrorValue = undefined;
      },
    }),
    // The page's own query function runs so the endpoint it requests is exercised.
    // Its result is discarded; tests drive rendering through `routeState.query`.
    useQuery: (options: { queryFn?: () => unknown }) => {
      void Promise.resolve(options.queryFn?.()).catch(() => undefined);
      return routeState.query;
    },
    useQueryClient: () => ({ clear: clearQueryCache, invalidateQueries, removeQueries }),
  };
}

/**
 * Partial mock. Route modules call `createFileRoute` and `createRootRoute` at module
 * scope, so those must stay real or importing a route throws before any test runs.
 * Only the hooks and navigation components are replaced.
 */
export async function reactRouterMock(
  importOriginal: () => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as typeof ReactRouter;
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
      <a href={to}>{children}</a>
    ),
    Outlet: () => <div>Outlet</div>,
    useNavigate: () => routeState.navigate,
    useParams: () => ({ projectId, screenplayId: routeState.screenplayId }),
    useRouter: () => ({ navigate: routeState.navigate }),
  };
}

/** Stands in for the lazily imported editor and counts mounts so remounts are observable. */
export async function editorModuleMock(): Promise<Record<string, unknown>> {
  const react = await vi.importActual<typeof React>('react');
  return {
    App: ({ initial }: { initial: { title: string } }) => {
      const [mountId] = react.useState(() => ++routeState.editorMounts);
      return <div data-testid="editor-instance">{`${mountId}:${initial.title}`}</div>;
    },
  };
}

export function resetRouteHarness() {
  routeState.editorMounts = 0;
  routeState.mutationError = false;
  routeState.mutationErrorValue = undefined;
  routeState.navigate.mockReset();
  routeState.query = { data: undefined, isError: false, isLoading: false };
  routeState.screenplayId = screenplayId;
  invalidateQueries.mockReset();
  clearQueryCache.mockReset();
  removeQueries.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(
    async (path, init) =>
      ({
        json: async () =>
          path === '/api/projects' && init?.method === 'POST'
            ? { id: projectId, title: 'Feature' }
            : path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST'
              ? { id: screenplayId, version: 1 }
              : [],
        ok: true,
        status: 200,
      }) as Response,
  );
}

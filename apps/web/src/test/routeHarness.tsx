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
  /**
   * Per-`queryKey` overrides, keyed by `JSON.stringify(queryKey)`. A page with only one
   * `useQuery` call never needs this -- `query` above still works exactly as before. A page with
   * more than one concurrent `useQuery` call (e.g. `['projects']` and `['entitlement']` on the
   * same screen) sets an entry here for each key it needs to control independently; any
   * `queryKey` with no entry here falls back to the single shared `query` above, unchanged from
   * every test written before this existed.
   */
  queries: Record<string, QueryState>;
  screenplayId: string;
} = {
  editorMounts: 0,
  mutationError: false,
  mutationErrorValue: undefined,
  navigate: vi.fn(),
  query: { data: undefined, isError: false, isLoading: false },
  queries: {},
  screenplayId,
};

export const fetchMock = vi.fn<typeof fetch>();
export const invalidateQueries = vi.fn();
export const clearQueryCache = vi.fn();
export const removeQueries = vi.fn();

/**
 * A fetch `Response` stand-in complete enough for either request path in this codebase: `json()`
 * for the hand-rolled `request()`/`json()` helpers in api.ts, and `text()` plus a real `headers`
 * for Better Auth's client (authClient.ts) -- `@better-fetch/fetch` always reads
 * `response.headers.get('content-type')` to pick a response type and then reads the body through
 * `.text()`, never `.json()` (confirmed against the installed `@better-fetch/fetch` source: an
 * object with only `.json()`, the shape every mock in this file used before
 * `requestPasswordReset`/`resetPassword` needed the client, throws inside `detectResponseType`
 * the moment it tries `undefined.get(...)`). Every fetch mock a test builds for a route that calls
 * through `authClient()` needs this, not a bare `{json, ok, status}` object.
 */
export function fakeJsonResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number },
): Response {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
  } as Response;
}

export function reactQueryMock(): Record<string, unknown> {
  return {
    queryOptions: (options: unknown) => options,
    useMutation: (options: {
      mutationFn: (variables?: unknown) => Promise<unknown>;
      onSuccess?: (value: never) => unknown;
    }) => ({
      error: routeState.mutationErrorValue,
      isError: routeState.mutationError || routeState.mutationErrorValue !== undefined,
      isPending: false,
      // Forwards whatever variable the caller passed (e.g. `mutate('monthly')`) through to
      // `mutationFn` -- every mutation in this app before upgradeDialog.tsx called `mutate()`
      // with no argument, and `mutationFn` for those ignores its parameter, so this is a strict
      // superset of the previous zero-argument behaviour.
      mutate: (variables?: unknown) =>
        void Promise.resolve(options.mutationFn(variables)).then(
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
    // Its result is discarded; tests drive rendering through `routeState.query` (or, for a page
    // with more than one concurrent `useQuery` call, `routeState.queries` keyed by `queryKey` --
    // see that field's own comment).
    useQuery: (options: { queryKey?: unknown[]; queryFn?: () => unknown }) => {
      void Promise.resolve(options.queryFn?.()).catch(() => undefined);
      const key = options.queryKey ? JSON.stringify(options.queryKey) : undefined;
      if (key !== undefined && Object.hasOwn(routeState.queries, key)) {
        return routeState.queries[key];
      }
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
  routeState.queries = {};
  routeState.screenplayId = screenplayId;
  invalidateQueries.mockReset();
  clearQueryCache.mockReset();
  removeQueries.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (path, init) =>
    fakeJsonResponse(
      path === '/api/projects' && init?.method === 'POST'
        ? { id: projectId, title: 'Feature' }
        : path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST'
          ? { id: screenplayId, version: 1 }
          : // `signIn`/`signUp` (api.ts) both parse `{token}` out of the response body now that
            // `requireEmailVerification` (auth.ts) means sign-up may or may not return one; a
            // non-null token here is the default "this succeeded and created a session" case
            // every existing test using this mock already assumes. Tests that specifically need
            // the unverified (`token: null`) outcome override this with their own
            // `fetchMock.mockImplementation`, the same way error-response tests already do below.
            path === '/api/auth/sign-in/email' || path === '/api/auth/sign-up/email'
            ? { token: 'test-session-token' }
            : // A free/never-subscribed account by default -- the shape every test not
              // specifically exercising billing state can safely ignore.
              path === '/api/entitlement'
              ? {
                  tier: 'restricted',
                  editableScreenplayId: null,
                  candidateScreenplayIds: [],
                  slotUpdatedAt: null,
                  cooldownEndsAt: null,
                }
              : path === '/api/billing/checkout-session' && init?.method === 'POST'
                ? { url: 'https://checkout.stripe.test/test-session' }
                : path === '/api/billing/portal-session' && init?.method === 'POST'
                  ? { url: 'https://billing.stripe.test/test-session' }
                  : // No subscription by default, matching the free/never-subscribed default above.
                    path === '/api/billing/subscription'
                    ? { subscription: null }
                    : // `requestPasswordReset`/`resetPassword` (api.ts, via authClient.ts) both parse
                      // whatever body comes back through `unwrapAuthClientResult`, which only ever
                      // reads `.error`; an empty object is a safe default success body for either.
                      {},
    ),
  );
}

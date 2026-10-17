import type * as React from 'react';
import type * as ReactRouter from '@tanstack/react-router';
import { vi } from 'vitest';

export const projectId = '216ec49a-a6c6-49ff-8e2e-5994d5ca91dd';
export const screenplayId = '38d8a6db-43f1-4b47-b8fc-c15a96f9ac0e';
export const revisionId = '5e7b2c1a-9d34-4e6a-8c0a-1b2c3d4e5f6a';

type QueryState = { data: unknown; isError: boolean; isLoading: boolean };

/**
 * Mirrors apps/api/src/app.ts's `describeEntitlement`/apps/web/src/api.ts's `Entitlement` shape
 * field for field. `paid` by default -- the shape every test not specifically exercising the free
 * tier or a lapse should be able to ignore, matching this file's own `fetchMock` default reasoning
 * for every other endpoint -- with each field overridable for the tests that do care. Any page
 * with more than one concurrent `useQuery` call needs this wrapped in a `QueryState` and set on
 * `routeState.queries[JSON.stringify(['entitlement'])]` (see that field's own comment); a bare
 * shared `routeState.query` is not enough once a second query exists on the same page.
 */
export function entitlementSnapshot(
  overrides: Partial<{
    tier: 'paid' | 'restricted';
    editableScreenplayId: string | null;
    candidateScreenplayIds: string[];
    slotUpdatedAt: string | null;
    cooldownEndsAt: string | null;
  }> = {},
) {
  return {
    tier: 'paid' as const,
    editableScreenplayId: null,
    candidateScreenplayIds: [],
    slotUpdatedAt: null,
    cooldownEndsAt: null,
    ...overrides,
  };
}

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
  revisionId: string;
  screenplayId: string;
} = {
  editorMounts: 0,
  mutationError: false,
  mutationErrorValue: undefined,
  revisionId,
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
      /**
       * Invoked on a rejected `mutationFn`, as React Query itself does. Added for
       * `sharingDialog.tsx`, the first component here to handle a refusal through `onError` rather
       * than by reading `isError` off the mutation object -- it has several independent writes on
       * one screen, so "which one failed, and what did the server say" cannot come from a single
       * shared `isError` flag. Purely additive for every existing caller: none of them passes
       * `onError`, and `mutationErrorValue` is still recorded exactly as before.
       */
      onError?: (error: unknown) => unknown;
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
            options.onError?.(error);
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
    useParams: () => ({
      projectId,
      revisionId: routeState.revisionId,
      screenplayId: routeState.screenplayId,
    }),
    useRouter: () => ({ navigate: routeState.navigate }),
  };
}

/**
 * Stands in for the lazily imported editor and counts mounts so remounts are observable. Also
 * renders `entitlementReadOnly` -- the route's own computed "why is this read-only, and how to
 * fix it" prop (App.tsx's `EntitlementReadOnly`) -- when present, and exposes its
 * `onMakeEditable` as a real clickable button, so a route-level test can assert both that the
 * route computed the right prop and that clicking through to it calls the right thing, without
 * needing the real (heavier, Tiptap-backed) `App` component at all.
 */
export async function editorModuleMock(): Promise<Record<string, unknown>> {
  const react = await vi.importActual<typeof React>('react');
  return {
    App: ({
      entitlementReadOnly,
      historicalRevision,
      initial,
      onOpenRevisionHistory,
      onOpenSharing,
      onReloadRestoredDocument,
      viewerRole,
    }: {
      entitlementReadOnly?: {
        cooldownUntil?: string;
        message: string;
        onMakeEditable?: () => Promise<void>;
      };
      historicalRevision?: {
        label: string;
        onBackToRevisions?: () => void;
        onRestore?: () => void;
      };
      initial: { title: string };
      onOpenRevisionHistory?: () => void;
      onOpenSharing?: () => void;
      onReloadRestoredDocument?: () => void;
      viewerRole?: 'owner' | 'editor' | 'reviewer';
    }) => {
      const [mountId] = react.useState(() => ++routeState.editorMounts);
      return (
        <div data-testid="editor-instance">
          <span>{`${mountId}:${initial.title}`}</span>
          {/* The screenplay-invitations slice's read-only fix: the route hands the editor the
              viewer's own effective role, and `App` ranks `'reviewer'` ahead of entitlement as a
              read-only reason (App.tsx's `viewerRole` and `readOnlyReason`). Surfaced here so a
              route test can prove the route actually threads it -- deleting that one prop would
              otherwise leave every App-level assertion green. `App.test.tsx` owns what the real
              component does with it. */}
          {viewerRole !== undefined && <span data-testid="viewer-role">{viewerRole}</span>}
          {entitlementReadOnly && (
            <div data-testid="entitlement-readonly">
              <p>{entitlementReadOnly.message}</p>
              {entitlementReadOnly.onMakeEditable && (
                <button
                  disabled={entitlementReadOnly.cooldownUntil !== undefined}
                  // `.catch(() => {})`, not a bare `void` call: a route test can deliberately
                  // reject this (to prove the route's own `finally`-invalidate-on-failure runs)
                  // without that rejection surfacing as an unhandled promise rejection here --
                  // this stub isn't the thing under test for *how* a rejection is displayed
                  // (App.test.tsx owns that), only for what the route passes down and does.
                  onClick={() => void entitlementReadOnly.onMakeEditable!().catch(() => {})}
                  type="button"
                >
                  Make this one editable
                </button>
              )}
              {entitlementReadOnly.cooldownUntil !== undefined && (
                <p data-testid="cooldown-until">{entitlementReadOnly.cooldownUntil}</p>
              )}
            </div>
          )}
          {/* Collaboration slice 4a. A route test asserts on this label (historical preview)
              and on this button firing `onOpenRevisionHistory` (the live editor), without either
              needing the real, Tiptap-backed `App`. */}
          {historicalRevision && (
            <p data-testid="historical-revision">{historicalRevision.label}</p>
          )}
          {/* Three callbacks the *route* owns (see `HistoricalRevisionInfo.onBackToRevisions`,
              `HistoricalRevisionInfo.onRestore` and `onReloadRestoredDocument` in App.tsx): the
              preview route decides where "back" goes and whether a restore may even be offered, and
              the live route owns what "reload the new epoch" means. Exposed here as real buttons so
              a route test can prove each decision and click-through without the Tiptap-backed
              `App`; `App.historicalRevision.test.tsx` and `App.restore.test.tsx` own how the real
              component renders them. */}
          {historicalRevision?.onBackToRevisions && (
            <button onClick={historicalRevision.onBackToRevisions} type="button">
              Back to revisions
            </button>
          )}
          {historicalRevision?.onRestore && (
            <button onClick={historicalRevision.onRestore} type="button">
              Restore this revision…
            </button>
          )}
          {onReloadRestoredDocument && (
            <button onClick={onReloadRestoredDocument} type="button">
              Open the restored screenplay
            </button>
          )}
          {onOpenRevisionHistory && (
            <button onClick={onOpenRevisionHistory} type="button">
              Revision history…
            </button>
          )}
          {/* The screenplay-invitations slice's third entry point. Its *presence* is the
              authorization signal (see `onOpenSharing` in App.tsx): the live route supplies it only
              for a viewer the server would let share, so a route test asserts both that the route
              decided correctly and that clicking through opens the dialog, without the
              Tiptap-backed `App`. `App.test.tsx` owns how the real File menu renders it. */}
          {onOpenSharing && (
            <button onClick={onOpenSharing} type="button">
              Share…
            </button>
          )}
        </div>
      );
    },
  };
}

export function resetRouteHarness() {
  routeState.editorMounts = 0;
  routeState.mutationError = false;
  routeState.mutationErrorValue = undefined;
  routeState.navigate.mockReset();
  routeState.query = { data: undefined, isError: false, isLoading: false };
  // The screenplay-invitations slice added two further concurrent queries to the dashboard, and the
  // single shared `routeState.query` fallback cannot serve three keys at once -- without a default,
  // every pre-existing projects-page test would see its project list rendered a second time as
  // "shared with you" and a third time as a list of invitations. These defaults are the state those
  // tests already implicitly assume (nothing invited, nothing shared screenplay-by-screenplay), in
  // exactly the spirit of `fetchMock`'s own per-endpoint defaults below: the shape a test not
  // specifically about invitations can safely ignore. `index.sharing.test.tsx` overrides both.
  routeState.queries = {
    [JSON.stringify(['invitations'])]: { data: [], isError: false, isLoading: false },
    [JSON.stringify(['shared-screenplays'])]: { data: [], isError: false, isLoading: false },
  };
  routeState.revisionId = revisionId;
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

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../api.js';
import { fetchMock, resetRouteHarness } from '../test/routeHarness.js';

vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./billing.success.js');
const BillingSuccessPage = Route.options.component!;
const sessionUser: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

function contextWithSession(user: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(user) } } };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { json: async () => body, ok, status } as unknown as Response;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BillingSuccessPage />
    </QueryClientProvider>,
  );
}

describe('billing success page', () => {
  beforeEach(resetRouteHarness);

  it('redirects a signed-out visitor to /sign-in instead of rendering, the same guard every other protected route uses', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('billing.success beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(sessionUser))).resolves.toBeUndefined();
  });

  // plan.md, stated as directly as it can be: "The Checkout success redirect is not proof of
  // payment. A user can navigate to the success URL directly." This is that rule proven at the
  // page level: reaching this page makes exactly one network call -- a plain read -- and never a
  // write of any kind, so navigating here directly, with no webhook ever having fired, cannot
  // grant anything by construction, not merely by convention.
  it('makes no request that could grant anything -- only a plain GET of current entitlement state', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        tier: 'restricted',
        editableScreenplayId: null,
        candidateScreenplayIds: [],
        slotUpdatedAt: null,
        cooldownEndsAt: null,
      }),
    );
    renderPage();
    await screen.findByText(/Thanks -- finishing up/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/entitlement');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('shows a pending state, not a false confirmation, while entitlement has not caught up with the webhook yet', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        tier: 'restricted',
        editableScreenplayId: null,
        candidateScreenplayIds: [],
        slotUpdatedAt: null,
        cooldownEndsAt: null,
      }),
    );
    renderPage();
    expect(await screen.findByText(/Thanks -- finishing up/)).toBeVisible();
    expect(screen.queryByText(/You're on Finaler Draft Pro/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to your projects/i })).toBeVisible();
  });

  it('confirms the subscription once the webhook has already updated entitlement state', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        tier: 'paid',
        editableScreenplayId: null,
        candidateScreenplayIds: [],
        slotUpdatedAt: null,
        cooldownEndsAt: null,
      }),
    );
    renderPage();
    expect(await screen.findByText(/You're on Finaler Draft Pro/)).toBeVisible();
  });
});

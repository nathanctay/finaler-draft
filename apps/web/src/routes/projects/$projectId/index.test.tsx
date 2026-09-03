import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeJsonResponse,
  fetchMock,
  projectId,
  resetRouteHarness,
  routeState,
  screenplayId,
} from '../../../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../../../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../../test/routeHarness.js')).reactRouterMock(importOriginal),
);
// jsdom does not implement real navigation (see externalRedirect.ts's own comment) -- mocked so
// the Upgrade dialog's Stripe redirect, reached from the limit prompt below, does not hit jsdom's
// "Not implemented: navigation" console error.
vi.mock('../../../externalRedirect.js', () => ({ redirectToExternalUrl: vi.fn() }));

const { Route } = await import('./index.js');
const { redirectToExternalUrl } = await import('../../../externalRedirect.js');
const ProjectPage = Route.options.component!;

const FREE_TIER_LIMIT_MESSAGE =
  'Free tier limit reached: only one editable screenplay is allowed. Choose an existing one to keep editing, or upgrade to create another.';

describe('project page', () => {
  beforeEach(() => {
    resetRouteHarness();
    vi.mocked(redirectToExternalUrl).mockClear();
  });

  it('lists and creates screenplays for a project', async () => {
    const user = userEvent.setup();
    routeState.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<ProjectPage />);
    expect(screen.getByText('Loading scripts…')).toBeVisible();
    routeState.query = {
      data: [{ id: screenplayId, title: 'Draft' }],
      isError: false,
      isLoading: false,
    };
    rerender(<ProjectPage />);
    expect(screen.getByText('Draft')).toBeVisible();
    await user.clear(screen.getByLabelText('New screenplay title'));
    await user.type(screen.getByLabelText('New screenplay title'), 'Second Draft');
    fireEvent.submit(screen.getByRole('button', { name: 'New screenplay' }).closest('form')!);
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${projectId}/screenplays`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await vi.waitFor(() =>
      expect(routeState.navigate).toHaveBeenCalledWith({
        to: '/projects/$projectId/screenplays/$screenplayId',
        params: { projectId, screenplayId },
      }),
    );
  });

  it('shows an upgrade prompt, not a bare error, when the free-tier limit is hit -- and lets the writer start checkout from it', async () => {
    const user = userEvent.setup();
    routeState.query = { data: [], isError: false, isLoading: false };
    fetchMock.mockImplementation(async (path, init) => {
      if (path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST') {
        return fakeJsonResponse({ error: FREE_TIER_LIMIT_MESSAGE }, { ok: false, status: 402 });
      }
      if (path === '/api/billing/checkout-session' && init?.method === 'POST') {
        return fakeJsonResponse({ url: 'https://checkout.stripe.test/test-session' });
      }
      return fakeJsonResponse({});
    });
    const { rerender } = render(<ProjectPage />);

    fireEvent.submit(screen.getByRole('button', { name: 'New screenplay' }).closest('form')!);

    // The harness's `useMutation` mock (routeHarness.tsx) records a failed mutation's error on a
    // shared external slot rather than driving a React state update of its own -- so, unlike real
    // react-query, nothing here re-renders the component on its own once the rejected promise
    // settles. Waiting for the slot to be populated and then re-rendering is the same two-step
    // this file's sibling test already uses whenever the mocked state changes after the initial
    // render.
    await vi.waitFor(() => expect(routeState.mutationErrorValue).toBeDefined());
    rerender(<ProjectPage />);

    // Says what happened -- the server's own explanation, not a generic "something went wrong" --
    // and offers the upgrade, matching the task's own requirement for this prompt.
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(FREE_TIER_LIMIT_MESSAGE);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
    // Lazy-loaded (routes/projects/$projectId/index.tsx's own comment explains why), so it
    // appears only after the dynamic import resolves -- `findByRole`, not a synchronous
    // `getByRole`.
    expect(
      await screen.findByRole('dialog', { name: 'Upgrade to Finaler Draft Pro' }),
    ).toBeVisible();
    // The dialog carries the same explanation forward, so the writer isn't asked to re-read a
    // blank dialog after already being told what happened.
    expect(screen.getAllByText(FREE_TIER_LIMIT_MESSAGE).some((node) => node.tagName === 'P')).toBe(
      true,
    );

    await user.click(screen.getByRole('button', { name: 'Upgrade monthly' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/billing/checkout-session',
        expect.objectContaining({ body: JSON.stringify({ plan: 'monthly' }), method: 'POST' }),
      ),
    );
    await vi.waitFor(() =>
      expect(redirectToExternalUrl).toHaveBeenCalledWith(
        'https://checkout.stripe.test/test-session',
      ),
    );
  });
});

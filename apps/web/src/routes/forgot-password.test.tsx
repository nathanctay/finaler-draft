import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeJsonResponse,
  fetchMock,
  resetRouteHarness,
  routeState,
} from '../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./forgot-password.js');
const ForgotPasswordPage = Route.options.component!;

describe('forgot-password page', () => {
  beforeEach(resetRouteHarness);

  it('requests a reset link and shows the same generic confirmation the server always sends', async () => {
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    await screen.findByRole('status');
    expect(screen.getByRole('status')).toHaveTextContent(
      'If an account exists for that email address, check your inbox',
    );
    // The form is gone once the confirmation renders -- nothing left to resubmit.
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();

    // The client (authClient.ts, via Better Auth's `createAuthClient`) calls the underlying
    // `fetch` with a `URL` instance, not a bare string path -- unlike api.ts's hand-rolled
    // `request()` helper, which every other assertion in this codebase checks against a relative
    // string. `String(path)` here is what makes this comparable at all.
    const [, init] = fetchMock.mock.calls.find(([path]) =>
      String(path).includes('/api/auth/request-password-reset'),
    )!;
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'writer@example.com',
      redirectTo: '/reset-password',
    });
  });

  it('shows the generic confirmation identically for an address that is not registered, never revealing which case it was', async () => {
    // Better Auth's own anti-enumeration design: the server always answers success. This test
    // exists so a future change cannot start branching the UI on some hypothetical "not found"
    // response without that being a deliberate, visible decision.
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText('Email'), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    await screen.findByRole('status');
    expect(screen.getByRole('status')).toHaveTextContent(
      'If an account exists for that email address, check your inbox',
    );
  });

  it('shows the generic error message on a genuine failure, not the confirmation', async () => {
    fetchMock.mockImplementation(async () =>
      fakeJsonResponse({ code: 'INTERNAL_SERVER_ERROR' }, { ok: false, status: 500 }),
    );
    const user = userEvent.setup();
    const first = render(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    // The mock `useMutation` (routeHarness.tsx) records a rejection on `routeState`, which is not
    // React state and so triggers no re-render by itself -- the same reason sign-in.test.tsx's
    // own error-path tests re-render after waiting, rather than expecting the first render to
    // pick it up.
    await vi.waitFor(() => expect(routeState.mutationErrorValue).toBeDefined());
    first.unmount();

    render(<ForgotPasswordPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not complete');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('links back to sign in', () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
  });
});

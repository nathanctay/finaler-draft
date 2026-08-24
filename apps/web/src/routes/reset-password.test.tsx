import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD_REQUIREMENTS_MESSAGE } from '@finaler-draft/config';
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

const { Route } = await import('./reset-password.js');
const ResetPasswordPage = Route.options.component!;

function setSearch(search: string) {
  window.history.replaceState(null, '', `/reset-password${search}`);
}

describe('reset-password page', () => {
  beforeEach(() => {
    resetRouteHarness();
    setSearch('');
  });

  it('shows an invalid-link message and no form when the URL carries no token', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByRole('heading', { name: 'This link is invalid.' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Request a new password reset link.');
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('submits the new password with the token from the URL, then shows success', async () => {
    setSearch('?token=abc123');
    const user = userEvent.setup();
    render(<ResetPasswordPage />);
    expect(screen.getByText(PASSWORD_REQUIREMENTS_MESSAGE)).toBeInTheDocument();

    await user.type(screen.getByLabelText('New password'), 'a new secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    await screen.findByRole('status');
    expect(screen.getByRole('status')).toHaveTextContent('Your password has been reset.');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');

    // See forgot-password.test.tsx's matching comment: the client calls `fetch` with a `URL`
    // instance resolved against the page's own origin, not a bare relative string.
    const [, init] = fetchMock.mock.calls.find(([path]) =>
      String(path).includes('/api/auth/reset-password'),
    )!;
    expect(JSON.parse(init?.body as string)).toEqual({
      newPassword: 'a new secure passphrase',
      token: 'abc123',
    });
  });

  it('renders the invalid-or-expired message for an INVALID_TOKEN failure', async () => {
    setSearch('?token=expired-token');
    fetchMock.mockImplementation(async () =>
      fakeJsonResponse({ code: 'INVALID_TOKEN' }, { ok: false, status: 400 }),
    );
    const user = userEvent.setup();
    const first = render(<ResetPasswordPage />);
    await user.type(screen.getByLabelText('New password'), 'a new secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    // See forgot-password.test.tsx's matching comment: the mock `useMutation`'s error path
    // records the rejection on `routeState`, not React state, so it takes no effect until the
    // next render.
    await vi.waitFor(() => expect(routeState.mutationErrorValue).toBeDefined());
    first.unmount();

    render(<ResetPasswordPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('invalid or has expired');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('falls back to the generic message for a non-authentication failure', async () => {
    setSearch('?token=abc123');
    fetchMock.mockImplementation(async () =>
      fakeJsonResponse({ code: 'INTERNAL_SERVER_ERROR' }, { ok: false, status: 500 }),
    );
    const user = userEvent.setup();
    const first = render(<ResetPasswordPage />);
    await user.type(screen.getByLabelText('New password'), 'a new secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    await vi.waitFor(() => expect(routeState.mutationErrorValue).toBeDefined());
    first.unmount();

    render(<ResetPasswordPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not complete');
  });
});

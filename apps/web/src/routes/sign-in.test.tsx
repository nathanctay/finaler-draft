import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD_REQUIREMENTS_MESSAGE } from '@finaler-draft/config';
import type { SessionUser } from '../api.js';
import { fetchMock, removeQueries, resetRouteHarness, routeState } from '../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./sign-in.js');
const SignInPage = Route.options.component!;
const user: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

function contextWithSession(sessionUser: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(sessionUser) } } };
}

describe('sign-in page', () => {
  beforeEach(resetRouteHarness);

  it('redirects a signed-in visitor to /projects instead of rendering', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('Sign-in beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(user))).rejects.toMatchObject({
      options: { to: '/projects' },
    });
  });

  it('renders for a signed-out visitor rather than redirecting', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('Sign-in beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).resolves.toBeUndefined();
  });

  it('removes the cached session on a successful sign-in, so the /projects guard cannot reuse a stale signed-out answer', async () => {
    // Regression: visiting /sign-in caches ['session'] = null. `ensureQueryData` returns
    // cached data whenever an entry exists, even null, so unless sign-in removes that
    // entry, the /projects guard bounces a freshly signed-in visitor straight back here.
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.type(screen.getByLabelText('Password'), 'a secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['session'] }));
    expect(routeState.navigate).toHaveBeenCalledWith({ to: '/projects' });
  });

  it('signs in, creates an account, and communicates auth failures', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.type(screen.getByLabelText('Password'), 'a secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/sign-in/email', expect.any(Object)),
    );

    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Name'), 'Writer');
    await user.type(screen.getByLabelText('Confirm password'), 'a secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/sign-up/email', expect.any(Object)),
    );

    routeState.mutationError = true;
    render(<SignInPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not complete');
  });

  it('renders the specific message for invalid credentials, whether the password is wrong or the email is unregistered', async () => {
    fetchMock.mockImplementation(
      async () =>
        ({
          json: async () => ({ code: 'INVALID_EMAIL_OR_PASSWORD' }),
          ok: false,
          status: 401,
        }) as Response,
    );
    const user = userEvent.setup();
    const first = render(<SignInPage />);
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(routeState.mutationErrorValue).toBeDefined());
    first.unmount();

    render(<SignInPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password.');
  });

  it('renders the account-exists message for a duplicate email at sign-up', async () => {
    fetchMock.mockImplementation(
      async () =>
        ({
          json: async () => ({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }),
          ok: false,
          status: 422,
        }) as Response,
    );
    const user = userEvent.setup();
    const first = render(<SignInPage />);
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Name'), 'Writer');
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.type(screen.getByLabelText('Password'), 'a secure passphrase');
    await user.type(screen.getByLabelText('Confirm password'), 'a secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await vi.waitFor(() => expect(routeState.mutationErrorValue).toBeDefined());
    first.unmount();

    render(<SignInPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'An account already exists for this email address.',
    );
  });

  it('falls back to the generic message for a non-authentication failure, never surfacing a raw server message or code', async () => {
    fetchMock.mockImplementation(
      async () =>
        ({
          json: async () => ({ code: 'DATABASE_CONNECTION_LEAKED', message: 'sensitive detail' }),
          ok: false,
          status: 500,
        }) as Response,
    );
    const user = userEvent.setup();
    const first = render(<SignInPage />);
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.type(screen.getByLabelText('Password'), 'a secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(routeState.mutationErrorValue).toBeDefined());
    first.unmount();

    render(<SignInPage />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('could not complete');
    expect(alert).not.toHaveTextContent('sensitive detail');
    expect(alert).not.toHaveTextContent('DATABASE_CONNECTION_LEAKED');
  });

  it('clears an error raised in one mode after switching to the other', async () => {
    fetchMock.mockImplementation(
      async () =>
        ({
          json: async () => ({ code: 'INVALID_EMAIL_OR_PASSWORD' }),
          ok: false,
          status: 401,
        }) as Response,
    );
    const user = userEvent.setup();
    const first = render(<SignInPage />);
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(routeState.mutationErrorValue).toBeDefined());
    first.unmount();

    render(<SignInPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password.');

    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sign-in mode renders no confirm password field', () => {
    render(<SignInPage />);
    expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
  });

  it('blocks submission and shows an inline error when confirmation does not match', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Name'), 'Writer');
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.type(screen.getByLabelText('Password'), 'a secure passphrase');
    await user.type(screen.getByLabelText('Confirm password'), 'a different passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.getByRole('alert')).toHaveTextContent('do not match');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows submission once the confirmation matches the password', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Name'), 'Writer');
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.type(screen.getByLabelText('Password'), 'a secure passphrase');
    await user.type(screen.getByLabelText('Confirm password'), 'a secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/sign-up/email', expect.any(Object)),
    );
  });

  it('does not show a mismatch error before the confirm field is touched or submission attempted', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Password'), 'a secure passphrase');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the confirm password value and attempted-submit state when switching modes', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Password'), 'a secure passphrase');
    await user.type(screen.getByLabelText('Confirm password'), 'not matching');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByRole('alert')).toHaveTextContent('do not match');

    await user.click(screen.getByRole('button', { name: 'I already have an account' }));
    await user.click(screen.getByRole('button', { name: 'Create an account' }));

    expect(screen.getByLabelText('Confirm password')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('associates the password requirements text with the password input when registering', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    const passwordInput = screen.getByLabelText('Password');
    const describedBy = passwordInput.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const hint = document.getElementById(describedBy as string);
    expect(hint).toHaveTextContent(PASSWORD_REQUIREMENTS_MESSAGE);
  });

  it('states the password requirements only when registering, not when signing in', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    expect(screen.queryByText(PASSWORD_REQUIREMENTS_MESSAGE)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.getByText(PASSWORD_REQUIREMENTS_MESSAGE)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I already have an account' }));
    expect(screen.queryByText(PASSWORD_REQUIREMENTS_MESSAGE)).not.toBeInTheDocument();
  });

  it('toggles visibility independently for the password and confirm fields, preserving values', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    const passwordInput = screen.getByLabelText('Password');
    const confirmInput = screen.getByLabelText('Confirm password');
    await user.type(passwordInput, 'a secure passphrase');
    await user.type(confirmInput, 'a secure passphrase');

    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(confirmInput).toHaveAttribute('type', 'password');

    const showPasswordToggle = screen.getByRole('button', { name: 'Show password' });
    const showConfirmToggle = screen.getByRole('button', { name: 'Show confirm password' });
    expect(showPasswordToggle).toHaveAttribute('aria-pressed', 'false');
    expect(showConfirmToggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(showPasswordToggle);
    expect(passwordInput).toHaveAttribute('type', 'text');
    expect(passwordInput).toHaveValue('a secure passphrase');
    expect(confirmInput).toHaveAttribute('type', 'password');
    expect(showPasswordToggle).toHaveAttribute('aria-pressed', 'true');
    expect(showConfirmToggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(showConfirmToggle);
    expect(confirmInput).toHaveAttribute('type', 'text');
    expect(confirmInput).toHaveValue('a secure passphrase');
    expect(showConfirmToggle).toHaveAttribute('aria-pressed', 'true');

    await user.click(showPasswordToggle);
    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(passwordInput).toHaveValue('a secure passphrase');
    expect(showPasswordToggle).toHaveAttribute('aria-pressed', 'false');
    expect(confirmInput).toHaveAttribute('type', 'text');
    expect(confirmInput).toHaveValue('a secure passphrase');
  });

  it('offers a link to reset a forgotten password only in sign-in mode', async () => {
    const user = userEvent.setup();
    render(<SignInPage />);
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );

    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).not.toBeInTheDocument();
  });

  it('shows a check-your-email message instead of navigating when sign-up succeeds without creating a session', async () => {
    fetchMock.mockImplementation(
      async (path) =>
        ({
          json: async () => (path === '/api/auth/sign-up/email' ? { token: null } : []),
          ok: true,
          status: 200,
        }) as Response,
    );
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Name'), 'Writer');
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.type(screen.getByLabelText('Password'), 'a secure passphrase');
    await user.type(screen.getByLabelText('Confirm password'), 'a secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await screen.findByRole('heading', { name: 'Check your email.' });
    expect(screen.getByRole('status')).toHaveTextContent('writer@example.com');
    expect(routeState.navigate).not.toHaveBeenCalled();
    expect(removeQueries).not.toHaveBeenCalled();

    // The form itself is gone -- nothing left to submit until the link is followed -- but
    // switching back to sign-in is still available, and clears the message.
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I already have an account' }));
    expect(screen.queryByRole('heading', { name: 'Check your email.' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('navigates normally when sign-up returns a real session token', async () => {
    fetchMock.mockImplementation(
      async (path) =>
        ({
          json: async () => (path === '/api/auth/sign-up/email' ? { token: 'real-token' } : []),
          ok: true,
          status: 200,
        }) as Response,
    );
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Name'), 'Writer');
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.type(screen.getByLabelText('Password'), 'a secure passphrase');
    await user.type(screen.getByLabelText('Confirm password'), 'a secure passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await vi.waitFor(() => expect(routeState.navigate).toHaveBeenCalledWith({ to: '/projects' }));
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ['session'] });
  });
});

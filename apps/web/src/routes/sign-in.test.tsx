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
});

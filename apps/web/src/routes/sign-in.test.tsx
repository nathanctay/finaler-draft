import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD_REQUIREMENTS_MESSAGE } from '@finaler-draft/config';
import { fetchMock, resetRouteHarness, routeState } from '../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./sign-in.js');
const SignInPage = Route.options.component!;

describe('sign-in page', () => {
  beforeEach(resetRouteHarness);

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

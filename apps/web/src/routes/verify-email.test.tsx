import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./verify-email.js');
const VerifyEmailPage = Route.options.component!;

function setSearch(search: string) {
  window.history.replaceState(null, '', `/verify-email${search}`);
}

describe('verify-email page', () => {
  beforeEach(() => setSearch(''));

  it('reports success and links to sign in when the URL carries no error', () => {
    render(<VerifyEmailPage />);
    expect(screen.getByRole('heading', { name: 'Email verified.' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your email address is verified.');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  });

  it('reports failure and points to signing in again for a fresh link when the redirect carries an error', () => {
    setSearch('?error=TOKEN_EXPIRED');
    render(<VerifyEmailPage />);
    expect(
      screen.getByRole('heading', { name: 'This link is invalid or has expired.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in and we will send you a new one.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('treats any error code the same way, without leaking it into the message', () => {
    setSearch('?error=INVALID_TOKEN');
    render(<VerifyEmailPage />);
    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent('INVALID_TOKEN');
  });
});

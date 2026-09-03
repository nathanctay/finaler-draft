import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMock, resetRouteHarness, routeState } from './test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('./test/routeHarness.js')).reactQueryMock(),
);
vi.mock('./externalRedirect.js', () => ({ redirectToExternalUrl: vi.fn() }));

const { UpgradeDialog } = await import('./upgradeDialog.js');
const { redirectToExternalUrl } = await import('./externalRedirect.js');

describe('UpgradeDialog', () => {
  beforeEach(() => {
    resetRouteHarness();
    vi.mocked(redirectToExternalUrl).mockClear();
  });

  it('renders the heading and, when supplied, the reason it was opened', () => {
    render(<UpgradeDialog message="Free tier limit reached." onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Upgrade to Finaler Draft Pro' })).toBeVisible();
    expect(screen.getByText('Free tier limit reached.')).toBeVisible();
  });

  it('renders with no reason line when opened from the account menu directly', () => {
    render(<UpgradeDialog onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Upgrade to Finaler Draft Pro' })).toBeVisible();
  });

  it('starts a monthly Checkout Session and redirects to the returned url', async () => {
    const user = userEvent.setup();
    render(<UpgradeDialog onClose={vi.fn()} />);
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

  it('starts an annual Checkout Session on the other button', async () => {
    const user = userEvent.setup();
    render(<UpgradeDialog onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Upgrade annually' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/billing/checkout-session',
        expect.objectContaining({ body: JSON.stringify({ plan: 'annual' }), method: 'POST' }),
      ),
    );
  });

  it('surfaces feedback when starting checkout fails, without pretending it succeeded', () => {
    // The mock's `useMutation` (routeHarness.tsx) computes `isError` fresh from `routeState` on
    // every render rather than reacting to a later mutation outcome, so the failure has to be in
    // place before the first render -- the same convention `index.test.tsx`'s sign-out-failure
    // test already uses for the identical mock.
    routeState.mutationError = true;
    render(<UpgradeDialog onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not start checkout');
    expect(redirectToExternalUrl).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<UpgradeDialog onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes via the Close button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<UpgradeDialog onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('moves initial focus to the first control on mount', () => {
    render(<UpgradeDialog onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Upgrade monthly' })).toHaveFocus();
  });

  it('wraps Tab from the last focusable control back to the first, keeping focus inside the dialog', () => {
    render(<UpgradeDialog onClose={vi.fn()} />);
    const first = screen.getByRole('button', { name: 'Upgrade monthly' });
    const last = screen.getByRole('button', { name: 'Close' });
    last.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });

    expect(first).toHaveFocus();
  });

  it('wraps Shift+Tab from the first focusable control back to the last', () => {
    render(<UpgradeDialog onClose={vi.fn()} />);
    const first = screen.getByRole('button', { name: 'Upgrade monthly' });
    const last = screen.getByRole('button', { name: 'Close' });
    first.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });

    expect(last).toHaveFocus();
  });

  it('leaves focus alone on a Tab that neither leaves the first nor the last control', () => {
    render(<UpgradeDialog onClose={vi.fn()} />);
    const middle = screen.getByRole('button', { name: 'Upgrade annually' });
    middle.focus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });

    expect(middle).toHaveFocus();
  });
});

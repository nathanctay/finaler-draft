import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeJsonResponse, fetchMock, resetRouteHarness } from '../../test/routeHarness.js';

vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../test/routeHarness.js')).reactRouterMock(importOriginal),
);

/**
 * The Account info tab (`routes/account/index.tsx`, `progress/manage-account-page.md`). Real
 * `@tanstack/react-query`, not the shared `reactQueryMock()` every other route-level suite in
 * this directory uses -- see this file's own history for why (the shared mock's `useMutation` has
 * no real `isPending`/per-call result of its own, which the view/edit save flow genuinely needs).
 */
const { Route } = await import('./index.js');
const AccountInfoPage = Route.options.component!;

/** Mirrors `apiSession.ts`'s own `sessionUserSchema` exactly. `createdAt` and `emailVerified` are
 * **required** there, not optional: a fixture missing either one fails the parse and sends the page
 * into its load-failure branch, which is how every view-mode test here broke the moment the schema
 * was widened for "Member since" and the confirmation dot. Keep this type in step with that schema
 * rather than loosening either. */
type SessionUserFixture = {
  createdAt: string;
  email: string;
  emailVerified: boolean;
  id: string;
  name: string;
};

function sessionResponse(user: SessionUserFixture | null) {
  return fakeJsonResponse(user ? { user } : null);
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountInfoPage />
    </QueryClientProvider>,
  );
}

const writer: SessionUserFixture = {
  // A fixed instant, not `new Date()`: "Member since" renders a formatted date, and a fixture that
  // moved with the clock would make that assertion unwritable.
  createdAt: '2026-03-14T09:30:00.000Z',
  email: 'writer@example.com',
  emailVerified: true,
  id: 'writer-1',
  name: 'Writer',
};

/** The read-only value beside a view-mode label, found by that label's own text rather than by
 * role -- a plain `<span>` has no form-control role for `getByLabelText` to match, which is
 * exactly the gap `aria-labelledby` (not a real `<label htmlFor>`) has to close by hand here. */
function readOnlyValue(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  const id = label.getAttribute('id');
  expect(id).toBeTruthy();
  const value = document.querySelector(`[aria-labelledby="${id}"]`);
  if (!(value instanceof HTMLElement)) throw new Error(`No value associated with "${labelText}".`);
  return value;
}

/**
 * `get-session` reflects a mutable `user` that `update-user` actually writes to on success --
 * not a fixed literal -- so a test that saves a new name and then asserts the view-mode value
 * cannot race the background `invalidateQueries(['session'])` refetch `handleSave` fires: however
 * that refetch lands relative to the test's own assertions, it always answers with the name that
 * was actually "saved," the same way a real server would. `changeEmailOk`/`updateUserOk` only
 * ever affect whether that one write itself succeeds; `email` on `user` deliberately never
 * changes here, matching the real server's own verification-first behaviour this slice exists
 * to prove: `/change-email` never touches the stored address.
 */
function mockAuthEndpoints(options?: {
  changeEmailOk?: boolean;
  updateUserOk?: boolean;
  user?: SessionUserFixture;
}) {
  const user = { ...(options?.user ?? writer) };
  fetchMock.mockImplementation(async (path, init) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/auth/get-session')) return sessionResponse(user);
    if (url.includes('/api/auth/update-user') && method === 'POST') {
      if (options?.updateUserOk === false) {
        return fakeJsonResponse({ error: 'nope' }, { ok: false, status: 500 });
      }
      const body: { name?: string } = JSON.parse(String(init?.body));
      if (body.name !== undefined) user.name = body.name;
      return fakeJsonResponse({ status: true });
    }
    if (url.includes('/api/auth/change-email') && method === 'POST') {
      return fakeJsonResponse(
        { status: true },
        options?.changeEmailOk === false ? { ok: false, status: 500 } : {},
      );
    }
    return fakeJsonResponse({ status: true });
  });
}

/**
 * `mockAuthEndpoints` answers `{status: true}` to everything it does not recognise, which includes
 * `GET /api/billing/subscription` -- a shape `billingSubscriptionSchema` rejects, so `PlanRow`
 * lands in its error branch. That is fine for the tests that do not care about the plan, and wrong
 * for the ones that do, hence this: the same auth mock with a real billing answer layered over it.
 *
 * `subscription: null` is the genuine no-subscription response, not an omission -- the server sends
 * that for an account that never subscribed, and `planSummary` turns it into "Free".
 */
function mockWithBilling(subscription: unknown, options?: { billingFails?: boolean }) {
  mockAuthEndpoints();
  const previous = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (path, init) => {
    if (String(path).includes('/api/billing/subscription')) {
      return options?.billingFails === true
        ? fakeJsonResponse({ error: 'nope' }, { ok: false, status: 500 })
        : fakeJsonResponse({ subscription });
    }
    return previous(path, init);
  });
}

async function enterEditMode() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Edit info' }));
  return user;
}

describe('account/index (the Account info tab)', () => {
  beforeEach(resetRouteHarness);

  it('has no beforeLoad of its own -- the parent /account layout guards every tab once', () => {
    expect(Route.options.beforeLoad).toBeUndefined();
  });

  it('shows a loading state before the session has resolved', () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    renderPage();
    expect(screen.getByText('Loading your account…')).toBeVisible();
  });

  it('surfaces a load failure rather than a silently empty page', async () => {
    fetchMock.mockImplementation(async () =>
      fakeJsonResponse({ error: 'nope' }, { ok: false, status: 500 }),
    );
    renderPage();
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
  });

  describe('view mode', () => {
    beforeEach(() => mockAuthEndpoints());

    it('shows the name and email as read-only text, properly associated with their labels, and offers Edit info and Delete account', async () => {
      renderPage();
      await screen.findByText('Writer');
      expect(readOnlyValue('Name')).toHaveTextContent('Writer');
      expect(readOnlyValue('Email')).toHaveTextContent('writer@example.com');
      expect(screen.getByRole('button', { name: 'Edit info' })).toBeVisible();
      expect(screen.getByRole('link', { name: 'Delete account' })).toHaveAttribute(
        'href',
        '/account/delete',
      );
    });

    it('renders no input and no save control before Edit info is pressed', async () => {
      renderPage();
      await screen.findByText('Writer');
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
      expect(document.querySelector('form')).toBeNull();
    });
  });

  describe('entering and leaving edit mode', () => {
    beforeEach(() => mockAuthEndpoints());

    it('Edit info switches to one form with both fields pre-filled, Save info and Cancel, and moves focus to the name field', async () => {
      renderPage();
      await screen.findByText('Writer');
      await enterEditMode();

      expect(document.querySelectorAll('form')).toHaveLength(1);
      expect(document.querySelector('form')).toHaveAttribute('novalidate');
      const nameInput = screen.getByLabelText('Name');
      expect(nameInput).toHaveValue('Writer');
      expect(screen.getByLabelText('Email')).toHaveValue('writer@example.com');
      expect(screen.getByRole('button', { name: 'Save info' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Edit info' })).not.toBeInTheDocument();
      expect(nameInput).toHaveFocus();
    });

    it('Cancel discards edits, sends no request, and returns to the read-only values', async () => {
      renderPage();
      await screen.findByText('Writer');
      const user = await enterEditMode();
      await user.clear(screen.getByLabelText('Name'));
      await user.type(screen.getByLabelText('Name'), 'Someone Else');
      fetchMock.mockClear();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(readOnlyValue('Name')).toHaveTextContent('Writer');
      expect(
        fetchMock.mock.calls.find(([path]) => String(path).includes('/api/auth/update-user')),
      ).toBeUndefined();
      expect(screen.getByRole('button', { name: 'Edit info' })).toBeVisible();
    });
  });

  describe('Save info', () => {
    beforeEach(() => mockAuthEndpoints());

    it('issues no request at all when nothing was edited, and returns to view mode', async () => {
      renderPage();
      await screen.findByText('Writer');
      const user = await enterEditMode();
      fetchMock.mockClear();

      await user.click(screen.getByRole('button', { name: 'Save info' }));

      expect(await screen.findByRole('button', { name: 'Edit info' })).toBeVisible();
      expect(
        fetchMock.mock.calls.find(
          ([path]) =>
            String(path).includes('/api/auth/update-user') ||
            String(path).includes('/api/auth/change-email'),
        ),
      ).toBeUndefined();
    });

    it('blocks the save on a blank name, keeps edit mode, and focuses the name field -- without touching the server', async () => {
      renderPage();
      await screen.findByText('Writer');
      const user = await enterEditMode();
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      fetchMock.mockClear();

      await user.click(screen.getByRole('button', { name: 'Save info' }));

      expect(await screen.findByText('Enter your name.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Save info' })).toBeVisible(); // still edit mode
      expect(nameInput).toHaveFocus();
      expect(
        fetchMock.mock.calls.find(([path]) => String(path).includes('/api/auth/update-user')),
      ).toBeUndefined();
    });

    it('writes only the name when only the name changed', async () => {
      renderPage();
      await screen.findByText('Writer');
      const user = await enterEditMode();
      await user.clear(screen.getByLabelText('Name'));
      await user.type(screen.getByLabelText('Name'), 'New Name');
      fetchMock.mockClear();

      await user.click(screen.getByRole('button', { name: 'Save info' }));

      await screen.findByText('Name updated.');
      expect(
        fetchMock.mock.calls.find(([path]) => String(path).includes('/api/auth/change-email')),
      ).toBeUndefined();
      expect(readOnlyValue('Name')).toHaveTextContent('New Name');
      expect(screen.getByRole('button', { name: 'Edit info' })).toBeVisible();
    });

    it('writes only the email when only the email changed, and never claims the address changed yet', async () => {
      renderPage();
      await screen.findByText('Writer');
      const user = await enterEditMode();
      const emailInput = screen.getByLabelText('Email');
      await user.clear(emailInput);
      await user.type(emailInput, 'future-address@example.test');
      fetchMock.mockClear();

      await user.click(screen.getByRole('button', { name: 'Save info' }));

      const status = await screen.findByText(/we've sent a link there to confirm the change/);
      expect(status).toHaveTextContent(
        "If future-address@example.test isn't already used by another account, we've sent a link there to confirm the change. Your email stays writer@example.com until you follow it.",
      );
      expect(screen.queryByText('Name updated.')).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.find(([path]) => String(path).includes('/api/auth/update-user')),
      ).toBeUndefined();
      // The stored email is still the old one -- only a confirmation was sent, nothing applied.
      expect(readOnlyValue('Email')).toHaveTextContent('writer@example.com');
    });

    it('reports both fields distinctly when both changed: the name as saved, the email as pending -- never worded as though both took effect', async () => {
      renderPage();
      await screen.findByText('Writer');
      const user = await enterEditMode();
      await user.clear(screen.getByLabelText('Name'));
      await user.type(screen.getByLabelText('Name'), 'New Name');
      const emailInput = screen.getByLabelText('Email');
      await user.clear(emailInput);
      await user.type(emailInput, 'future-address@example.test');

      await user.click(screen.getByRole('button', { name: 'Save info' }));

      const nameStatus = await screen.findByText('Name updated.');
      const emailStatus = await screen.findByText(/we've sent a link there to confirm the change/);
      // Two separate sentences, not one merged claim -- and the email one never says "updated"
      // or "saved" the way the name's does.
      expect(nameStatus).not.toBe(emailStatus);
      expect(emailStatus).not.toHaveTextContent('Name updated');
      expect(emailStatus.textContent).not.toMatch(/email (?:updated|saved|changed)\b/i);
      expect(readOnlyValue('Name')).toHaveTextContent('New Name');
      expect(readOnlyValue('Email')).toHaveTextContent('writer@example.com');
    });

    it('on a failed write, stays in edit mode with the typed values intact', async () => {
      renderPage();
      await screen.findByText('Writer');
      const user = await enterEditMode();
      const nameInput = screen.getByLabelText('Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Will Not Save');
      mockAuthEndpoints({ updateUserOk: false });

      await user.click(screen.getByRole('button', { name: 'Save info' }));

      await screen.findByRole('alert');
      // Still edit mode -- Save info/Cancel are still there, and the typed value was never
      // reverted, cleared, or dropped back to the server's own value.
      expect(screen.getByRole('button', { name: 'Save info' })).toBeVisible();
      expect(screen.getByLabelText('Name')).toHaveValue('Will Not Save');
      expect(screen.queryByRole('button', { name: 'Edit info' })).not.toBeInTheDocument();
    });

    it('a partial failure reports the field that failed and the field that succeeded separately, still from edit mode', async () => {
      renderPage();
      await screen.findByText('Writer');
      const user = await enterEditMode();
      await user.clear(screen.getByLabelText('Name'));
      await user.type(screen.getByLabelText('Name'), 'New Name');
      const emailInput = screen.getByLabelText('Email');
      await user.clear(emailInput);
      await user.type(emailInput, 'future-address@example.test');
      mockAuthEndpoints({ changeEmailOk: false });

      await user.click(screen.getByRole('button', { name: 'Save info' }));

      await screen.findByText('Name updated.');
      expect(screen.getByRole('alert')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Save info' })).toBeVisible(); // still edit mode
      expect(screen.getByLabelText('Email')).toHaveValue('future-address@example.test');
    });
  });

  describe('the read-only facts', () => {
    it('shows Member since as a formatted date, never the raw ISO string', async () => {
      mockWithBilling(null);
      renderPage();
      await screen.findByText('Writer');
      const value = readOnlyValue('Member since');
      // Derived from the same `Intl` call `formatDate` uses rather than hardcoded: asserting
      // "March 14, 2026" would pass only in an en-US runner, and this suite should not quietly
      // depend on the machine's locale. What is actually being pinned is that a *formatted* date
      // is rendered and the raw ISO string is not -- `T09:30` cannot survive formatting in any
      // locale, which is what makes the mutation detectable.
      const monthName = new Date(writer.createdAt).toLocaleDateString(undefined, { month: 'long' });
      expect(value).toHaveTextContent(monthName);
      expect(value).toHaveTextContent('2026');
      expect(value.textContent ?? '').not.toContain('T09:30');
    });

    it('states the plan, and links to the Subscription tab rather than repeating its controls', async () => {
      mockWithBilling({
        cancelAtPeriodEnd: false,
        canceledAt: null,
        currentPeriodEnd: '2027-03-14T09:30:00.000Z',
        plan: 'annual',
        status: 'active',
      });
      renderPage();
      await screen.findByText('Writer');
      await screen.findByText(/Pro \(annual\)/);
      const planValue = readOnlyValue('Plan');
      expect(planValue).toHaveTextContent('Pro (annual)');
      expect(planValue).toHaveTextContent('Active');
      expect(planValue).toHaveTextContent('renews');
      expect(planValue).toHaveTextContent('2027');
      expect(screen.getByRole('link', { name: 'Manage Subscription' })).toHaveAttribute(
        'href',
        '/account/subscription',
      );
      // A glance, not a second set of actions -- the owner's own words. The Subscription tab's own
      // purchase and billing-portal controls must not be duplicated here.
      expect(screen.queryByRole('button', { name: /upgrade|subscribe|billing/i })).toBeNull();
    });

    it('says Free rather than claiming a plan when the account has no subscription', async () => {
      mockWithBilling(null);
      renderPage();
      await screen.findByText('Writer');
      await screen.findByText('Free');
      expect(readOnlyValue('Plan')).toHaveTextContent('Free');
    });

    it('keeps the rest of the panel intact when the billing request fails', async () => {
      mockWithBilling(null, { billingFails: true });
      renderPage();
      await screen.findByText('Writer');
      await screen.findByText(/could not be loaded/);
      // The point of the test: a failed *billing* fetch must not take the name, the email or
      // Member since down with it, and must not be mistaken for the whole page failing to load.
      expect(readOnlyValue('Name')).toHaveTextContent('Writer');
      expect(readOnlyValue('Email')).toHaveTextContent('writer@example.com');
      expect(readOnlyValue('Member since')).toHaveTextContent('2026');
      expect(screen.getByRole('button', { name: 'Edit info' })).toBeVisible();
    });
  });

  describe('the email confirmation dot', () => {
    it('is green and names itself confirmed when the stored address is verified', async () => {
      mockWithBilling(null);
      renderPage();
      await screen.findByText('Writer');
      const host = screen.getByRole('img', { name: 'Email confirmed' });
      expect(host.querySelector('.email-status-tooltip')).toHaveTextContent('Confirmed');
      const dot = host.querySelector('.email-status-dot');
      expect(dot?.className).toBe('email-status-dot');
    });

    it('is red and names itself unconfirmed when the stored address is not verified', async () => {
      mockAuthEndpoints({ user: { ...writer, emailVerified: false } });
      renderPage();
      await screen.findByText('Writer');
      const host = screen.getByRole('img', { name: 'Email not confirmed' });
      expect(host.querySelector('.email-status-tooltip')).toHaveTextContent('Not confirmed');
      expect(host.querySelector('.email-status-dot')?.className).toContain(
        'email-status-dot-unconfirmed',
      );
    });

    // The state must be reachable without perceiving colour: a red/green pair is the most
    // commonly confused one there is, so an accessible name and a tooltip are the two channels
    // that actually carry it. A bare styled span would pass a screenshot and fail a reader.
    it('carries its meaning in an accessible name, not only in colour', async () => {
      mockWithBilling(null);
      renderPage();
      await screen.findByText('Writer');
      const host = document.querySelector('.email-status');
      expect(host).toHaveAttribute('role', 'img');
      expect(host?.getAttribute('aria-label')).toBeTruthy();
      // Reachable without a pointer: a hover-only tooltip would hide the state from keyboard
      // users entirely, which is why the host takes a tab stop.
      expect(host).toHaveAttribute('tabindex', '0');
      // The bubble itself must not be announced -- the host's own name already says it.
      expect(host?.querySelector('.email-status-tooltip')).toHaveAttribute('aria-hidden', 'true');
    });

    it('sits beside the email value rather than replacing the removed Email status row', async () => {
      mockWithBilling(null);
      renderPage();
      await screen.findByText('Writer');
      // The owner removed the row outright: "I decided we dont need an email status field."
      expect(screen.queryByText('Email status')).toBeNull();
      const emailValue = readOnlyValue('Email');
      const dot = screen.getByRole('img', { name: /Email (not )?confirmed/ });
      expect(emailValue.parentElement?.contains(dot)).toBe(true);
    });
  });
});

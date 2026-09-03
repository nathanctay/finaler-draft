import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  entitlementSnapshot,
  invalidateQueries,
  projectId,
  resetRouteHarness,
  routeState,
  screenplayId,
} from '../../test/routeHarness.js';
import { MessageApiError } from '../../api.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../test/routeHarness.js')).reactRouterMock(importOriginal),
);
vi.mock('../../App.js', async () =>
  (await import('../../test/routeHarness.js')).editorModuleMock(),
);

const { Route } = await import('./$projectId.screenplays.$screenplayId.js');
const { api } = await import('../../api.js');
const ScreenplayPage = Route.options.component!;

/** Sets both concurrent queries this route now makes -- see routeHarness.tsx's own comment on
 * why a page with more than one `useQuery` call needs `routeState.queries`, not the shared
 * `routeState.query`, once entitlement joined the screenplay fetch on this page. */
function setQueries(screenplayData: unknown, entitlementData: unknown = entitlementSnapshot()) {
  routeState.queries[JSON.stringify(['screenplay', screenplayId])] = {
    data: screenplayData,
    isError: false,
    isLoading: false,
  };
  routeState.queries[JSON.stringify(['entitlement'])] = {
    data: entitlementData,
    isError: false,
    isLoading: false,
  };
}

describe('screenplay page', () => {
  beforeEach(resetRouteHarness);

  it('rejects malformed identifiers before the page consumes them', () => {
    const parse = Route.options.params?.parse as
      | ((params: { projectId: string; screenplayId: string }) => unknown)
      | undefined;
    expect(parse).toBeDefined();
    expect(parse?.({ projectId, screenplayId })).toEqual({ projectId, screenplayId });
    expect(() => parse?.({ projectId, screenplayId: 'bad-id' })).toThrow();
  });

  it('shows screenplay loading and unavailable states', () => {
    routeState.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<ScreenplayPage />);
    expect(screen.getByText('Opening screenplay…')).toBeVisible();
    routeState.query = { data: undefined, isError: true, isLoading: false };
    rerender(<ScreenplayPage />);
    expect(screen.getByText('This screenplay is unavailable.')).toBeVisible();
  });

  it('stays on the loading screen while entitlement is still resolving, even once the screenplay itself has loaded', () => {
    const script = {
      id: screenplayId,
      projectId,
      screenplay: {
        annotations: [],
        blocks: [],
        id: screenplayId,
        schemaVersion: 1,
        title: 'X',
        titlePages: [],
      },
      title: 'X',
      version: 1,
    };
    routeState.queries[JSON.stringify(['screenplay', screenplayId])] = {
      data: script,
      isError: false,
      isLoading: false,
    };
    routeState.queries[JSON.stringify(['entitlement'])] = {
      data: undefined,
      isError: false,
      isLoading: true,
    };
    render(<ScreenplayPage />);
    expect(screen.getByText('Opening screenplay…')).toBeVisible();
    expect(screen.queryByTestId('editor-instance')).not.toBeInTheDocument();
  });

  it('remounts the editor when route navigation opens another screenplay', async () => {
    const first = {
      id: screenplayId,
      projectId,
      screenplay: {
        annotations: [],
        blocks: [
          {
            id: '317e84fe-704d-40b4-aeea-aec01f628931',
            type: 'action',
            text: 'Route A screenplay.',
          },
        ],
        id: screenplayId,
        schemaVersion: 1,
        title: 'Route A',
        titlePages: [],
      },
      title: 'Route A',
      version: 1,
    };
    const secondId = 'ef16e524-c280-48cf-9091-20e57dbf817f';
    const second = {
      ...first,
      id: secondId,
      screenplay: {
        ...first.screenplay,
        blocks: [{ ...first.screenplay.blocks[0], text: 'Route B screenplay.' }],
        id: secondId,
        title: 'Route B',
      },
      title: 'Route B',
    };
    setQueries(first);
    const { rerender } = render(<ScreenplayPage />);
    expect(await screen.findByTestId('editor-instance')).toHaveTextContent('1:Route A');

    routeState.screenplayId = secondId;
    routeState.queries[JSON.stringify(['screenplay', secondId])] = {
      data: second,
      isError: false,
      isLoading: false,
    };
    rerender(<ScreenplayPage />);

    expect(await screen.findByTestId('editor-instance')).toHaveTextContent('2:Route B');
  });

  describe('entitlement-driven editability', () => {
    const script = {
      id: screenplayId,
      projectId,
      screenplay: {
        annotations: [],
        blocks: [],
        id: screenplayId,
        schemaVersion: 1,
        title: 'A Working Draft',
        titlePages: [],
      },
      title: 'A Working Draft',
      version: 1,
    };

    it('passes no entitlementReadOnly prop for an active subscriber, regardless of the editable slot', async () => {
      setQueries(script, entitlementSnapshot({ tier: 'paid', editableScreenplayId: null }));
      render(<ScreenplayPage />);
      await screen.findByTestId('editor-instance');
      expect(screen.queryByTestId('entitlement-readonly')).not.toBeInTheDocument();
    });

    it('passes no entitlementReadOnly prop when this screenplay is the account’s chosen editable one', async () => {
      setQueries(
        script,
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: screenplayId,
          candidateScreenplayIds: [screenplayId, 'a5e6c8b1-9f27-4b4a-8b3a-9a2c9c9a9a91'],
        }),
      );
      render(<ScreenplayPage />);
      await screen.findByTestId('editor-instance');
      expect(screen.queryByTestId('entitlement-readonly')).not.toBeInTheDocument();
    });

    it('renders read-only, offering the make-editable action, when no choice has been made yet', async () => {
      const other = 'a5e6c8b1-9f27-4b4a-8b3a-9a2c9c9a9a91';
      setQueries(
        script,
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: null,
          candidateScreenplayIds: [screenplayId, other],
        }),
      );
      render(<ScreenplayPage />);
      const banner = await screen.findByTestId('entitlement-readonly');
      expect(banner).toHaveTextContent(/haven.t chosen/i);
      expect(screen.getByRole('button', { name: 'Make this one editable' })).toBeVisible();
    });

    it('renders read-only, offering the make-editable action, when a different screenplay is already chosen', async () => {
      const other = 'a5e6c8b1-9f27-4b4a-8b3a-9a2c9c9a9a91';
      setQueries(
        script,
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: other,
          candidateScreenplayIds: [screenplayId, other],
        }),
      );
      render(<ScreenplayPage />);
      const banner = await screen.findByTestId('entitlement-readonly');
      expect(banner).toHaveTextContent(/different screenplay is currently/i);
      expect(screen.getByRole('button', { name: 'Make this one editable' })).toBeVisible();
    });

    it('renders read-only without offering the make-editable action for a screenplay that is not a candidate at all', async () => {
      setQueries(
        script,
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: null,
          candidateScreenplayIds: ['a5e6c8b1-9f27-4b4a-8b3a-9a2c9c9a9a91'],
        }),
      );
      render(<ScreenplayPage />);
      await screen.findByTestId('entitlement-readonly');
      expect(
        screen.queryByRole('button', { name: 'Make this one editable' }),
      ).not.toBeInTheDocument();
    });

    it('fails safe to read-only, without the make-editable action, when the entitlement fetch itself errors', async () => {
      routeState.queries[JSON.stringify(['screenplay', screenplayId])] = {
        data: script,
        isError: false,
        isLoading: false,
      };
      routeState.queries[JSON.stringify(['entitlement'])] = {
        data: undefined,
        isError: true,
        isLoading: false,
      };
      render(<ScreenplayPage />);
      await screen.findByTestId('entitlement-readonly');
      expect(
        screen.queryByRole('button', { name: 'Make this one editable' }),
      ).not.toBeInTheDocument();
    });

    it('calls switchEditableScreenplay and invalidates the entitlement query when the make-editable action is used', async () => {
      const other = 'a5e6c8b1-9f27-4b4a-8b3a-9a2c9c9a9a91';
      setQueries(
        script,
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: null,
          candidateScreenplayIds: [screenplayId, other],
        }),
      );
      const switchSpy = vi
        .spyOn(api, 'switchEditableScreenplay')
        .mockResolvedValue({ screenplayId, updatedAt: new Date().toISOString() });
      render(<ScreenplayPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Make this one editable' }));

      await waitFor(() => expect(switchSpy).toHaveBeenCalledWith(screenplayId));
      await waitFor(() =>
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['entitlement'] }),
      );
      switchSpy.mockRestore();
    });

    it('invalidates entitlement even when the switch itself fails, so a stale cooldown reading refreshes on the next render', async () => {
      const other = 'a5e6c8b1-9f27-4b4a-8b3a-9a2c9c9a9a91';
      setQueries(
        script,
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: other,
          candidateScreenplayIds: [screenplayId, other],
          // Not yet in cooldown as far as this app's last fetch knew -- the button is clickable,
          // and the 409 that comes back is the race this test exists to prove is still handled.
          cooldownEndsAt: null,
        }),
      );
      const switchSpy = vi
        .spyOn(api, 'switchEditableScreenplay')
        .mockRejectedValue(
          new MessageApiError(
            409,
            'The editable screenplay was changed recently; try again once the cooldown ends',
          ),
        );
      render(<ScreenplayPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Make this one editable' }));

      await waitFor(() => expect(switchSpy).toHaveBeenCalledWith(screenplayId));
      // The point of the fix: a *failed* switch still refreshes entitlement, not only a
      // successful one -- see the route's own `finally` and its comment on why.
      await waitFor(() =>
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['entitlement'] }),
      );
      switchSpy.mockRestore();
    });

    it('passes a formatted cooldownUntil, and a disabled button, when the account is already known to be inside its cooldown', async () => {
      const other = 'a5e6c8b1-9f27-4b4a-8b3a-9a2c9c9a9a91';
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      setQueries(
        script,
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: other,
          candidateScreenplayIds: [screenplayId, other],
          cooldownEndsAt: future,
        }),
      );
      render(<ScreenplayPage />);

      await screen.findByTestId('entitlement-readonly');
      expect(screen.getByRole('button', { name: 'Make this one editable' })).toBeDisabled();
      expect(screen.getByTestId('cooldown-until')).toHaveTextContent(
        new Date(future).toLocaleString(),
      );
    });

    it('passes no cooldownUntil, and an enabled button, once a past cooldownEndsAt has already elapsed', async () => {
      const other = 'a5e6c8b1-9f27-4b4a-8b3a-9a2c9c9a9a91';
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      setQueries(
        script,
        entitlementSnapshot({
          tier: 'restricted',
          editableScreenplayId: other,
          candidateScreenplayIds: [screenplayId, other],
          cooldownEndsAt: past,
        }),
      );
      render(<ScreenplayPage />);

      const button = await screen.findByRole('button', { name: 'Make this one editable' });
      expect(button).toBeEnabled();
      expect(screen.queryByTestId('cooldown-until')).not.toBeInTheDocument();
    });
  });
});

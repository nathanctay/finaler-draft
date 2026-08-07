import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectId, resetRouteHarness, routeState, screenplayId } from '../../test/routeHarness.js';

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
const ScreenplayPage = Route.options.component!;

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
    routeState.query = { data: first, isError: false, isLoading: false };
    const { rerender } = render(<ScreenplayPage />);
    expect(await screen.findByTestId('editor-instance')).toHaveTextContent('1:Route A');

    routeState.screenplayId = secondId;
    routeState.query = { data: second, isError: false, isLoading: false };
    rerender(<ScreenplayPage />);

    expect(await screen.findByTestId('editor-instance')).toHaveTextContent('2:Route B');
  });
});

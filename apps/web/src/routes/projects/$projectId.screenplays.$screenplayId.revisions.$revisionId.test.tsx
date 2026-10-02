import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../../api.js';
import {
  projectId,
  resetRouteHarness,
  revisionId,
  routeState,
  screenplayId,
} from '../../test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('../../test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../test/routeHarness.js')).reactRouterMock(importOriginal),
);
vi.mock('../../App.js', async () =>
  (await import('../../test/routeHarness.js')).editorModuleMock(),
);

const { Route } = await import('./$projectId.screenplays.$screenplayId.revisions.$revisionId.js');
const RevisionPreviewPage = Route.options.component!;

const revisionDetail = {
  id: revisionId,
  kind: 'named' as const,
  label: 'Draft 2',
  authoredBy: 'actor-1',
  createdAt: '2026-08-06T15:04:00.000Z',
  previewMetadata: { sceneCount: 3, blockCount: 40 },
  screenplayId,
  screenplay: {
    annotations: [],
    blocks: [],
    id: revisionId,
    schemaVersion: 1,
    title: 'A Working Draft, Revision 2',
    titlePages: [],
  },
};

const sessionUser: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

function contextWithSession(user: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(user) } } };
}

describe('revision preview page', () => {
  beforeEach(resetRouteHarness);

  it('redirects a signed-out visitor to /sign-in instead of rendering, the same guard every other protected route uses', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(sessionUser))).resolves.toBeUndefined();
  });

  it('rejects malformed identifiers before the page consumes them', () => {
    const parse = Route.options.params?.parse as
      | ((params: { projectId: string; revisionId: string; screenplayId: string }) => unknown)
      | undefined;
    expect(parse).toBeDefined();
    expect(parse?.({ projectId, revisionId, screenplayId })).toEqual({
      projectId,
      revisionId,
      screenplayId,
    });
    expect(() => parse?.({ projectId, revisionId: 'bad-id', screenplayId })).toThrow();
  });

  it('shows a loading state, then an unavailable state', () => {
    routeState.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<RevisionPreviewPage />);
    expect(screen.getByText('Opening revision…')).toBeVisible();

    routeState.query = { data: undefined, isError: true, isLoading: false };
    rerender(<RevisionPreviewPage />);
    expect(screen.getByText('This revision is unavailable.')).toBeVisible();
  });

  it('renders the editor with historicalRevision set, carrying the revision’s own screenplay -- and never onOpenRevisionHistory', async () => {
    routeState.query = { data: revisionDetail, isError: false, isLoading: false };
    render(<RevisionPreviewPage />);

    const editor = await screen.findByTestId('editor-instance');
    expect(editor).toHaveTextContent('A Working Draft, Revision 2');
    expect(screen.getByTestId('historical-revision')).toHaveTextContent('Draft 2');
    // History is never offered from inside history -- the route passes no
    // `onOpenRevisionHistory` at all.
    expect(screen.queryByRole('button', { name: 'Revision history…' })).not.toBeInTheDocument();
  });

  it('labels an automatic revision by its kind, not a blank label', async () => {
    routeState.query = {
      data: { ...revisionDetail, kind: 'idle_session', label: null },
      isError: false,
      isLoading: false,
    };
    render(<RevisionPreviewPage />);
    expect(await screen.findByTestId('historical-revision')).toHaveTextContent(
      'Automatic — idle session',
    );
  });
});

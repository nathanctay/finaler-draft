import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const projectId = '216ec49a-a6c6-49ff-8e2e-5994d5ca91dd';
const screenplayId = '38d8a6db-43f1-4b47-b8fc-c15a96f9ac0e';
const state = vi.hoisted(() => ({
  mutationError: false,
  navigate: vi.fn(),
  query: { data: undefined as unknown, isError: false, isLoading: false },
  screenplayId: '38d8a6db-43f1-4b47-b8fc-c15a96f9ac0e',
  editorMounts: 0,
}));
const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());
const invalidateQueries = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    mutationFn: () => Promise<unknown>;
    onSuccess?: (value: never) => unknown;
  }) => ({
    isError: state.mutationError,
    isPending: false,
    mutate: () =>
      void Promise.resolve(options.mutationFn()).then((value) =>
        options.onSuccess?.(value as never),
      ),
  }),
  useQuery: () => state.query,
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  Outlet: () => <div>Outlet</div>,
  useNavigate: () => state.navigate,
  useRouter: () => ({ navigate: state.navigate }),
  useParams: () => ({ projectId, screenplayId: state.screenplayId }),
}));
vi.mock('./App.js', async () => {
  const react = await vi.importActual<typeof React>('react');
  return {
    App: ({ initial }: { initial: { title: string } }) => {
      const [mountId] = react.useState(() => ++state.editorMounts);
      return <div data-testid="editor-instance">{`${mountId}:${initial.title}`}</div>;
    },
  };
});

import {
  ApplicationShell,
  ProjectPage,
  ProjectsPage,
  ScreenplayPage,
  SignInPage,
} from './WorkspaceApp.js';

describe('persisted workspace pages', () => {
  beforeEach(() => {
    state.mutationError = false;
    state.navigate.mockReset();
    state.query = { data: undefined, isError: false, isLoading: false };
    state.screenplayId = screenplayId;
    state.editorMounts = 0;
    invalidateQueries.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(
      async (path, init) =>
        ({
          json: async () =>
            path === '/api/projects' && init?.method === 'POST'
              ? { id: projectId, title: 'Feature' }
              : path === `/api/projects/${projectId}/screenplays` && init?.method === 'POST'
                ? { id: screenplayId, version: 1 }
                : [],
          ok: true,
          status: 200,
        }) as Response,
    );
  });

  it('renders the application outlet', () => {
    render(<ApplicationShell />);
    expect(screen.getByText('Outlet')).toBeVisible();
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
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/sign-up/email', expect.any(Object)),
    );

    state.mutationError = true;
    render(<SignInPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not complete');
  });

  it('displays project loading, error, data, and creation states', async () => {
    const user = userEvent.setup();
    state.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<ProjectsPage />);
    expect(screen.getByText('Loading projects…')).toBeVisible();
    state.query = { data: undefined, isError: true, isLoading: false };
    rerender(<ProjectsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    state.query = {
      data: [{ id: projectId, role: 'owner', title: 'Feature' }],
      isError: false,
      isLoading: false,
    };
    rerender(<ProjectsPage />);
    expect(screen.getByText('Feature')).toBeVisible();
    await user.type(screen.getByLabelText('New project title'), 'New Feature');
    fireEvent.submit(screen.getByRole('button', { name: 'New project' }).closest('form')!);
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await vi.waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['projects'] }),
    );
  });

  it('lists and creates screenplays for a project', async () => {
    const user = userEvent.setup();
    state.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<ProjectPage />);
    expect(screen.getByText('Loading scripts…')).toBeVisible();
    state.query = {
      data: [{ id: screenplayId, title: 'Draft' }],
      isError: false,
      isLoading: false,
    };
    rerender(<ProjectPage />);
    expect(screen.getByText('Draft')).toBeVisible();
    await user.clear(screen.getByLabelText('New screenplay title'));
    await user.type(screen.getByLabelText('New screenplay title'), 'Second Draft');
    fireEvent.submit(screen.getByRole('button', { name: 'New screenplay' }).closest('form')!);
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/projects/${projectId}/screenplays`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await vi.waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({
        to: '/projects/$projectId/screenplays/$screenplayId',
        params: { projectId, screenplayId },
      }),
    );
  });

  it('shows screenplay loading and unavailable states', () => {
    state.query = { data: undefined, isError: false, isLoading: true };
    const { rerender } = render(<ScreenplayPage />);
    expect(screen.getByText('Opening screenplay…')).toBeVisible();
    state.query = { data: undefined, isError: true, isLoading: false };
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
    state.query = { data: first, isError: false, isLoading: false };
    const { rerender } = render(<ScreenplayPage />);
    expect(await screen.findByTestId('editor-instance')).toHaveTextContent('1:Route A');

    state.screenplayId = secondId;
    state.query = { data: second, isError: false, isLoading: false };
    rerender(<ScreenplayPage />);

    expect(await screen.findByTestId('editor-instance')).toHaveTextContent('2:Route B');
  });
});

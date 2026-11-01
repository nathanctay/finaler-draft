import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../../api.js';

vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('../../test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { Route } = await import('./$projectId.js');
const ProjectLayout = Route.options.component!;
const sessionUser: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };
const projectId = '216ec49a-a6c6-49ff-8e2e-5994d5ca91dd';

function contextWithSession(user: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(user) } } };
}

/**
 * This route's two jobs: the auth guard every other project-scoped route already carries, and
 * since the app-bar-navigation slice, the one place "Projects / <project title>" is resolved for
 * every screen nested under it -- see the route's own module comment. Exercised directly against
 * `Route.options` (no router, no rendered breadcrumb) because that is where the `loader` and the
 * crumb resolvers actually live; `routeBreadcrumb.test.tsx` proves `RouteBreadcrumb` renders
 * whatever a route's `staticData.breadcrumb` produces, generically, so this file's job is only to
 * prove *this* route produces the right thing.
 */
describe('project layout route', () => {
  it('redirects a signed-out visitor to /sign-in instead of rendering', async () => {
    const beforeLoad = Route.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('Project layout beforeLoad is missing.');
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(sessionUser))).resolves.toBeUndefined();
  });

  it('renders its outlet with no chrome of its own', () => {
    render(<ProjectLayout />);
    expect(screen.getByText('Outlet')).toBeVisible();
  });

  describe('loader', () => {
    const loader = Route.options.loader as (opts: {
      context: { queryClient: { ensureQueryData: (options: unknown) => Promise<unknown> } };
      params: { projectId: string };
    }) => Promise<{ projectTitle: string | undefined }>;

    it('resolves the project’s own title from the same ["projects"] query the dashboard reads', async () => {
      const ensureQueryData = vi.fn().mockResolvedValue([
        { id: projectId, role: 'owner', title: 'Hollow Heart', updatedAt: '2026-01-01' },
        { id: 'other', role: 'owner', title: 'Someone Else', updatedAt: '2026-01-01' },
      ]);
      const result = await loader({
        context: { queryClient: { ensureQueryData } },
        params: { projectId },
      });

      expect(ensureQueryData).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['projects'] }),
      );
      expect(result).toEqual({ projectTitle: 'Hollow Heart' });
    });

    it('resolves undefined, never a placeholder, when this viewer is not a project member', async () => {
      // The screenplay-scoped-sharing case this route's own comment names: `["projects"]` is
      // scoped to project members, so a screenplay-only invitee's project simply is not in it.
      const ensureQueryData = vi.fn().mockResolvedValue([]);
      const result = await loader({
        context: { queryClient: { ensureQueryData } },
        params: { projectId },
      });
      expect(result).toEqual({ projectTitle: undefined });
    });
  });

  describe('staticData.breadcrumb', () => {
    const crumbs = Route.options.staticData!.breadcrumb!;

    it('contributes the fixed "Projects" ancestor, pointing at the dashboard', () => {
      const context = { loaderData: undefined, params: { projectId } };
      expect(crumbs[0]!.label(context)).toBe('Projects');
      expect(crumbs[0]!.to(context)).toBe('/projects');
    });

    it('contributes this project’s own title, read off the loader’s own result, pointing at this project', () => {
      const context = { loaderData: { projectTitle: 'Hollow Heart' }, params: { projectId } };
      expect(crumbs[1]!.label(context)).toBe('Hollow Heart');
      expect(crumbs[1]!.to(context)).toBe(`/projects/${projectId}`);
    });

    it('contributes no project-title label at all when the loader found none', () => {
      const context = { loaderData: { projectTitle: undefined }, params: { projectId } };
      expect(crumbs[1]!.label(context)).toBeUndefined();
    });
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRouteHarness, routeState } from './test/routeHarness.js';

vi.mock('@tanstack/react-query', async () =>
  (await import('./test/routeHarness.js')).reactQueryMock(),
);
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('./test/routeHarness.js')).reactRouterMock(importOriginal),
);

const { RouteBreadcrumb } = await import('./routeBreadcrumb.js');

/**
 * `RouteBreadcrumb`'s own contract, exercised directly against a fake match stack
 * (`routeState.matches`) rather than a real router -- see this component's own comment for why
 * the trail is derived from `useMatches()` instead of a hand-built array per screen.
 */
describe('route breadcrumb', () => {
  beforeEach(resetRouteHarness);

  it('renders nothing for a match stack with no breadcrumb-contributing route', () => {
    routeState.matches = [{ id: '/projects/', params: {}, staticData: {} }];
    render(<RouteBreadcrumb />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('drops a crumb that points at the page already being viewed', () => {
    /*
     * The project screen's own shape: the `$projectId` layout contributes the project's crumb so
     * every descendant inherits it, and that screen *is* the project -- so without this the trail
     * read "Projects / Hollow Heart / Hollow Heart", the first of them a link to the current page.
     * The owner reported it: "the first 'project2' seeming to be a link, but obviously it does not
     * go anywhere different because thats where we are."
     */
    routeState.matches = [
      {
        id: '/projects/$projectId',
        loaderData: { projectTitle: 'Hollow Heart' },
        params: { projectId: 'project-1' },
        pathname: '/projects/project-1',
        staticData: {
          breadcrumb: [
            { label: () => 'Projects', to: () => '/projects' },
            {
              label: (ctx: { loaderData: { projectTitle: string } }) => ctx.loaderData.projectTitle,
              to: (ctx: { params: { projectId: string } }) => `/projects/${ctx.params.projectId}`,
            },
          ],
        },
      },
      {
        id: '/projects/$projectId/',
        params: { projectId: 'project-1' },
        pathname: '/projects/project-1',
        staticData: {},
      },
    ];
    render(<RouteBreadcrumb />);
    expect(screen.getAllByRole('button').map((crumb) => crumb.textContent)).toEqual(['Projects']);
  });

  it('keeps that same crumb when it is a genuine ancestor rather than the current page', () => {
    // One level deeper -- the editor -- where the project crumb is a real way back up. The same
    // declaration must survive here, or the fix above would have cost every descendant its trail.
    routeState.matches = [
      {
        id: '/projects/$projectId',
        loaderData: { projectTitle: 'Hollow Heart' },
        params: { projectId: 'project-1' },
        pathname: '/projects/project-1',
        staticData: {
          breadcrumb: [
            { label: () => 'Projects', to: () => '/projects' },
            {
              label: (ctx: { loaderData: { projectTitle: string } }) => ctx.loaderData.projectTitle,
              to: (ctx: { params: { projectId: string } }) => `/projects/${ctx.params.projectId}`,
            },
          ],
        },
      },
      {
        id: '/projects/$projectId/screenplays/$screenplayId/',
        params: { projectId: 'project-1', screenplayId: 'screenplay-1' },
        pathname: '/projects/project-1/screenplays/screenplay-1',
        staticData: {},
      },
    ];
    render(<RouteBreadcrumb />);
    expect(screen.getAllByRole('button').map((crumb) => crumb.textContent)).toEqual([
      'Projects',
      'Hollow Heart',
    ]);
  });

  it('treats a trailing slash as the same path, not a different one', () => {
    // The router is not consistent about emitting them, and a crumb that stopped being recognised
    // as self-referential because of one would put the duplicate straight back.
    routeState.matches = [
      {
        id: '/projects/$projectId',
        params: { projectId: 'project-1' },
        pathname: '/projects/project-1/',
        staticData: {
          breadcrumb: [{ label: () => 'Hollow Heart', to: () => '/projects/project-1' }],
        },
      },
    ];
    render(<RouteBreadcrumb />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('concatenates every ancestor crumb across the whole match stack, in order', () => {
    routeState.matches = [
      { id: '__root__', params: {}, staticData: {} },
      {
        id: '/projects/$projectId',
        loaderData: { projectTitle: 'Hollow Heart' },
        params: { projectId: 'project-1' },
        staticData: {
          breadcrumb: [
            { label: () => 'Projects', to: () => '/projects' },
            {
              label: (ctx: { loaderData: { projectTitle: string } }) => ctx.loaderData.projectTitle,
              to: (ctx: { params: { projectId: string } }) => `/projects/${ctx.params.projectId}`,
            },
          ],
        },
      },
      {
        id: '/projects/$projectId/screenplays/$screenplayId/',
        params: { projectId: 'project-1', screenplayId: 'screenplay-1' },
        staticData: {},
      },
    ];
    render(<RouteBreadcrumb />);
    const crumbs = screen.getAllByRole('button');
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['Projects', 'Hollow Heart']);
  });

  it('omits a crumb whose label resolves to undefined, without breaking the ones around it', () => {
    // The real case: a screenplay reached through screenplay-scoped sharing, where the viewer is
    // not a member of the project and so cannot resolve its title (routes/projects/$projectId.tsx's
    // own comment). "Projects" alone, not a placeholder project name, is the honest result.
    routeState.matches = [
      {
        id: '/projects/$projectId',
        loaderData: { projectTitle: undefined },
        params: { projectId: 'project-1' },
        staticData: {
          breadcrumb: [
            { label: () => 'Projects', to: () => '/projects' },
            {
              label: (ctx: { loaderData: { projectTitle: string | undefined } }) =>
                ctx.loaderData.projectTitle,
              to: (ctx: { params: { projectId: string } }) => `/projects/${ctx.params.projectId}`,
            },
          ],
        },
      },
    ];
    render(<RouteBreadcrumb />);
    const crumbs = screen.getAllByRole('button');
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['Projects']);
  });

  it("navigates to the crumb's resolved destination on click, and only on click", async () => {
    const user = userEvent.setup();
    routeState.matches = [
      {
        id: '/projects/$projectId',
        loaderData: {},
        params: { projectId: 'project-1' },
        staticData: { breadcrumb: [{ label: () => 'Projects', to: () => '/projects' }] },
      },
    ];
    render(<RouteBreadcrumb />);
    expect(routeState.navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(routeState.navigate).toHaveBeenCalledWith({ to: '/projects' });
  });
});

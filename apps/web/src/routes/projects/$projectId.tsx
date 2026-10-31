import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { guardSessionUser } from '../../session.js';
// Augments `StaticDataRouteOption` with `breadcrumb` -- imported for the module augmentation's
// side effect as much as for the type it names below. See that module's own comment.
import type {} from '../../routeBreadcrumb.js';

function ProjectLayout() {
  return <Outlet />;
}

/**
 * The one place "Projects / <this project's title>" is declared, for every screen nested under a
 * project -- the project screen itself, the editor, and the revision-diff view (and, in Phase 4,
 * the Beat Board and Outline Editor it adds beneath a screenplay). Each of those routes shares
 * this layout as a `useMatches()` ancestor (confirmed against the generated `routeTree.gen.ts`),
 * so declaring the crumb once here, rather than on each of them, is what keeps them from being
 * able to disagree -- the same reasoning `progress/app-bar-navigation.md` records for the account
 * menu, applied to the trail instead.
 *
 * `loader`, not the `beforeLoad` the guard above already runs: `ensureQueryData` populates the
 * exact `['projects']` cache entry `routes/projects/index.tsx`'s own dashboard query already reads
 * (`guardSessionUser`'s own `sessionQueryOptions` is the established precedent for this pattern in
 * this codebase), so a writer who reached this screen from the dashboard pays no second request --
 * the loader resolves straight from cache. `match.loaderData` is a snapshot taken once per
 * navigation into this subtree, not a live subscription: a rename reached from *this* screen would
 * need to re-run the loader to show up in the crumb, and no screen nested under this layout offers
 * project rename (only the dashboard's own per-row menu does) -- see `progress/
 * app-bar-navigation.md`'s own note on this limitation and why it is accepted rather than solved
 * with a second, reactive data path for one unreachable case.
 *
 * `import('../../api.js')` inside the loader body, not a static top-of-file import: unlike
 * `component`, which `@tanstack/router-plugin` automatically splits into its own lazily-loaded
 * chunk (every other route file's component-only imports already benefit from this, invisibly), a
 * route's `loader` is part of the eagerly-bundled route-tree graph every visitor downloads before
 * any route even matches. A static import here pulled the *entire* `api.ts` module -- and, through
 * it, `@finaler-draft/screenplay`'s whole canonical schema tree -- into that eager bundle for the
 * first time, which is exactly the `apps/web`-side version of the reason `apiSession.ts` exists
 * apart from `api.ts` at all (that module's own top comment). `check:bundle-budget` caught the
 * regression directly: the entry chunk grew from 111.95 kB gzip to 126.68 kB, 6.68 kB over its 120
 * kB budget, for a loader that runs once per navigation into a project and can easily afford one
 * more dynamic import.
 */
export const Route = createFileRoute('/projects/$projectId')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  component: ProjectLayout,
  loader: async ({ context, params }) => {
    const { api } = await import('../../api.js');
    const projects = await context.queryClient.ensureQueryData({
      queryKey: ['projects'],
      queryFn: api.projects,
    });
    return { projectTitle: projects.find((project) => project.id === params.projectId)?.title };
  },
  params: { parse: (params) => z.object({ projectId: z.string().uuid() }).parse(params) },
  staticData: {
    breadcrumb: [
      { label: () => 'Projects', to: () => '/projects' },
      {
        // `undefined` -- never a placeholder string -- when this viewer is not a member of the
        // project (a screenplay reached through screenplay-scoped sharing, `listSharedScreenplays`
        // in apps/api/src/projects.ts): `['projects']` is scoped to project members, so `.find`
        // simply does not find it, and `RouteBreadcrumb` omits a crumb whose label is `undefined`
        // rather than render a project name this viewer was never actually shown.
        label: (ctx) => (ctx.loaderData as { projectTitle?: string }).projectTitle,
        to: (ctx) => `/projects/${ctx.params.projectId}`,
      },
    ],
  },
});

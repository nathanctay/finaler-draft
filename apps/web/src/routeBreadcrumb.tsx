import { useMatches, useNavigate } from '@tanstack/react-router';

/**
 * The context a crumb resolver sees: the specific match's own resolved params and whatever its
 * route's `loader` returned. Loose on purpose -- `StaticDataRouteOption` (the interface this
 * module augments below) is not generic, so every route's `breadcrumb` entries share one
 * signature regardless of that route's own params/loaderData shape. A route declaring a resolver
 * casts `loaderData` to what its own `loader` actually returns; see `routes/projects/$projectId.
 * tsx` for the one real example. This is the accepted, narrow cost of a single cross-route
 * extension point, not a gap to close with more generics -- the alternative is a type parameter
 * threaded through `@tanstack/router-core`'s own module augmentation, which that library does not
 * offer here.
 */
export interface RouteBreadcrumbContext {
  readonly params: Record<string, string>;
  readonly loaderData: unknown;
}

/**
 * One crumb a route contributes to the trail *above* itself -- never its own current segment,
 * which stays `documentTitle`/`documentType` on `ApplicationTitlebar`, supplied directly by
 * whatever is actually showing (see that module's own comment on why the editor's live,
 * inline-renameable title is never route-derived). `label` returning `undefined` omits the crumb
 * entirely rather than rendering a placeholder -- the one real case today is a screenplay reached
 * through screenplay-scoped sharing, where the viewer is not a member of the project and so has no
 * way to resolve its title (see `routes/projects/$projectId.tsx`'s own comment); "Projects / Act
 * One" with the project name silently dropped is honest, where a placeholder title would not be.
 */
export interface RouteBreadcrumbCrumb {
  readonly to: (context: RouteBreadcrumbContext) => string;
  readonly label: (context: RouteBreadcrumbContext) => string | undefined;
}

declare module '@tanstack/router-core' {
  interface StaticDataRouteOption {
    /**
     * Ancestor crumbs this route contributes to the trail, concatenated in match order (root to
     * leaf) by `RouteBreadcrumb` below. A route whose current segment IS an ancestor for deeper
     * routes -- `/projects/$projectId`, the pathless layout every project-scoped screen nests
     * under -- is exactly where that project's own crumb belongs, once, so every descendant
     * (the project screen, the editor, the revision-diff view, and whatever Phase 4's Beat Board
     * and Outline Editor add beneath the screenplay) inherits it for free instead of restating it.
     * A route with no shared parent to hang a crumb on, like `/deleted` (a top-level sibling of
     * `/projects`, not nested under it -- confirmed against `routeTree.gen.ts`), declares the
     * fixed crumb on itself instead; see that route's own comment.
     */
    breadcrumb?: readonly RouteBreadcrumbCrumb[];
  }
}

/**
 * Renders the ancestor trail for whichever screen currently has focus, derived from the matched
 * route stack (`useMatches()`) rather than hand-assembled per screen -- see
 * `progress/app-bar-navigation.md`'s "deriving the trail from the route tree" for why: a
 * hand-built array per screen is the exact drift risk this slice already removed once, for the
 * account menu, and Phase 4 adds at least one more level of nesting (a Beat Board and an Outline
 * Editor inside a screenplay) that a hand-built array would have to be edited in N places to grow
 * into. Adding a route to the trail later means one route declaring one `breadcrumb` entry, not
 * editing a shared list.
 *
 * Router-aware by design, and for exactly the reason `AccountMenu` is: `ApplicationTitlebar` (and
 * the editor, `App.tsx`, which carries it the rest of the way to that bar) must import neither
 * `@tanstack/react-router` nor `@tanstack/react-query`, so this component is never rendered by
 * either of those -- every screen that wants a working trail mounts `<RouteBreadcrumb />` itself
 * and hands the result in as the bar's `breadcrumb` prop, a plain `ReactNode`, the same shape
 * `accountMenu` already uses. The breadcrumb and the account menu are the same pattern applied
 * twice, not two coincidentally similar ones: a router-aware component, passed to a
 * dependency-free bar as a node.
 */
export function RouteBreadcrumb() {
  const matches = useMatches();
  const navigate = useNavigate();

  const crumbs = matches.flatMap((match) => {
    const context: RouteBreadcrumbContext = {
      loaderData: match.loaderData,
      params: match.params as Record<string, string>,
    };
    return (match.staticData.breadcrumb ?? []).flatMap((crumb) => {
      const label = crumb.label(context);
      if (label === undefined) return [];
      return [{ key: `${match.id}:${label}`, label, to: crumb.to(context) }];
    });
  });

  return (
    <>
      {crumbs.map((crumb) => (
        <span className="breadcrumb-segment" key={crumb.key}>
          <button
            className="breadcrumb-link"
            onClick={() =>
              // `to` is a plain resolved string, not one of the router's own literal route
              // patterns -- unavoidable for a crumb that can come from any route in the tree, see
              // `RouteBreadcrumbCrumb`'s own comment. `navigate`'s typed `to` union only accepts
              // those literals, so this is the one place that cast is necessary; every concrete
              // `navigate({ to: '/literal/path' })` call elsewhere in this app stays fully typed.
              void navigate({ to: crumb.to } as Parameters<typeof navigate>[0])
            }
            type="button"
          >
            {crumb.label}
          </button>
          <span aria-hidden="true" className="breadcrumb-separator">
            /
          </span>
        </span>
      ))}
    </>
  );
}

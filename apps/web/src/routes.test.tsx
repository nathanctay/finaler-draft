import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from './api.js';
import { routeTree } from './routeTree.gen.js';
import { Route as rootRoute } from './routes/__root.js';
import { Route as indexRoute } from './routes/index.js';
import { Route as projectRoute } from './routes/projects/$projectId.js';

const projectId = '216ec49a-a6c6-49ff-8e2e-5994d5ca91dd';
const user: SessionUser = { email: 'writer@example.com', id: 'writer-1', name: 'Writer' };

/** Stands in for the router context's `queryClient`, without a real QueryClient. */
function contextWithSession(sessionUser: SessionUser | null) {
  return { context: { queryClient: { ensureQueryData: vi.fn().mockResolvedValue(sessionUser) } } };
}

// Route components and their parameter parsers are covered by the tests colocated with
// each route module. This file covers the tree itself and the routes that have no page.
describe('file-based routes', () => {
  it('builds the application route tree and its layout routes', () => {
    expect(routeTree).toBeDefined();
    const RootLayout = rootRoute.options.component as ((props: object) => unknown) | undefined;
    expect(RootLayout?.({})).toBeDefined();
    const ProjectLayout = projectRoute.options.component as
      | ((props: object) => unknown)
      | undefined;
    expect(ProjectLayout?.({})).toBeDefined();
  });

  it('sends the application root straight to the right place, in one hop', async () => {
    const beforeLoad = indexRoute.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    expect(indexRoute.options.component).toBeUndefined();
    if (!beforeLoad) throw new Error('Root beforeLoad is missing.');

    await expect(beforeLoad(contextWithSession(user))).rejects.toMatchObject({
      options: { to: '/projects' },
    });
    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
  });

  it('rejects a malformed project identifier before the layout consumes it', () => {
    const projectParse = projectRoute.options.params?.parse;
    expect(projectParse).toBeDefined();
    if (!projectParse) throw new Error('Route parameter parser is missing.');
    expect(projectParse({ projectId })).toEqual({ projectId });
    expect(() => projectParse({ projectId: 'bad-id' })).toThrow();
  });

  it('keeps a signed-out visitor out of a project and its screenplays', async () => {
    const beforeLoad = projectRoute.options.beforeLoad as
      | ((opts: ReturnType<typeof contextWithSession>) => Promise<void>)
      | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('Project layout beforeLoad is missing.');

    await expect(beforeLoad(contextWithSession(null))).rejects.toMatchObject({
      options: { to: '/sign-in' },
    });
    await expect(beforeLoad(contextWithSession(user))).resolves.toBeUndefined();
  });
});

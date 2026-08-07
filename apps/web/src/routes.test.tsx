import { describe, expect, it } from 'vitest';
import { routeTree } from './routeTree.gen.js';
import { Route as rootRoute } from './routes/__root.js';
import { Route as indexRoute } from './routes/index.js';
import { Route as projectRoute } from './routes/projects/$projectId.js';

const projectId = '216ec49a-a6c6-49ff-8e2e-5994d5ca91dd';

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

  it('sends the application root to the sign-in route', () => {
    const beforeLoad = indexRoute.options.beforeLoad as (() => void) | undefined;
    expect(beforeLoad).toBeDefined();
    expect(indexRoute.options.component).toBeUndefined();
    let thrown: unknown;
    try {
      beforeLoad?.();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ options: { to: '/sign-in' } });
  });

  it('rejects a malformed project identifier before the layout consumes it', () => {
    const projectParse = projectRoute.options.params?.parse;
    expect(projectParse).toBeDefined();
    if (!projectParse) throw new Error('Route parameter parser is missing.');
    expect(projectParse({ projectId })).toEqual({ projectId });
    expect(() => projectParse({ projectId: 'bad-id' })).toThrow();
  });
});

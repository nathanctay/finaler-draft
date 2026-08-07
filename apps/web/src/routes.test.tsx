import { describe, expect, it } from 'vitest';
import { routeTree } from './routeTree.gen.js';
import { Route as rootRoute } from './routes/__root.js';
import { Route as projectRoute } from './routes/projects/$projectId.js';
import { Route as screenplayRoute } from './routes/projects/$projectId.screenplays.$screenplayId.js';

const projectId = '216ec49a-a6c6-49ff-8e2e-5994d5ca91dd';
const screenplayId = '38d8a6db-43f1-4b47-b8fc-c15a96f9ac0e';

describe('file-based routes', () => {
  it('builds every public application route', () => {
    expect(routeTree).toBeDefined();
    expect(projectRoute.options.component).toBeDefined();
    expect(screenplayRoute.options.component).toBeDefined();
    const RootLayout = rootRoute.options.component as ((props: object) => unknown) | undefined;
    expect(RootLayout?.({})).toBeDefined();
  });

  it('rejects malformed route parameters before pages consume them', () => {
    const projectParse = projectRoute.options.params?.parse;
    const screenplayParse = screenplayRoute.options.params?.parse as
      | ((params: { projectId: string; screenplayId: string }) => unknown)
      | undefined;
    expect(projectParse).toBeDefined();
    expect(screenplayParse).toBeDefined();
    if (!projectParse || !screenplayParse) throw new Error('Route parameter parser is missing.');
    expect(projectParse({ projectId })).toEqual({ projectId });
    expect(screenplayParse({ projectId, screenplayId })).toEqual({ projectId, screenplayId });
    expect(() => projectParse({ projectId: 'bad-id' })).toThrow();
    expect(() => screenplayParse({ projectId, screenplayId: 'bad-id' })).toThrow();
  });
});

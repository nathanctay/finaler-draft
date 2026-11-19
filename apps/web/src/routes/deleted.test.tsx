import { describe, expect, it } from 'vitest';

/**
 * `/deleted` is a pure redirect now (`routes/account.deleted.tsx` carries the real page), matching
 * `routes/index.tsx`'s own shape -- see this route's own module comment for why the path is kept
 * at all rather than removed outright. No router/query-client mock is needed here: unlike every
 * guarded route in this app, this `beforeLoad` takes no `context` and redirects unconditionally,
 * so there is nothing to stub.
 */
describe('/deleted (redirect)', () => {
  it('redirects to /account/deleted unconditionally', async () => {
    const { Route } = await import('./deleted.js');
    const beforeLoad = Route.options.beforeLoad as (() => void) | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('/deleted beforeLoad is missing.');

    // `redirect()`'s own thrown value is a plain object (`{options: {to}}`), not an `Error` --
    // caught directly rather than through vitest's `.toThrow()`, which only inspects `Error`
    // instances.
    let thrown: unknown;
    try {
      beforeLoad();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ options: { to: '/account/deleted' } });
  });
});

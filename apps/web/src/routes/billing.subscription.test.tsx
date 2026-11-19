import { describe, expect, it } from 'vitest';

/**
 * `/billing/subscription` is a pure redirect now (`routes/account.subscription.tsx` carries the
 * real page), matching `routes/index.tsx`'s own shape and `routes/deleted.test.tsx`'s identical
 * reasoning for this test's own shape -- see this route's own module comment for why the path is
 * kept at all rather than removed outright.
 */
describe('/billing/subscription (redirect)', () => {
  it('redirects to /account/subscription unconditionally', async () => {
    const { Route } = await import('./billing.subscription.js');
    const beforeLoad = Route.options.beforeLoad as (() => void) | undefined;
    expect(beforeLoad).toBeDefined();
    if (!beforeLoad) throw new Error('/billing/subscription beforeLoad is missing.');

    let thrown: unknown;
    try {
      beforeLoad();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ options: { to: '/account/subscription' } });
  });
});

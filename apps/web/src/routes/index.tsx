import { createFileRoute, redirect } from '@tanstack/react-router';
import { guardSessionUser } from '../session.js';

// A pure redirect with no component: it sends the visitor straight to the right place
// in one hop rather than always landing on /sign-in and bouncing a second time. A
// landing page for signed-out visitors is deferred.
export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    throw redirect({ to: user ? '/projects' : '/sign-in' });
  },
});

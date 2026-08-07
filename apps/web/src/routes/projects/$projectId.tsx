import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { guardSessionUser } from '../../session.js';

function ProjectLayout() {
  return <Outlet />;
}

export const Route = createFileRoute('/projects/$projectId')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  component: ProjectLayout,
  params: { parse: (params) => z.object({ projectId: z.string().uuid() }).parse(params) },
});

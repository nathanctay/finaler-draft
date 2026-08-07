import { createFileRoute, Outlet } from '@tanstack/react-router';
import { z } from 'zod';

function ProjectLayout() {
  return <Outlet />;
}

export const Route = createFileRoute('/projects/$projectId')({
  component: ProjectLayout,
  params: { parse: (params) => z.object({ projectId: z.string().uuid() }).parse(params) },
});

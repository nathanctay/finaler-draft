import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ScreenplayPage } from '../../WorkspaceApp.js';

export const Route = createFileRoute('/projects/$projectId/screenplays/$screenplayId')({
  component: ScreenplayPage,
  params: {
    parse: (params) =>
      z.object({ projectId: z.string().uuid(), screenplayId: z.string().uuid() }).parse(params),
  },
});

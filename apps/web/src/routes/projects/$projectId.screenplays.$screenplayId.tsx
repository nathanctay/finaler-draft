import { createFileRoute, useParams } from '@tanstack/react-router';
import { z } from 'zod';
import { api, type PersistedScreenplay } from '../../api.js';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';

export const Route = createFileRoute('/projects/$projectId/screenplays/$screenplayId')({
  component: ScreenplayPage,
  params: {
    parse: (params) =>
      z.object({ projectId: z.string().uuid(), screenplayId: z.string().uuid() }).parse(params),
  },
});

const EditorWorkspace = lazy(async () => ({ default: (await import('../../App.js')).App }));

function ScreenplayPage() {
  const { screenplayId } = useParams({ from: '/projects/$projectId/screenplays/$screenplayId' });
  // This query is intentionally consumed once. The editor owns the immutable route snapshot thereafter.
  const screenplay = useQuery({
    queryKey: ['screenplay', screenplayId],
    queryFn: () => api.screenplay(screenplayId),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  if (screenplay.isLoading) return <main className="loading-screen">Opening screenplay…</main>;
  if (screenplay.isError)
    return <main className="loading-screen">This screenplay is unavailable.</main>;
  return (
    <Suspense fallback={<main className="loading-screen">Loading editor…</main>}>
      <EditorWorkspace key={screenplayId} initial={screenplay.data as PersistedScreenplay} />
    </Suspense>
  );
}

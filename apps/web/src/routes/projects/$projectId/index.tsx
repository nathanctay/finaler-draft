import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useParams, useRouter } from '@tanstack/react-router';
import { api } from '../../../api.js';

export const Route = createFileRoute('/projects/$projectId/')({ component: ProjectPage });

function ProjectPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/' });
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('Untitled Screenplay');
  const scripts = useQuery({
    queryKey: ['screenplays', projectId],
    queryFn: () => api.screenplays(projectId),
  });
  const create = useMutation({
    mutationFn: async () => {
      const id = crypto.randomUUID();
      return api.createScreenplay(projectId, title, {
        annotations: [],
        blocks: [],
        id,
        schemaVersion: 1,
        title,
        titlePages: [],
      });
    },
    onSuccess: (script) => {
      void queryClient.invalidateQueries({ queryKey: ['screenplays', projectId] });
      return router.navigate({
        to: '/projects/$projectId/screenplays/$screenplayId',
        params: { projectId, screenplayId: script.id },
      });
    },
  });
  return (
    <main className="project-screen">
      <header className="project-header">
        <Link to="/projects">Projects</Link>
      </header>
      <section className="project-list">
        <p className="eyebrow">PROJECT</p>
        <h1>Screenplays</h1>
        <form
          className="create-row"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <input
            aria-label="New screenplay title"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button className="primary-button" type="submit">
            New screenplay
          </button>
        </form>
        {scripts.isLoading ? (
          <p>Loading scripts…</p>
        ) : (
          <ul>
            {scripts.data?.map((script) => (
              <li key={script.id}>
                <Link
                  to="/projects/$projectId/screenplays/$screenplayId"
                  params={{ projectId, screenplayId: script.id }}
                >
                  {script.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

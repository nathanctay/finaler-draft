import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { api } from '../../api.js';
import { guardSessionUser } from '../../session.js';

export const Route = createFileRoute('/projects/')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (!user) throw redirect({ to: '/sign-in' });
  },
  component: ProjectsPage,
});

function ProjectsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const create = useMutation({
    mutationFn: () => api.createProject(title),
    onSuccess: () => {
      setTitle('');
      return queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const signOut = useMutation({
    mutationFn: api.signOut,
    onSuccess: () => {
      // Clearing the whole cache, not just ['session'], keeps the next person to sign
      // in on this browser from seeing this user's project and screenplay titles.
      queryClient.clear();
      return navigate({ to: '/sign-in' });
    },
  });
  return (
    <main className="project-screen">
      <header className="project-header">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
        <button
          className="sign-out-button"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
          type="button"
        >
          {signOut.isPending ? 'Signing out…' : 'Sign out'}
        </button>
      </header>
      {signOut.isError && (
        <p className="sign-out-error" role="alert">
          Sign out failed. Try again.
        </p>
      )}
      <section className="project-list">
        <p className="eyebrow">PRIVATE PROJECTS</p>
        <h1>Your writing desk</h1>
        <form
          className="create-row"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <input
            aria-label="New project title"
            placeholder="New project title"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button className="primary-button" disabled={create.isPending} type="submit">
            New project
          </button>
        </form>
        {projects.isLoading ? (
          <p>Loading projects…</p>
        ) : projects.isError ? (
          <p role="alert">Projects could not be loaded.</p>
        ) : (
          <ul>
            {(projects.data ?? []).map((project) => (
              <li key={project.id}>
                <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                  <strong>{project.title}</strong>
                  <span>{project.role}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

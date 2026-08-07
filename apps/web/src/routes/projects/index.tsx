import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { api } from '../../api.js';

export const Route = createFileRoute('/projects/')({ component: ProjectsPage });

function ProjectsPage() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const create = useMutation({
    mutationFn: () => api.createProject(title),
    onSuccess: () => {
      setTitle('');
      return queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  return (
    <main className="project-screen">
      <header className="project-header">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
        <Link to="/sign-in">Account</Link>
      </header>
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

import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { api, type PersistedScreenplay } from './api.js';

const EditorWorkspace = lazy(() => import('./App.js').then((module) => ({ default: module.App })));

export function ApplicationShell() {
  return <Outlet />;
}

export function SignInPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const authentication = useMutation({
    mutationFn: () =>
      mode === 'sign-in' ? api.signIn(email, password) : api.signUp(name, email, password),
    onSuccess: () => void navigate({ to: '/projects' }),
  });
  return (
    <main className="entry-screen">
      <section className="entry-card" aria-labelledby="entry-title">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
        <p className="eyebrow">WRITER WORKSPACE</p>
        <h1 id="entry-title">
          {mode === 'sign-in' ? 'Return to the work.' : 'Set up your writing desk.'}
        </h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            authentication.mutate();
          }}
        >
          {mode === 'sign-up' && (
            <label>
              Name
              <input required value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          )}
          <label>
            Email
            <input
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              required
              minLength={12}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="primary-button" disabled={authentication.isPending} type="submit">
            {authentication.isPending
              ? 'Working…'
              : mode === 'sign-in'
                ? 'Sign in'
                : 'Create account'}
          </button>
        </form>
        {authentication.isError && (
          <p role="alert">We could not complete that request. Check your details and try again.</p>
        )}
        <button
          className="text-button"
          onClick={() => setMode((value) => (value === 'sign-in' ? 'sign-up' : 'sign-in'))}
          type="button"
        >
          {mode === 'sign-in' ? 'Create an account' : 'I already have an account'}
        </button>
      </section>
    </main>
  );
}

export function ProjectsPage() {
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

export function ProjectPage() {
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

export function ScreenplayPage() {
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

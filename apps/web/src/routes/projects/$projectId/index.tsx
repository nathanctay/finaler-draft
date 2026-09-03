import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useParams, useRouter } from '@tanstack/react-router';
import { createDefaultTitlePage, DEFAULT_DOCUMENT_SETTINGS } from '@finaler-draft/screenplay';
import { api, MessageApiError, type ScreenplaySummary } from '../../../api.js';
import { DeletedRow } from '../../../components/DeletedRow.js';
import { OverflowMenu } from '../../../components/OverflowMenu.js';

// Lazy, same reasoning as routes/projects/index.tsx's identical import: this dialog is only
// needed once a writer actually hits the free-tier limit or opens it, not on every visit to this
// page, so it stays out of this route's own eagerly-loaded chunk graph.
const UpgradeDialog = lazy(async () => ({
  default: (await import('../../../upgradeDialog.js')).UpgradeDialog,
}));

export const Route = createFileRoute('/projects/$projectId/')({ component: ProjectPage });

/**
 * Mirrors ProjectRow in routes/projects/index.tsx: the normal Link-plus-menu form only, never
 * rendered alongside DeletedRow for the same screenplay -- see that file's comment for why.
 */
function ScreenplayRow({
  onDeleted,
  projectId,
  screenplay,
}: {
  onDeleted: () => void;
  projectId: string;
  screenplay: ScreenplaySummary;
}) {
  const deleteMutation = useMutation({
    mutationFn: () => api.deleteScreenplay(screenplay.id),
    onSuccess: onDeleted,
  });
  return (
    <div className="project-row">
      <Link
        className="project-row-link"
        params={{ projectId, screenplayId: screenplay.id }}
        to="/projects/$projectId/screenplays/$screenplayId"
      >
        {screenplay.title}
      </Link>
      <OverflowMenu
        items={[{ label: 'Delete', onSelect: () => deleteMutation.mutate() }]}
        label={`Screenplay actions for ${screenplay.title}`}
      />
      {deleteMutation.isError && (
        <p className="field-error" role="alert">
          Delete failed. Try again.
        </p>
      )}
    </div>
  );
}

function ProjectPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/' });
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('Untitled Screenplay');
  // See the identical field on ProjectsPage (routes/projects/index.tsx) for what happens when
  // this affordance goes away: it persists until Undo or navigation away, never on a timer, and
  // survives an incidental background refetch via the orphaned-id rendering below.
  const [deletedScreenplays, setDeletedScreenplays] = useState<Record<string, string>>({});
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false);
  const scripts = useQuery({
    queryKey: ['screenplays', projectId],
    queryFn: () => api.screenplays(projectId),
  });
  const create = useMutation({
    mutationFn: async () => {
      const id = crypto.randomUUID();
      // plan.md's "Title page": "A new screenplay gets a dedicated title page by default."
      // createDefaultTitlePage seeds only real content (the title just typed, and the standard
      // "written by" credit) -- see its own doc comment for why author/contact stay absent
      // rather than holding placeholder strings.
      return api.createScreenplay(projectId, title, {
        annotations: [],
        blocks: [],
        id,
        schemaVersion: 1,
        title,
        titlePages: [createDefaultTitlePage(crypto.randomUUID(), title)],
        documentSettings: DEFAULT_DOCUMENT_SETTINGS,
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

  function handleRestored(screenplayId: string) {
    setDeletedScreenplays((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== screenplayId)),
    );
    void queryClient.invalidateQueries({ queryKey: ['screenplays', projectId] });
  }

  const liveScreenplays = scripts.data ?? [];
  const orphanedDeletedIds = Object.keys(deletedScreenplays).filter(
    (id) => !liveScreenplays.some((script) => script.id === id),
  );
  // 402 Payment Required is app.ts's dedicated status for `EntitlementLimitError` specifically
  // (see that route's own comment), distinct from any other reason screenplay creation could
  // fail -- so this is an unambiguous signal to show the upgrade prompt rather than a bare error,
  // and `serverMessage` is the exact sentence entitlements.ts wrote to explain the limit.
  const limitError =
    create.error instanceof MessageApiError && create.error.status === 402
      ? create.error
      : undefined;

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
        {limitError && (
          <div className="upgrade-banner" role="alert">
            <p>{limitError.serverMessage}</p>
            <button
              className="primary-button"
              onClick={() => setUpgradeDialogOpen(true)}
              type="button"
            >
              Upgrade to Pro
            </button>
          </div>
        )}
        {upgradeDialogOpen && (
          <Suspense fallback={null}>
            <UpgradeDialog
              message={limitError?.serverMessage}
              onClose={() => setUpgradeDialogOpen(false)}
            />
          </Suspense>
        )}
        {scripts.isLoading ? (
          <p>Loading scripts…</p>
        ) : (
          <ul>
            {liveScreenplays.map((screenplay) =>
              deletedScreenplays[screenplay.id] === undefined ? (
                <li key={screenplay.id}>
                  <ScreenplayRow
                    onDeleted={() =>
                      setDeletedScreenplays((current) => ({
                        ...current,
                        [screenplay.id]: screenplay.title,
                      }))
                    }
                    projectId={projectId}
                    screenplay={screenplay}
                  />
                </li>
              ) : (
                <li key={screenplay.id}>
                  <DeletedRow
                    onRestored={() => handleRestored(screenplay.id)}
                    restore={() => api.restoreScreenplay(screenplay.id)}
                    title={deletedScreenplays[screenplay.id]!}
                  />
                </li>
              ),
            )}
            {orphanedDeletedIds.map((id) => (
              <li key={id}>
                <DeletedRow
                  onRestored={() => handleRestored(id)}
                  restore={() => api.restoreScreenplay(id)}
                  title={deletedScreenplays[id]!}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

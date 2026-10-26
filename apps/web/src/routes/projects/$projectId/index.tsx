import { lazy, Suspense, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useParams, useRouter } from '@tanstack/react-router';
import {
  createDefaultTitlePage,
  DEFAULT_DOCUMENT_SETTINGS,
  type Screenplay,
} from '@finaler-draft/screenplay';
import type {
  FdxImportResult,
  FdxSkippedTally,
  FdxUnknownType,
  FdxUnknownTypeResolutions,
} from '@finaler-draft/fdx';
import { api, MessageApiError, type ScreenplaySummary } from '../../../api.js';
import { CreateScreenplaySplitButton } from '../../../components/CreateScreenplaySplitButton.js';
import { DeletedRow } from '../../../components/DeletedRow.js';
import { OverflowMenu } from '../../../components/OverflowMenu.js';

// The route-level title schema (apps/api/src/projects.ts's `projectTitle`:
// `z.string().trim().min(1).max(200)`) is stricter than `screenplaySchema`'s own 250-character
// `titleSchema` -- both the top-level `title` argument `api.createScreenplay` sends and the
// nested `screenplay.title` must satisfy it, so this is the bound the import control clamps to,
// not `MAX_SCREENPLAY_TITLE_LENGTH`.
const MAX_CREATE_SCREENPLAY_TITLE_LENGTH = 200;

/**
 * The imported screenplay's title comes from the title page Final Draft actually carried;
 * falling back to the uploaded filename (extension stripped) only when the file had none. This
 * mirrors `createDefaultTitlePage`'s own reasoning just below in `create`'s `mutationFn`: never
 * store a placeholder string a writer would have to remember to overwrite. Clamped to this
 * route's stricter 200-character bound (see `MAX_CREATE_SCREENPLAY_TITLE_LENGTH` above), not
 * `screenplaySchema`'s own 250, and never used to overwrite the title *page's* own `title` field
 * -- only the organizational/listing title this route and the API's `title` parameter need. A
 * title made entirely of characters this still cannot satisfy (e.g. an empty filename with no
 * title page at all) falls back to the same "Untitled Screenplay" default `createDefaultTitlePage`
 * and `@finaler-draft/fdx`'s own package-level fallback already use.
 */
function titleForImportedScreenplay(titlePageTitle: string | undefined, filename: string): string {
  const fromTitlePage = titlePageTitle?.trim();
  if (fromTitlePage !== undefined && fromTitlePage.length > 0) {
    return fromTitlePage.slice(0, MAX_CREATE_SCREENPLAY_TITLE_LENGTH);
  }
  const fromFilename = filename.replace(/\.fdx$/i, '').trim();
  return fromFilename.length > 0
    ? fromFilename.slice(0, MAX_CREATE_SCREENPLAY_TITLE_LENGTH)
    : 'Untitled Screenplay';
}

/**
 * A plain-language message for an FDX import failure, read directly off `FdxImportError.code`
 * (`@finaler-draft/fdx`) rather than exposing its lower-level `message`, which is written for a
 * developer reading a thrown error, not a writer reading a toast. `'doctype_rejected'` and
 * `'too_large'` are deliberately specific -- a writer who hits either has a real, actionable next
 * step (re-export from Final Draft; the file is not a real screenplay) that a generic "import
 * failed" would hide.
 */
function describeFdxImportFailure(code: string): string {
  switch (code) {
    case 'not_xml':
      return 'That file is not a readable Final Draft document. Choose a .fdx file exported from Final Draft.';
    case 'not_fdx':
      return 'That file is XML, but not a Final Draft (.fdx) document.';
    case 'doctype_rejected':
      return 'That file contains document-type declarations this product does not accept. Re-export it from Final Draft and try again.';
    case 'too_large':
      return 'That file is far larger than any real screenplay and was not imported.';
    case 'unmapped_content':
      return 'That script contains content this product cannot represent yet, so nothing was imported -- importing it partially would risk losing part of the script silently.';
    case 'empty_result':
      return 'That file did not contain any screenplay content to import.';
    default:
      return 'That file could not be imported.';
  }
}

// Lazy, same reasoning as routes/projects/index.tsx's identical import: this dialog is only
// needed once a writer actually hits the free-tier limit or opens it, not on every visit to this
// page, so it stays out of this route's own eagerly-loaded chunk graph.
const UpgradeDialog = lazy(async () => ({
  default: (await import('../../../upgradeDialog.js')).UpgradeDialog,
}));
// Lazy for the same reason: only needed once a writer opens it.
const SharingDialog = lazy(async () => ({
  default: (await import('../../../sharingDialog.js')).SharingDialog,
}));
// Lazy for the same reason: only needed once a writer has actually chosen a file to import.
const FdxImportConfirmDialog = lazy(async () => ({
  default: (await import('../../../fdxImportConfirmDialog.js')).FdxImportConfirmDialog,
}));
// Lazy for the same reason, and only ever reached ahead of the dialog above: Task 2's resolution
// modal, shown only when `fdxToScreenplay` reports FDX paragraph types this product does not
// recognize (see `FdxUnknownTypesDialog`'s own doc comment). Most imports never touch an unknown
// type at all, so this stays out of the eagerly-loaded graph exactly like its sibling above.
const FdxUnknownTypesDialog = lazy(async () => ({
  default: (await import('../../../fdxUnknownTypesDialog.js')).FdxUnknownTypesDialog,
}));

/**
 * Shared by `parseFdx` and `resolveUnknownTypes` below: once `fdxToScreenplay` has produced a
 * validated `Screenplay` (whether on the first call or, after the writer resolved every unknown
 * type Task 2's modal listed, on the second), the remaining work -- deriving the title and
 * checking whether the result will open read-only -- is identical regardless of which call
 * produced it. Extracted so the two mutations cannot drift apart on that shared behaviour.
 */
/**
 * A parsed, validated FDX import that has not been created server-side yet. Named once here
 * because three places need the identical shape -- `buildPendingImport`'s result, the `'ready'`
 * arm of `ParsedFdxOutcome`, and `commitImport`'s own argument -- and three hand-copied inline
 * object types could drift apart as fields are added (`titlePageUnreadable` was the most recent).
 */
type PendingFdxImport = {
  filename: string;
  importedTitle: string;
  opensReadOnly: boolean;
  screenplay: Screenplay;
  skipped: FdxSkippedTally;
  titlePageUnreadable: boolean;
};

/**
 * Whether this import has anything to tell the writer before it is created.
 *
 * The confirmation step exists to report what an import will not bring across faithfully -- types
 * left behind, a title page that could not be read, a result the editor will open read-only. When
 * none of those is true there is nothing to confirm, and the owner's objection to the dialog
 * appearing anyway is right: a modal whose only content is "nothing went wrong" is pure friction
 * between choosing a file and seeing the screenplay. A clean file imports directly.
 *
 * Derived from the report itself rather than from a separate flag set at parse time, so a future
 * fourth thing worth reporting cannot be added to the dialog while this predicate keeps saying
 * there is nothing to show.
 */
function fdxImportNeedsConfirmation(pending: PendingFdxImport): boolean {
  return pending.skipped.size > 0 || pending.opensReadOnly || pending.titlePageUnreadable;
}

async function buildPendingImport(
  result: FdxImportResult,
  filename: string,
): Promise<PendingFdxImport> {
  const importedTitle = titleForImportedScreenplay(
    result.screenplay.titlePages[0]?.title,
    filename,
  );
  // See parseFdx's own comment on the identical call below: computed by actually invoking the
  // editor package's real check, dynamically imported so it stays out of this route's eagerly-
  // loaded chunk graph.
  const { editorContentFromScreenplay } = await import('@finaler-draft/screenplay-editor');
  let opensReadOnly = false;
  try {
    editorContentFromScreenplay(result.screenplay);
  } catch {
    opensReadOnly = true;
  }
  return {
    filename,
    importedTitle,
    opensReadOnly,
    screenplay: result.screenplay,
    skipped: result.skipped,
    // This pass's Task 2: `result.titlePageUnreadable` is threaded straight through, unmodified
    // -- `@finaler-draft/fdx` is where the title page was actually (not) decoded, so this route
    // reports the package's own finding rather than re-deriving it.
    titlePageUnreadable: result.titlePageUnreadable,
  };
}

type ParsedFdxOutcome =
  | { kind: 'needs_resolution'; file: File; unknownTypes: readonly FdxUnknownType[] }
  | ({ kind: 'ready' } & Awaited<ReturnType<typeof buildPendingImport>>);

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
  const [sharingOpen, setSharingOpen] = useState(false);
  // The second of the slice's three entry points, and the one the owner asked for specifically:
  // "the 3 dot menu on both the project or just the screenplay if thats all they want to share."
  // Offered to an owner or an editor, matching the bar the server enforces, so it is never a
  // control that answers 403. `screenplay.role` is the viewer's own effective role on this
  // screenplay, resolved by the same lateral that authorized the listing.
  //
  // Note this gates only the new item. Delete is left exactly as it was -- it has always been
  // shown unconditionally here, and narrowing it is a separate behaviour change this slice is not
  // the place for.
  const canShare = screenplay.role === 'owner' || screenplay.role === 'editor';
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
        items={[
          ...(canShare ? [{ label: 'Share…', onSelect: () => setSharingOpen(true) }] : []),
          { label: 'Delete', onSelect: () => deleteMutation.mutate() },
        ]}
        label={`Screenplay actions for ${screenplay.title}`}
      />
      {sharingOpen && (
        <Suspense fallback={null}>
          <SharingDialog
            onClose={() => setSharingOpen(false)}
            scope={{ kind: 'screenplay', screenplayId: screenplay.id }}
            title={screenplay.title}
          />
        </Suspense>
      )}
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Local state, not `.error`/`.isError` on either mutation below: this route's test harness
  // (and, more to the point, real react-query with several independent mutations on one screen)
  // has no way to tell one mutation's failure apart from another's if both read from the same
  // mutation-object slot -- the identical reason sharingDialog.tsx's several mutations each
  // report through their own `onError` into local state rather than through `.error`.
  // `importLimitMessage` is deliberately a separate slot from `limitError` below (not unified
  // into one shared variable) so each control's 402 banner names which action actually hit the
  // free-tier limit.
  const [importError, setImportError] = useState<string>();
  const [importLimitMessage, setImportLimitMessage] = useState<string>();
  // The owner's confirmation step (`progress/fdx-import.md`): after a file parses successfully,
  // nothing is created yet -- the writer sees exactly what will and will not be imported, and the
  // API is only ever called from `commitImport.mutate()` below, which only `onConfirm` reaches.
  // Cancelling (`setPendingImport(undefined)` with no further call) therefore creates no
  // screenplay, by construction, not by a check that has to remember to run.
  const [pendingImport, setPendingImport] = useState<PendingFdxImport>();
  // Task 2's resolution step: set only while `fdxToScreenplay` has reported at least one FDX
  // paragraph `Type` this product does not recognize and the writer has not yet resolved all of
  // them. The original file (not its already-read text -- `File.text()` is safe to call again)
  // is kept so `resolveUnknownTypes` below can re-parse it once the writer supplies a decision for
  // every named type. Mutually exclusive with `pendingImport` in the JSX below: a parse either
  // needs resolution or is ready to confirm, never both at once.
  const [pendingUnknownTypes, setPendingUnknownTypes] = useState<{
    file: File;
    unknownTypes: readonly FdxUnknownType[];
  }>();

  async function parseFdxFile(file: File, resolutions?: FdxUnknownTypeResolutions) {
    const text = await file.text();
    // Yields one tick before the synchronous XML parse runs, so "Importing…" below has
    // already painted -- see progress/fdx-import.md's "must not freeze the interface" note for
    // why a Web Worker was considered and rejected for this instead. Dynamic, not a top-level
    // import: `@finaler-draft/fdx` must stay out of this route's own eagerly-loaded chunk
    // (`pnpm check:bundle-budget`), mirroring how App.tsx already lazily imports it for FDX
    // *export* (`triggerFdxDownload`).
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { fdxToScreenplay, FdxImportError, FdxUnknownTypesError } = await import(
      '@finaler-draft/fdx'
    );
    let result;
    try {
      result = fdxToScreenplay(text, resolutions);
    } catch (error) {
      // Task 2: an unresolved unknown `Type` is not treated as a failed parse at all -- it is a
      // normal outcome that needs one more piece of input from the writer, exactly like the
      // confirmation step already treats a successful parse as "not yet committed" rather than
      // "done." `instanceof` works here even though `@finaler-draft/fdx` was just imported
      // dynamically: ES modules are singletons, so this is the same class object `fdxToScreenplay`
      // itself threw.
      if (error instanceof FdxUnknownTypesError) {
        return { kind: 'needs_resolution', file, unknownTypes: error.unknownTypes } as const;
      }
      throw error instanceof FdxImportError
        ? new Error(describeFdxImportFailure(error.code))
        : error;
    }
    return { kind: 'ready', ...(await buildPendingImport(result, file.name)) } as const;
  }

  function handleParsedFdxOutcome(outcome: ParsedFdxOutcome) {
    if (outcome.kind === 'needs_resolution') {
      setPendingUnknownTypes({ file: outcome.file, unknownTypes: outcome.unknownTypes });
      return;
    }
    setPendingUnknownTypes(undefined);
    // Nothing to report means nothing to confirm: create it and go, leaving `pendingImport` unset
    // so no dialog ever mounts. The writer still cannot lose content silently, because the only
    // things the dialog had to say are precisely the conditions this predicate tests for.
    if (!fdxImportNeedsConfirmation(outcome)) {
      commitImport.mutate(outcome);
      return;
    }
    setPendingImport(outcome);
  }

  function handleFdxParseError(error: unknown) {
    setPendingUnknownTypes(undefined);
    setImportError(error instanceof Error ? error.message : 'That file could not be imported.');
  }

  const parseFdx = useMutation({
    mutationFn: (file: File) => parseFdxFile(file),
    onSuccess: handleParsedFdxOutcome,
    onError: handleFdxParseError,
  });
  // The second half of Task 2's flow: reached only from `FdxUnknownTypesDialog`'s own "Continue"
  // button, once the writer has supplied a decision for every type the first parse reported. A
  // completely separate mutation from `parseFdx` above (not a re-`mutate()` of it) for the same
  // reason `commitImport` is separate from `parseFdx`: this route's test harness, and real
  // react-query with several independent mutations on one screen, has no way to tell one
  // mutation's pending/error state apart from another's if two calls share one slot.
  const resolveUnknownTypes = useMutation({
    mutationFn: (resolutions: FdxUnknownTypeResolutions) => {
      // Guarded structurally, like `commitImport` below: `FdxUnknownTypesDialog` only ever renders
      // while `pendingUnknownTypes` is set, so this is reachable only if that invariant is somehow
      // broken.
      if (!pendingUnknownTypes) {
        throw new Error('No pending FDX unknown-type resolution.');
      }
      return parseFdxFile(pendingUnknownTypes.file, resolutions);
    },
    onSuccess: handleParsedFdxOutcome,
    onError: handleFdxParseError,
  });
  const commitImport = useMutation({
    // Takes the import as its argument rather than reading `pendingImport` state. That is what
    // lets a clean file be created without ever entering that state (see
    // `handleParsedFdxOutcome`): a mutation that read the state would require setting it first,
    // which is exactly the dialog-opening step a clean import is supposed to skip. It also drops
    // the "no pending import" guard the state-reading version needed.
    mutationFn: async (pending: PendingFdxImport) =>
      api.createScreenplay(projectId, pending.importedTitle, {
        ...pending.screenplay,
        title: pending.importedTitle,
      }),
    onSuccess: (script) => {
      setPendingImport(undefined);
      void queryClient.invalidateQueries({ queryKey: ['screenplays', projectId] });
      return router.navigate({
        to: '/projects/$projectId/screenplays/$screenplayId',
        params: { projectId, screenplayId: script.id },
      });
    },
    onError: (error: unknown) => {
      // The dialog closes either way: a 402 or any other failure surfaces through this route's
      // own banner/error pattern, exactly as "New screenplay"'s identical failure already does,
      // rather than leaving a stale confirmation dialog open over it.
      setPendingImport(undefined);
      if (error instanceof MessageApiError && error.status === 402) {
        setImportLimitMessage(error.serverMessage);
        return;
      }
      setImportError(error instanceof Error ? error.message : 'That file could not be imported.');
    },
  });

  // All three steps of the import are "importing" from the writer's point of view: the
  // synchronous parse, the second parse that follows a Task 2 unknown-type resolution, and the
  // create request that follows a confirmation. Derived once here rather than repeated at each
  // use, so the trigger's `disabled` and its label can never disagree.
  const importBusy = parseFdx.isPending || resolveUnknownTypes.isPending || commitImport.isPending;

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
          {/* Task 3 (`progress/fdx-import.md`): the standalone "Import FDX…" button that used to
              sit on its own row is gone -- it is now the arrow's menu, directly below this one
              control, with a vertical divider between the label and the arrow. The primary label
              still submits this form exactly as the old plain button did; pressing the arrow
              never does. */}
          <CreateScreenplaySplitButton
            arrowLabel={importBusy ? 'Importing…' : 'Import a screenplay'}
            importDisabled={importBusy}
            items={[{ label: 'Import FDX…', onSelect: () => fileInputRef.current?.click() }]}
            primaryLabel="New screenplay"
          />
          {/* Hidden, triggered by the menu item above -- the standard pattern for a styleable
              file-picker control, since a real `<input type="file">` cannot be restyled directly.
              Matches "New screenplay": offered unconditionally, with no client-side role check of
              its own, because the server already enforces the same project-edit-rights check
              `createScreenplay` does (apps/api/src/projects.ts: `canEdit(membership.rows[0]?.
              role)`) for both -- creating a screenplay by import is the same act as creating one
              by hand, so there is exactly one authorization rule to keep in sync with, not two. */}
          <input
            accept=".fdx"
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Clears the input's own value so selecting the *same* filename again after a
              // failed import still fires a change event -- the browser otherwise treats an
              // unchanged `value` as nothing having happened.
              event.target.value = '';
              if (!file) return;
              setImportError(undefined);
              setImportLimitMessage(undefined);
              setPendingUnknownTypes(undefined);
              parseFdx.mutate(file);
            }}
            ref={fileInputRef}
            style={{ display: 'none' }}
            type="file"
          />
        </form>
        {importError !== undefined && (
          <p className="field-error" role="alert">
            {importError}
          </p>
        )}
        {importLimitMessage !== undefined && (
          <div className="upgrade-banner" role="alert">
            <p>{importLimitMessage}</p>
            <button
              className="primary-button"
              onClick={() => setUpgradeDialogOpen(true)}
              type="button"
            >
              Upgrade to Pro
            </button>
          </div>
        )}
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
              message={limitError?.serverMessage ?? importLimitMessage}
              onClose={() => setUpgradeDialogOpen(false)}
            />
          </Suspense>
        )}
        {/* Task 2's resolution step, rendered only while `pendingUnknownTypes` is set -- before
            `pendingImport` can ever be. Cancelling clears this state and nothing else, exactly
            like the confirmation dialog below: no API call happens on this path at all. Resolving
            flows into that *same* confirmation dialog rather than becoming a second commit path --
            `onResolve` only ever reaches `resolveUnknownTypes.mutate`, which lands on
            `handleParsedFdxOutcome` exactly as the first parse attempt does. */}
        {pendingUnknownTypes !== undefined && (
          <Suspense fallback={null}>
            <FdxUnknownTypesDialog
              filename={pendingUnknownTypes.file.name}
              onCancel={() => setPendingUnknownTypes(undefined)}
              onResolve={(resolutions) => resolveUnknownTypes.mutate(resolutions)}
              unknownTypes={pendingUnknownTypes.unknownTypes}
            />
          </Suspense>
        )}
        {/* Rendered only while `pendingImport` is set, which is what makes "cancelling creates no
            screenplay" structural: `onCancel` clears that state and nothing else, and `onConfirm`
            is the only path to `commitImport` and therefore to `api.createScreenplay`. */}
        {pendingImport !== undefined && (
          <Suspense fallback={null}>
            <FdxImportConfirmDialog
              blockCount={pendingImport.screenplay.blocks.length}
              filename={pendingImport.filename}
              onCancel={() => setPendingImport(undefined)}
              onConfirm={() => commitImport.mutate(pendingImport)}
              opensReadOnly={pendingImport.opensReadOnly}
              skipped={pendingImport.skipped}
              titlePageUnreadable={pendingImport.titlePageUnreadable}
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

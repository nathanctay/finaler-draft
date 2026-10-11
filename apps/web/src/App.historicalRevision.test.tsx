import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DOCUMENT_SETTINGS, type Screenplay } from '@finaler-draft/screenplay';
import type { PersistedScreenplay } from './api.js';

/**
 * Collaboration slice 4a's historical preview: `App`'s `historicalRevision` prop must
 * *structurally* never reach the live Yjs document, not merely present a disabled UI on top of
 * it. `App.test.tsx`'s entire suite runs with `COLLAB_WS_URL` unset (`collabConfig.ts` resolves to
 * `undefined` in the test environment -- see that file's own top-of-suite comment), so it can never
 * exercise the branch where a live provider *would* otherwise be constructed. This file mocks
 * `collabConfig.js` to a real-looking URL specifically so that branch is reachable, and mocks
 * `@hocuspocus/provider`/`y-indexeddb` so the assertion below -- neither constructor is ever
 * called when `historicalRevision` is set -- is a direct proof, not an inference from "the banner
 * says read-only."
 */
vi.mock('./collabConfig.js', () => ({ COLLAB_WS_URL: 'wss://collab.example.test' }));

const hocuspocusProviderConstructor = vi.fn();
vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    constructor(...args: unknown[]) {
      hocuspocusProviderConstructor(...args);
    }
  },
}));

const indexeddbPersistenceConstructor = vi.fn();
vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    constructor(...args: unknown[]) {
      indexeddbPersistenceConstructor(...args);
    }
  },
}));

const { App } = await import('./App.js');

function historicalPersistedScreenplay(): PersistedScreenplay {
  const documentSettings: Screenplay['documentSettings'] = DEFAULT_DOCUMENT_SETTINGS;
  return {
    id: '99999999-0000-4000-8000-000000000099',
    projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
    currentEpoch: 0,
    title: 'A Working Draft',
    screenplay: {
      annotations: [],
      blocks: [
        {
          id: '99999999-8d05-4e6e-bac7-e471e8df33a1',
          type: 'scene_heading',
          text: 'INT. APARTMENT - MORNING',
        },
      ],
      id: '99999999-0000-4000-8000-000000000099',
      schemaVersion: 1,
      title: 'A Working Draft',
      titlePages: [],
      documentSettings,
    },
  };
}

describe('historical revision preview', () => {
  it('never constructs a HocuspocusProvider or an IndexeddbPersistence, even with a real COLLAB_WS_URL configured', async () => {
    render(
      <App
        historicalRevision={{ label: 'Historical revision from March 4, 2026, 3:04 PM' }}
        initial={historicalPersistedScreenplay()}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    expect(hocuspocusProviderConstructor).not.toHaveBeenCalled();
    expect(indexeddbPersistenceConstructor).not.toHaveBeenCalled();
  });

  it('renders visibly read-only, with the revision content itself still legible', async () => {
    render(
      <App
        historicalRevision={{ label: 'Historical revision from March 4, 2026, 3:04 PM' }}
        initial={historicalPersistedScreenplay()}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    expect(screen.getByRole('textbox', { name: 'Screenplay editing canvas' })).not.toHaveAttribute(
      'contenteditable',
      'true',
    );
    expect(
      screen.getByText('INT. APARTMENT - MORNING', { selector: '[data-screenplay-block]' }),
    ).toBeVisible();
  });

  it('offers a way back to the revision history, and calls the route rather than navigating itself', async () => {
    const onBackToRevisions = vi.fn();
    render(
      <App
        historicalRevision={{
          label: 'Historical revision from March 4, 2026, 3:04 PM',
          onBackToRevisions,
        }}
        initial={historicalPersistedScreenplay()}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    // Before this existed, a writer who opened a revision could only leave it through the
    // browser's back button or by editing the URL. It goes one step back, to the history this
    // revision came from, rather than all the way out to the live document -- see
    // `HistoricalRevisionInfo.onBackToRevisions`.
    const back = screen.getByRole('button', { name: 'Back to revisions' });
    expect(back).toBeVisible();
    await userEvent.click(back);
    // `App` never navigates on its own -- the route owns the destination, the same contract
    // `onOpenRevisionHistory` already follows.
    expect(onBackToRevisions).toHaveBeenCalledTimes(1);
  });

  it('omits the button entirely when the caller supplies nowhere to go back to', async () => {
    render(
      <App
        historicalRevision={{ label: 'Historical revision from March 4, 2026, 3:04 PM' }}
        initial={historicalPersistedScreenplay()}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    expect(screen.queryByRole('button', { name: 'Back to revisions' })).toBeNull();
  });

  it('shows a banner unmistakably distinct from the live editor, carrying the revision label and no promote-to-editable action', async () => {
    render(
      <App
        historicalRevision={{ label: 'Historical revision from March 4, 2026, 3:04 PM' }}
        initial={historicalPersistedScreenplay()}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    expect(screen.getByText(/Historical revision\./)).toBeVisible();
    expect(screen.getByText(/Historical revision from March 4, 2026, 3:04 PM/)).toBeVisible();
    expect(screen.getByRole('main')).toHaveClass('has-readonly-banner');
    // Restoring a past revision to *be* the live document (plan.md's "Restore as current") is a
    // separate, later feature this slice deliberately does not build. Navigating back to the live
    // document is a different thing entirely and does exist -- see the test below -- but it is
    // leaving this view, not promoting this revision over the live one.
    expect(
      screen.queryByRole('button', { name: 'Make this one editable' }),
    ).not.toBeInTheDocument();
  });

  /**
   * plan.md's standing export requirement: "a test that an export made from a historical revision
   * exactly identifies that revision rather than the mutable current document." Two halves, both
   * asserted here:
   *
   *  - The bytes downloaded are built from *this revision's* screenplay (its own title lands on the
   *    file name and in the document), not from whatever the live screenplay has become since.
   *  - No `export` revision is recorded. An export revision always captures the *live* canonical
   *    projection (`apps/api/src/revisions.ts` reads `screenplays.canonical_screenplay`, never the
   *    client's), so recording one here would file a history entry claiming an export of the live
   *    document that nobody made -- misidentifying exactly what this requirement is about. The
   *    historical preview is also, by construction, not connected to any collaboration document
   *    (the first test in this file), so there is no epoch it could honestly send either.
   */
  it('exports the revision it is showing, and records no export revision against the live document', async () => {
    // The exporter itself is mocked so the *screenplay handed to it* can be asserted directly --
    // `triggerFdxDownload` is a `Blob`/object-URL wrapper around the pure `screenplayToFdx`
    // (`fdxDownload.ts`), and jsdom's `Blob` cannot be read back, so inspecting the bytes would
    // prove less than inspecting the input. `vi.doMock` works on the already-imported `App` because
    // `runExport` reaches the module through a dynamic `import()`, resolved at click time.
    const triggerFdxDownload = vi.fn();
    vi.doMock('./fdxDownload.js', () => ({ triggerFdxDownload }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(
      <App
        historicalRevision={{ label: 'Historical revision from March 4, 2026, 3:04 PM' }}
        initial={historicalPersistedScreenplay()}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download FDX…' }));

    await waitFor(() => expect(triggerFdxDownload).toHaveBeenCalledTimes(1));
    const exported = triggerFdxDownload.mock.calls[0]![0] as {
      id: string;
      title: string;
      blocks: Array<{ text?: string }>;
    };
    // This revision's own content and identity -- never the live screenplay's.
    expect(exported.title).toBe('A Working Draft');
    expect(exported.id).toBe('99999999-0000-4000-8000-000000000099');
    expect(exported.blocks[0]?.text).toBe('INT. APARTMENT - MORNING');

    // Nothing was posted at all -- no export revision, and no connection token request either.
    expect(fetchMock).not.toHaveBeenCalled();

    vi.doUnmock('./fdxDownload.js');
    vi.unstubAllGlobals();
  });

  it('disables every other affordance that could mutate the document -- undo/redo, the element selector, and Document settings', async () => {
    const user = userEvent.setup();
    render(
      <App
        historicalRevision={{ label: 'Historical revision from March 4, 2026, 3:04 PM' }}
        initial={historicalPersistedScreenplay()}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Undo local change' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo local change' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    expect(screen.getByRole('menuitem', { name: 'Document settings…' })).toBeDisabled();
  });
});

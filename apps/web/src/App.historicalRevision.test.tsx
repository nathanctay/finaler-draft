import { render, screen } from '@testing-library/react';
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

  it('offers a way back to the live document, and calls the route rather than navigating itself', async () => {
    const onBackToLiveDocument = vi.fn();
    render(
      <App
        historicalRevision={{
          label: 'Historical revision from March 4, 2026, 3:04 PM',
          onBackToLiveDocument,
        }}
        initial={historicalPersistedScreenplay()}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    // Before this existed, a writer who opened a revision could only reach the live document
    // through the browser's back button or by editing the URL.
    const back = screen.getByRole('button', { name: 'Back to live document' });
    expect(back).toBeVisible();
    await userEvent.click(back);
    // `App` never navigates on its own -- the route owns the destination, the same contract
    // `onOpenRevisionHistory` already follows.
    expect(onBackToLiveDocument).toHaveBeenCalledTimes(1);
  });

  it('omits the button entirely when the caller supplies nowhere to go back to', async () => {
    render(
      <App
        historicalRevision={{ label: 'Historical revision from March 4, 2026, 3:04 PM' }}
        initial={historicalPersistedScreenplay()}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    expect(screen.queryByRole('button', { name: 'Back to live document' })).toBeNull();
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

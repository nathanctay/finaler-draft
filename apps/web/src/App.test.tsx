import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  createDefaultTitlePage,
  type Screenplay,
  type ScreenplayBlock,
  type TitlePage,
} from '@finaler-draft/screenplay';
import { App } from './App.js';
import { ApiError, api, type PersistedScreenplay } from './api.js';
import { pageStackMinHeightIn } from './pagination.js';
import {
  findScreenplayBlockPosition,
  getActiveScreenplayBlock,
  initialScreenplayContent,
  editorContentFromScreenplay,
  isScreenplayElementType,
  projectLocalScreenplay,
  screenplayExtensions,
} from './screenplayEditor.js';

const firstActionId = 'ba53c2dc-10a6-46d7-a409-9aabbff7cf5d';
const firstSceneId = '2175a1b6-8d05-4e6e-bac7-e471e8df33a1';
const transitionId = 'd01faf47-64e7-4f7c-853a-3c6ace1464ad';

function getBlock(canvas: HTMLElement, id: string): HTMLElement {
  const block = canvas.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
  if (!block) {
    throw new Error(`Missing screenplay block ${id}.`);
  }
  return block;
}

function persistedScreenplay(
  id: string,
  title: string,
  text: string,
  documentSettings: Screenplay['documentSettings'] = DEFAULT_DOCUMENT_SETTINGS,
): PersistedScreenplay {
  return {
    id,
    projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
    screenplay: {
      annotations: [],
      blocks: [
        {
          id: `${id.slice(0, 8)}-8d05-4e6e-bac7-e471e8df33a1`,
          type: 'scene_heading',
          text,
        },
      ],
      id,
      schemaVersion: 1,
      title,
      titlePages: [],
      documentSettings,
    },
    title,
    version: 1,
  };
}

// A small, editable (no dual dialogue, notes, page breaks, or extra title pages -- see
// `editorContentFromScreenplay`'s own limits) screenplay with two characters, one of them cued
// with a period-less and a punctuated extension, for the Characters tab tests below. MARA's two
// cues must collapse to one Navigator entry with a single, normalized `V.O.` extension.
const twoCharacterScreenplay: Screenplay = {
  schemaVersion: 1,
  id: '2c9f1b1a-1b1a-4b1a-8b1a-1b1a2c9f1b1a',
  title: 'Two Voices',
  documentSettings: DEFAULT_DOCUMENT_SETTINGS,
  titlePages: [],
  blocks: [
    {
      id: '2c9f1b1a-1b1a-4b1a-8b1a-000000000001',
      type: 'scene_heading',
      text: 'INT. STUDIO - NIGHT',
    },
    { id: '2c9f1b1a-1b1a-4b1a-8b1a-000000000002', type: 'character', text: 'MARA' },
    { id: '2c9f1b1a-1b1a-4b1a-8b1a-000000000003', type: 'dialogue', text: 'Say it again.' },
    { id: '2c9f1b1a-1b1a-4b1a-8b1a-000000000004', type: 'character', text: 'MARA (VO)' },
    { id: '2c9f1b1a-1b1a-4b1a-8b1a-000000000005', type: 'dialogue', text: 'She never did.' },
    { id: '2c9f1b1a-1b1a-4b1a-8b1a-000000000006', type: 'character', text: 'JOE' },
    { id: '2c9f1b1a-1b1a-4b1a-8b1a-000000000007', type: 'dialogue', text: 'Neither did I.' },
  ],
  annotations: [],
};

const twoCharacterPersisted: PersistedScreenplay = {
  id: twoCharacterScreenplay.id,
  projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
  screenplay: twoCharacterScreenplay,
  title: twoCharacterScreenplay.title,
  version: 1,
};

// A screenplay cued entirely in lowercase/mixed case, for the case-insensitive grouping and
// display-uppercase tests below. The writer never typed uppercase anywhere here -- the Navigator
// must still display `MARA` (screenplay convention) without the block text itself ever being
// rewritten, and the caret-highlighting membership test (`activeCharacter`, keyed on `blockIds`,
// not on `name`'s case) must keep working when the authored text is not uppercase.
const mixedCaseCharacterScreenplay: Screenplay = {
  schemaVersion: 1,
  id: '3d9f1b1a-1b1a-4b1a-8b1a-1b1a2c9f1b1a',
  title: 'Mixed Case',
  documentSettings: DEFAULT_DOCUMENT_SETTINGS,
  titlePages: [],
  blocks: [
    {
      id: '3d9f1b1a-1b1a-4b1a-8b1a-000000000001',
      type: 'scene_heading',
      text: 'INT. STUDIO - NIGHT',
    },
    { id: '3d9f1b1a-1b1a-4b1a-8b1a-000000000002', type: 'character', text: 'mara' },
    { id: '3d9f1b1a-1b1a-4b1a-8b1a-000000000003', type: 'parenthetical', text: '(beat)' },
    { id: '3d9f1b1a-1b1a-4b1a-8b1a-000000000004', type: 'dialogue', text: 'Say it again.' },
    { id: '3d9f1b1a-1b1a-4b1a-8b1a-000000000005', type: 'character', text: 'Mara (v.o.)' },
    { id: '3d9f1b1a-1b1a-4b1a-8b1a-000000000006', type: 'dialogue', text: 'She never did.' },
  ],
  annotations: [],
};

const mixedCaseCharacterPersisted: PersistedScreenplay = {
  id: mixedCaseCharacterScreenplay.id,
  projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
  screenplay: mixedCaseCharacterScreenplay,
  title: mixedCaseCharacterScreenplay.title,
  version: 1,
};

// A variant ending in a parenthetical (rather than dialogue) authored under a lowercase cue, so
// the caret-in-a-parenthetical case of the highlighting test below can use the same "click below
// the last element moves the caret to the document end" mechanism the dialogue case uses --
// that mechanism only ever reaches whichever block is last, so each caret-position case needs its
// own fixture with the target block type last.
const mixedCaseParentheticalLastScreenplay: Screenplay = {
  schemaVersion: 1,
  id: '4d9f1b1a-1b1a-4b1a-8b1a-1b1a2c9f1b1a',
  title: 'Mixed Case Parenthetical',
  documentSettings: DEFAULT_DOCUMENT_SETTINGS,
  titlePages: [],
  blocks: [
    {
      id: '4d9f1b1a-1b1a-4b1a-8b1a-000000000001',
      type: 'scene_heading',
      text: 'INT. STUDIO - NIGHT',
    },
    { id: '4d9f1b1a-1b1a-4b1a-8b1a-000000000002', type: 'character', text: 'mara' },
    { id: '4d9f1b1a-1b1a-4b1a-8b1a-000000000003', type: 'dialogue', text: 'Say it again.' },
    { id: '4d9f1b1a-1b1a-4b1a-8b1a-000000000004', type: 'parenthetical', text: '(beat)' },
  ],
  annotations: [],
};

const mixedCaseParentheticalLastPersisted: PersistedScreenplay = {
  id: mixedCaseParentheticalLastScreenplay.id,
  projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
  screenplay: mixedCaseParentheticalLastScreenplay,
  title: mixedCaseParentheticalLastScreenplay.title,
  version: 1,
};

describe('local semantic screenplay editor', () => {
  it('fails closed for canonical features the text-block editor cannot preserve', () => {
    expect(() => editorContentFromScreenplay(screenplayFixture)).toThrow(/not editable/i);
  });

  it('gives the editor a real way back to the writing desk via the brand mark', () => {
    render(<App />);
    const back = screen.getByRole('link', { name: 'Finaler Draft — back to your projects' });
    expect(back).toHaveAttribute('href', '/projects');
    expect(back).toHaveTextContent('Finaler Draft');
  });

  it('preserves local edits and visibly locks automatic saves after a conflict', async () => {
    const save = vi.spyOn(api, 'saveScreenplay').mockRejectedValue(new ApiError(409));
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );
    expect(await screen.findByText(/Save conflict/)).toBeVisible();
    expect(save).toHaveBeenCalledOnce();
    save.mockRestore();
  });

  it('reports a retryable non-conflict failure without discarding the editor, and a further edit retries it', async () => {
    // Unlike a 409 conflict (the sibling test above), a non-conflict failure -- a network error,
    // a 500 -- does not lock the editor: `App.tsx`'s `scheduleSave` clears `saveState === 'failed'`
    // the moment a genuinely new edit arrives and retries. `ApiError(500)` on the first call
    // reproduces that failure; the second call resolving proves the retry itself, not just that
    // the failure text appeared.
    const save = vi
      .spyOn(api, 'saveScreenplay')
      .mockRejectedValueOnce(new ApiError(500))
      .mockResolvedValueOnce({ version: 2 });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'action',
    );
    expect(await screen.findByText('Save failed · make another edit to retry')).toBeVisible();
    expect(save).toHaveBeenCalledOnce();

    // `scheduleSave` clears `failed` back to `saved` synchronously the moment this edit lands,
    // ahead of its own 600 ms debounce -- so asserting on the "Saved" text alone would pass on
    // that transient state without the retry's save round trip ever completing. Waiting for the
    // second `saveScreenplay` call is what actually proves the retry happened.
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/^Saved · validated locally/)).toBeVisible();
    save.mockRestore();
  });

  it('tells the writer the truth in a conflict, with no claim that anything is preserved, and offers both rescue actions', async () => {
    // The regression this guards against is specific: `audit/CONSOLIDATED.md` item A2 found the
    // old copy said "your local edits are preserved" while `grep -rn
    // "localStorage\|sessionStorage\|indexedDB"` over apps/web/src returns nothing -- a false
    // claim that would send a writer away from the one place their unsaved edits still exist.
    // Asserting the real rendered text (not a constant this test also imports) is what
    // progress/save-conflict-recovery.md's verification section calls out as the test most likely
    // to pass vacuously if written the other way.
    const save = vi.spyOn(api, 'saveScreenplay').mockRejectedValue(new ApiError(409));
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );
    const status = await screen.findByText(/Save conflict/);
    expect(status).toHaveTextContent(
      'Save conflict · this screenplay changed elsewhere; this copy is unsaved and saving is paused',
    );
    expect(status.textContent ?? '').not.toMatch(/preserved/i);
    expect(screen.getByRole('button', { name: 'Copy my version' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload (discards this copy)' })).toBeVisible();
    save.mockRestore();
  });

  it('"Copy my version" puts the unsaved manuscript on the clipboard as readable screenplay text, not canonical JSON', async () => {
    const save = vi.spyOn(api, 'saveScreenplay').mockRejectedValue(new ApiError(409));
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    // `userEvent.setup()` installs its own `navigator.clipboard` stub (an in-memory
    // `items`-backed clipboard, for its own copy/paste helpers) -- defining the mock after setup,
    // not before, is what makes it the one the component actually sees.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );
    await screen.findByText(/Save conflict/);
    await user.click(screen.getByRole('button', { name: 'Copy my version' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copiedText: unknown = writeText.mock.calls[0]?.[0];
    expect(typeof copiedText).toBe('string');
    // Not canonical JSON: JSON.parse would succeed on `JSON.stringify(screenplay)`, which is
    // exactly what this button used to have no alternative to producing.
    expect(() => JSON.parse(copiedText as string)).toThrow();
    expect(copiedText).not.toContain('"blocks"');
    expect(copiedText).toContain('The Long Way Home');
    expect(copiedText).toContain('MARA');
    expect(copiedText).toContain('If the ending is true, it has to earn its way there.');
    expect(await screen.findByText('Copied to clipboard.')).toBeVisible();

    save.mockRestore();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('reports a Clipboard API rejection honestly instead of silently doing nothing', async () => {
    const save = vi.spyOn(api, 'saveScreenplay').mockRejectedValue(new ApiError(409));
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );
    await screen.findByText(/Save conflict/);
    await user.click(screen.getByRole('button', { name: 'Copy my version' }));

    expect(
      await screen.findByText('Copy failed · select the manuscript text and copy it manually.'),
    ).toBeVisible();
    expect(screen.queryByText('Copied to clipboard.')).not.toBeInTheDocument();

    save.mockRestore();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('"Reload (discards this copy)" discards the local copy and reloads from the server', async () => {
    const save = vi.spyOn(api, 'saveScreenplay').mockRejectedValue(new ApiError(409));
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );
    await screen.findByText(/Save conflict/);
    await user.click(screen.getByRole('button', { name: 'Reload (discards this copy)' }));

    expect(reload).toHaveBeenCalledOnce();

    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    save.mockRestore();
  });

  it('flushes a pending debounced save when the page is hidden, without keepalive since the app is not going away', async () => {
    const save = vi.spyOn(api, 'saveScreenplay').mockResolvedValue({ version: 2 });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'action',
    );
    expect(save).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));

    // Deliberately not awaited or wrapped in `waitFor`: `saveLatest` runs synchronously up to its
    // first `await`, so if the flush fired at all, `saveScreenplay` has already been called by
    // the time `dispatchEvent` returns -- no window in which the ordinary 600 ms debounce could
    // have coincidentally elapsed and produced a false pass. This is the failure mode
    // progress/save-conflict-recovery.md's verification section names directly: "make sure the
    // assertion would fail if the flush never fired, rather than passing because the debounce had
    // already elapsed."
    //
    // `keepalive: false` here is deliberate, not an oversight: the page is only backgrounded, not
    // going away, so an ordinary `fetch` is correct -- and unlike `pagehide` below, it carries no
    // 64 KB request-body cap, which matters because a real screenplay routinely exceeds it (see
    // the flush effect's own comment in App.tsx).
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[3]).toEqual({ keepalive: false });

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    save.mockRestore();
  });

  it('flushes a pending debounced save on pagehide too, with keepalive since that exit may be a real page teardown', async () => {
    const save = vi.spyOn(api, 'saveScreenplay').mockResolvedValue({ version: 2 });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'action',
    );
    expect(save).not.toHaveBeenCalled();

    fireEvent(window, new Event('pagehide'));

    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[3]).toEqual({ keepalive: true });
    save.mockRestore();
  });

  it('still flushes a pending save on unmount for a document well over the 64 KB keepalive cap, because unmount does not use keepalive', async () => {
    // `keepalive: true` requests are capped at a 64 KB total body by the Fetch spec, and a real
    // screenplay routinely exceeds it -- measured on this branch, 500 blocks of canonical JSON is
    // already ~67 KB. The other flush tests above use the tiny default fixture and so could not
    // catch a regression that put `keepalive: true` back on the unmount/`visibilitychange` path
    // (both are in-app, not a page teardown, and must not pay that cap): with a small document
    // they would still "work" even over-cap, since 64 KB was never approached. This constructs a
    // screenplay comfortably over the cap and asserts the unmount flush both carries the whole
    // oversized payload and does so with `keepalive: false`.
    const bigBlocks: ScreenplayBlock[] = Array.from({ length: 60 }, () => ({
      id: crypto.randomUUID(),
      text: 'x'.repeat(1200),
      type: 'action' as const,
    }));
    const bigScreenplay: Screenplay = {
      annotations: [],
      blocks: [
        { id: crypto.randomUUID(), text: 'INT. WAREHOUSE - NIGHT', type: 'scene_heading' },
        ...bigBlocks,
      ],
      documentSettings: DEFAULT_DOCUMENT_SETTINGS,
      id: crypto.randomUUID(),
      schemaVersion: 1,
      title: 'Big screenplay',
      titlePages: [],
    };
    expect(JSON.stringify(bigScreenplay).length).toBeGreaterThan(65_536);
    const bigInitial: PersistedScreenplay = {
      id: bigScreenplay.id,
      projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
      screenplay: bigScreenplay,
      title: bigScreenplay.title,
      version: 1,
    };
    const second = persistedScreenplay(
      '8c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
      'Second screenplay',
      'Second route content.',
    );
    const save = vi.spyOn(api, 'saveScreenplay').mockResolvedValue({ version: 2 });
    const user = userEvent.setup();
    const { rerender } = render(<App initial={bigInitial} key={bigInitial.id} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    await user.click(screen.getByRole('button', { name: /1\. INT\. WAREHOUSE/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );
    rerender(<App initial={second} key={second.id} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    expect(save).toHaveBeenCalledOnce();
    const [, , flushedScreenplay, flushedOptions] = save.mock.calls[0] ?? [];
    expect(JSON.stringify(flushedScreenplay).length).toBeGreaterThan(65_536);
    expect(flushedOptions).toEqual({ keepalive: false });

    save.mockRestore();
  });

  it("never flushes on hide while a save conflict is in effect, matching the debounced path's own rule", async () => {
    const save = vi.spyOn(api, 'saveScreenplay').mockRejectedValueOnce(new ApiError(409));
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );
    await screen.findByText(/Save conflict/);
    expect(save).toHaveBeenCalledOnce();
    save.mockClear();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));

    // The local edit is still genuinely different from `savedWire.current` (the 409 never
    // succeeded), so absent the conflict guard this would fire a real second call -- silently
    // resuming a save the server already rejected, requirement 4's own hazard.
    expect(save).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    save.mockRestore();
  });

  it('renders unsupported persisted snapshots as read-only', async () => {
    render(
      <App
        initial={{
          id: screenplayFixture.id,
          projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
          screenplay: screenplayFixture,
          title: screenplayFixture.title,
          version: 1,
        }}
      />,
    );
    expect(
      await screen.findByText(
        /contains more than one title page, notes, dual dialogue, or page breaks/i,
      ),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Screenplay editing canvas' })).not.toHaveAttribute(
      'contenteditable',
      'true',
    );
    expect(screen.getByText('Text editing is unavailable for this screenplay')).toBeVisible();
    expect(screen.queryByText('INT. APARTMENT - MORNING')).not.toBeInTheDocument();
  });

  it('discards the prior editor instance when a route opens a different screenplay, after flushing its pending save', async () => {
    const first = persistedScreenplay(
      '7c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
      'First screenplay',
      'First route content.',
    );
    const second = persistedScreenplay(
      '8c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
      'Second screenplay',
      'Second route content.',
    );
    const save = vi.spyOn(api, 'saveScreenplay').mockResolvedValue({ version: 2 });
    const user = userEvent.setup();
    const { rerender } = render(<App initial={first} key={first.id} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    await user.click(screen.getByRole('button', { name: /1\. First route content/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'action',
    );
    rerender(<App initial={second} key={second.id} />);

    const secondCanvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    expect(secondCanvas).toHaveTextContent('Second route content.');
    expect(secondCanvas).not.toHaveTextContent('First route content.');

    // Requirement 5, progress/save-conflict-recovery.md -- the audit's "smaller sibling" finding
    // in audit/CONSOLIDATED.md item A2: unmounting with a pending debounced save now flushes it
    // rather than silently dropping the edit, the way this test used to assert (waiting past the
    // 600 ms debounce to prove nothing happened). The flush fires synchronously on unmount, for
    // the discarded first instance only -- its id, its edited block, `keepalive: false` (unmount
    // is in-app navigation, not the page going away, so it deliberately does not pay the 64 KB
    // keepalive cap -- see the flush effect's own comment in App.tsx) -- and must never touch or
    // be attributed to the second, still-mounted instance.
    expect(save).toHaveBeenCalledOnce();
    const [flushedId, flushedExpectedVersion, flushedScreenplay, flushedOptions] =
      save.mock.calls[0] ?? [];
    expect(flushedId).toBe(first.id);
    expect(flushedExpectedVersion).toBe(1);
    expect(flushedScreenplay).toMatchObject({ blocks: [{ type: 'action' }] });
    expect(flushedOptions).toEqual({ keepalive: false });

    // The old native `setTimeout` the flush pre-empted must actually be cancelled, not merely
    // outrun -- otherwise it would still fire a second, duplicate save once its own 600 ms
    // elapsed.
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(save).toHaveBeenCalledOnce();
    save.mockRestore();
  });

  it("applies a loaded screenplay's own document settings to the rendered page geometry, not just the specification's defaults", async () => {
    const custom = persistedScreenplay(
      '3c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
      'Custom geometry',
      'Custom-geometry content.',
      {
        ...DEFAULT_DOCUMENT_SETTINGS,
        characterIndentIn: 3.2,
        parentheticalIndentIn: 2.6,
        parentheticalWidthIn: 2.4,
      },
    );

    render(<App initial={custom} key={custom.id} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    expect(document.documentElement.style.getPropertyValue('--fd-character-indent')).toBe('3.2in');
    expect(document.documentElement.style.getPropertyValue('--fd-parenthetical-indent')).toBe(
      '2.6in',
    );
    expect(document.documentElement.style.getPropertyValue('--fd-parenthetical-width')).toBe(
      '2.4in',
    );
  });

  it('moves the cursor to the end of the document on a click below the last element, since a near-empty screenplay is mostly unclickable blank page', async () => {
    render(<App />);
    const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    const page = canvas.closest('.page');
    if (!page) {
      throw new Error('Missing .page ancestor of the editing canvas.');
    }

    // Starts on the first block (a scene heading), not the last (a shot) -- so the assertion
    // below actually demonstrates the click moved the cursor, rather than it having started there.
    expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toHaveValue(
      'scene_heading',
    );

    // jsdom performs no layout, so every element's real getBoundingClientRect() is zeroed;
    // this stands in for the near-empty document's actual content ending a few lines down the
    // page while the click lands further down, in the page's otherwise-blank remainder.
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 100));

    fireEvent.mouseDown(page, { clientY: 500 });

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toHaveValue(
        'shot',
      ),
    );
  });

  it('derives Navigator scenes and keeps the local draft status accurate', async () => {
    const user = userEvent.setup();
    render(<App />);

    const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    expect(screen.getByText('1. INT. APARTMENT - MORNING')).toBeVisible();
    expect(screen.getByText('2. EXT. UNION STATION - CONTINUOUS')).toBeVisible();
    expect(screen.getByText(/validated locally/i)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /2\. EXT\. UNION STATION/i }));
    expect(screen.getByLabelText('Active scene')).toHaveTextContent(
      'EXT. UNION STATION - CONTINUOUS',
    );

    await user.click(screen.getByRole('button', { name: 'Close navigator' }));
    expect(screen.queryByRole('complementary', { name: 'Navigator' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Toggle navigator' }));
    expect(screen.getByRole('complementary', { name: 'Navigator' })).toBeVisible();
    expect(canvas).toBeVisible();
  });

  // plan.md's design rules: "full keyboard operation, visible focus, semantic controls." The
  // Characters tab was, per plan.md's own description of the prior state, "a plain
  // `<span>Characters</span>`... with no click handler, no derived character list, and no
  // click-to-navigate" -- these tests exercise the replacement: a real `role="tab"`/`role="tabpanel"`
  // pair, switchable by click or arrow key, with selection exposed via `aria-selected` rather than
  // painted only through a CSS class, and a derived, groupable, clickable character list.
  describe('Characters tab', () => {
    it('is a real tab pair: aria-selected flips on click, and the rendered tabpanel actually swaps', async () => {
      const user = userEvent.setup();
      render(<App initial={twoCharacterPersisted} />);
      await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

      const scenesTab = screen.getByRole('tab', { name: 'Scenes' });
      const charactersTab = screen.getByRole('tab', { name: 'Characters' });

      // Asserted before any interaction: Scenes is the default-selected tab, per plan.md's
      // description of the prior markup ("a plain `<span>Characters</span>` beside the working
      // `Scenes` tab").
      expect(scenesTab).toHaveAttribute('aria-selected', 'true');
      expect(charactersTab).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'navigator-panel-scenes');

      await user.click(charactersTab);

      expect(scenesTab).toHaveAttribute('aria-selected', 'false');
      expect(charactersTab).toHaveAttribute('aria-selected', 'true');

      // The likeliest vacuous version of this assertion is checking that a character's name
      // appears anywhere on the page, which would pass even if the click never switched anything
      // -- MARA's name never disappears from the DOM in this app (there is no second place it
      // could render), so that assertion alone proves nothing. Scoping to the actual `tabpanel`
      // (and to `id="navigator-panel-characters"` specifically, not just any `tabpanel`) is what
      // proves the switch happened.
      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('id', 'navigator-panel-characters');
      expect(panel).toHaveAttribute('aria-labelledby', 'navigator-tab-characters');
      expect(within(panel).getByRole('button', { name: /^MARA/ })).toBeVisible();
      expect(within(panel).getByRole('button', { name: /^JOE/ })).toBeVisible();
    });

    it('groups MARA and MARA (VO) into one entry and renders its normalized extension beside the name', async () => {
      render(<App initial={twoCharacterPersisted} />);
      await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: 'Characters' }));
      const panel = screen.getByRole('tabpanel');

      // Exactly one MARA row, not two -- the grouping guarantee this scope exists to build (see
      // packages/screenplay's own `deriveCharacters` tests for the derivation-level coverage;
      // this is the one place that grouping becomes writer-visible).
      expect(within(panel).getAllByRole('button', { name: /^MARA/ })).toHaveLength(1);

      const maraRow = within(panel).getByRole('button', { name: /^MARA/ });
      // Period-less `(VO)` normalizes to `V.O.` -- plan.md: "accept the period-less spellings on
      // import but normalise on output" -- and renders in the list, not only in derivation data
      // nothing in the UI ever reads.
      expect(maraRow).toHaveTextContent('V.O.');
      expect(maraRow).not.toHaveTextContent('VO)');

      // JOE has no extension, so nothing after the count should render for it -- no stray
      // separator or empty extension list.
      const joeRow = within(panel).getByRole('button', { name: /^JOE/ });
      expect(joeRow).not.toHaveTextContent('·');
    });

    // The count is how many times the character speaks -- `cueBlockIds`, the cues alone -- and it
    // carries no noun, because neither available noun is true: "lines" is wrong for a count of
    // cues, and `blockIds` (the full speech attribution, counting parentheticals and every
    // dialogue paragraph besides) is not what a writer wants to know about a character. Untested
    // until now: the label read "2 lines" and nothing asserted it either way, so the change that
    // removed the noun broke no test.
    it("shows a character's cue count as a bare number, with no unit and no speech-block inflation", async () => {
      const user = userEvent.setup();
      render(<App initial={twoCharacterPersisted} />);
      await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
      await user.click(screen.getByRole('tab', { name: 'Characters' }));
      const panel = screen.getByRole('tabpanel');

      // MARA is cued twice (`MARA` and `MARA (VO)`), each followed by dialogue. The count is 2 --
      // the cues -- not 4, which is what counting the attributed speech blocks would give.
      const maraRow = within(panel).getByRole('button', { name: /^MARA/ });
      expect(maraRow).toHaveTextContent('2 · V.O.');
      expect(maraRow).not.toHaveTextContent('lines');

      const joeRow = within(panel).getByRole('button', { name: /^JOE/ });
      expect(joeRow).not.toHaveTextContent('lines');
    });

    // The product decision under test end-to-end: a writer who never types uppercase still gets
    // one Navigator entry, displayed uppercase (screenplay convention), and clicking it still
    // navigates into their lowercase-authored cue -- the display transform must not have broken
    // navigation or turned two differently-cased cues into two rows.
    it('groups lowercase and mixed-case cues into one uppercase-displayed entry, and navigates to the lowercase cue on click', async () => {
      const user = userEvent.setup();
      render(<App initial={mixedCaseCharacterPersisted} />);
      await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

      await user.click(screen.getByRole('tab', { name: 'Characters' }));
      const panel = screen.getByRole('tabpanel');

      // Exactly one row, displayed uppercase, even though neither authored cue ('mara',
      // 'Mara (v.o.)') was ever typed uppercase.
      const rows = within(panel).getAllByRole('button', { name: /mara/i });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent('MARA');
      expect(rows[0]).toHaveTextContent('V.O.');

      await user.click(rows[0] as HTMLElement);

      // Navigates to `cueBlockIds[0]`, the first-cued 'mara' block -- proving the click still
      // resolves to a real block id despite the display name no longer matching the writer's
      // literal text.
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toHaveValue(
          'character',
        ),
      );
      expect(rows[0]).toHaveClass('selected');
    });

    it('highlights the uppercase-displayed row while the caret is in a lowercase-authored dialogue block', async () => {
      render(<App initial={mixedCaseCharacterPersisted} />);
      const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
      const page = canvas.closest('.page');
      if (!page) {
        throw new Error('Missing .page ancestor of the editing canvas.');
      }

      // Same "click below the last element moves the caret to the document end" mechanism the
      // JOE dialogue-highlighting test above already relies on -- `mixedCaseCharacterScreenplay`'s
      // last block is 'She never did.', dialogue following the mixed-case 'Mara (v.o.)' cue.
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 100));
      fireEvent.mouseDown(page, { clientY: 500 });

      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toHaveValue(
          'dialogue',
        ),
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: 'Characters' }));
      const panel = screen.getByRole('tabpanel');

      expect(within(panel).getByRole('button', { name: /^MARA/ })).toHaveClass('selected');
    });

    it('highlights the uppercase-displayed row while the caret is in a parenthetical under a lowercase cue', async () => {
      render(<App initial={mixedCaseParentheticalLastPersisted} />);
      const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
      const page = canvas.closest('.page');
      if (!page) {
        throw new Error('Missing .page ancestor of the editing canvas.');
      }

      // `mixedCaseParentheticalLastScreenplay`'s last block is the '(beat)' parenthetical
      // following the lowercase 'mara' cue.
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 100));
      fireEvent.mouseDown(page, { clientY: 500 });

      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toHaveValue(
          'parenthetical',
        ),
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: 'Characters' }));
      const panel = screen.getByRole('tabpanel');

      expect(within(panel).getByRole('button', { name: /^MARA/ })).toHaveClass('selected');
    });

    it('moves focus and switches the active tab with ArrowRight/ArrowLeft, not only by click', async () => {
      const user = userEvent.setup();
      render(<App initial={twoCharacterPersisted} />);
      await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

      const scenesTab = screen.getByRole('tab', { name: 'Scenes' });
      const charactersTab = screen.getByRole('tab', { name: 'Characters' });
      scenesTab.focus();
      expect(scenesTab).toHaveFocus();
      expect(scenesTab).toHaveAttribute('tabindex', '0');
      expect(charactersTab).toHaveAttribute('tabindex', '-1');

      await user.keyboard('{ArrowRight}');

      expect(charactersTab).toHaveFocus();
      expect(charactersTab).toHaveAttribute('aria-selected', 'true');
      expect(charactersTab).toHaveAttribute('tabindex', '0');
      expect(scenesTab).toHaveAttribute('tabindex', '-1');
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'navigator-panel-characters');

      await user.keyboard('{ArrowLeft}');

      expect(scenesTab).toHaveFocus();
      expect(scenesTab).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'navigator-panel-scenes');
    });

    it('ignores a key other than ArrowLeft/ArrowRight on a tab, leaving focus and selection alone', async () => {
      const user = userEvent.setup();
      render(<App initial={twoCharacterPersisted} />);
      await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

      const scenesTab = screen.getByRole('tab', { name: 'Scenes' });
      scenesTab.focus();

      await user.keyboard('a');

      expect(scenesTab).toHaveFocus();
      expect(scenesTab).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'navigator-panel-scenes');
    });

    it('navigates the editor to a character cue on click, mirroring how the Scenes tab already behaves', async () => {
      const user = userEvent.setup();
      render(<App initial={twoCharacterPersisted} />);
      await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

      // Starts on the scene heading, not a character cue, so the assertion below actually
      // demonstrates the click moved the cursor rather than it having started there.
      expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toHaveValue(
        'scene_heading',
      );

      await user.click(screen.getByRole('tab', { name: 'Characters' }));
      await user.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: /^JOE/ }));

      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toHaveValue(
          'character',
        ),
      );
      // Selection is exposed on the row itself too, matching the Scenes tab's own convention.
      expect(
        within(screen.getByRole('tabpanel')).getByRole('button', { name: /^JOE/ }),
      ).toHaveClass('selected');
    });

    it('highlights a character while the caret is in their dialogue, not only on their cue', async () => {
      render(<App initial={twoCharacterPersisted} />);
      const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
      const page = canvas.closest('.page');
      if (!page) {
        throw new Error('Missing .page ancestor of the editing canvas.');
      }

      // `twoCharacterScreenplay`'s last root block is JOE's own dialogue ('Neither did I.'), not
      // his cue -- so moving the caret there and finding JOE highlighted is proof this reads
      // `deriveCharacters`' full `blockIds` attribution (cue plus contiguous dialogue), not just
      // `cueBlockIds`. Reuses the same "click below the last element moves the caret to the
      // document end" mechanism the near-empty-screenplay test above already exercises and
      // proves reliable in this environment (jsdom has no real layout, so a literal click inside
      // a specific text node cannot be simulated -- `handlePageMouseDown`'s `'end'` focus is the
      // one already-tested way to land the caret inside a block that is not a Navigator target).
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 100));
      fireEvent.mouseDown(page, { clientY: 500 });

      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Active screenplay element' })).toHaveValue(
          'dialogue',
        ),
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: 'Characters' }));
      const panel = screen.getByRole('tabpanel');

      expect(within(panel).getByRole('button', { name: /^JOE/ })).toHaveClass('selected');
      expect(within(panel).getByRole('button', { name: /^MARA/ })).not.toHaveClass('selected');
    });
  });

  it('converts the active element through the selector without changing its stable id', async () => {
    const user = userEvent.setup();
    render(<App />);

    const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );

    expect(getBlock(canvas, firstSceneId)).toHaveAttribute('data-screenplay-element', 'shot');
    expect(screen.getByText('Active element')).toHaveTextContent('Active element');
    expect(within(screen.getByLabelText('Inspector')).getByText('Shot')).toBeVisible();
    expect(screen.queryByRole('button', { name: /1\. INT\. APARTMENT/i })).not.toBeInTheDocument();
    expect(screen.getByText('1 scenes · local draft')).toBeVisible();
    expect(screen.getByText(/validated locally/i)).toBeVisible();
  });

  it('uses selector conversion with local-only undo and redo', async () => {
    const user = userEvent.setup();
    render(<App />);

    const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'character',
    );
    expect(getBlock(canvas, firstSceneId)).toHaveAttribute('data-screenplay-element', 'character');

    await user.click(screen.getByRole('button', { name: 'Undo local change' }));
    expect(getBlock(canvas, firstSceneId)).toHaveAttribute(
      'data-screenplay-element',
      'scene_heading',
    );
    await user.click(screen.getByRole('button', { name: 'Redo local change' }));
    expect(getBlock(canvas, firstSceneId)).toHaveAttribute('data-screenplay-element', 'character');
  });

  it('dispatches keyboard transitions, splits selected text, and keeps ids unique', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: initialScreenplayContent,
      element: mount,
      extensions: screenplayExtensions,
    });
    const actionPosition = findScreenplayBlockPosition(editor, firstActionId);
    if (actionPosition === undefined) {
      throw new Error('Initial action block was not found.');
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, actionPosition + 4)),
    );
    editor.view.focus();
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    const firstAction = editor.state.doc.child(1);
    const splitAction = editor.state.doc.child(2);
    expect(firstAction.textContent).toBe('Sun');
    expect(splitAction.attrs.element).toBe('action');
    expect(splitAction.textContent).toMatch(/^light settles/u);

    const splitPosition = findScreenplayBlockPosition(editor, splitAction.attrs.id as string);
    if (splitPosition === undefined) {
      throw new Error('Split action block was not found.');
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, splitPosition + 1)),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Tab' });
    expect(editor.state.doc.child(2).attrs.element).toBe('character');

    // At the END of the cue, which is what makes this Enter a transition to the next element
    // rather than a split of this one. Enter inside a block keeps the element on both halves (see
    // screenplayEditor.test.ts), so a caret one character in would leave a second character block
    // here and prove nothing about the character-to-dialogue transition this assertion is for.
    const cueBlock = editor.state.doc.child(2);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, splitPosition + 1 + cueBlock.content.size),
      ),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    const ids = Array.from(
      { length: editor.state.doc.childCount },
      (_, index) => editor.state.doc.child(index).attrs.id as string,
    );
    expect(editor.state.doc.child(3).attrs.element).toBe('dialogue');
    expect(new Set(ids)).toHaveLength(ids.length);
    editor.destroy();
    mount.remove();
  });

  it('removes a non-collapsed selection during Enter splitting', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: initialScreenplayContent,
      element: mount,
      extensions: screenplayExtensions,
    });
    const actionPosition = findScreenplayBlockPosition(editor, firstActionId);
    if (actionPosition === undefined) {
      throw new Error('Initial action block was not found.');
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, actionPosition + 4, actionPosition + 9),
      ),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    expect(editor.state.doc.child(1).textContent).toBe('Sun');
    expect(editor.state.doc.child(2).textContent).toMatch(/^ settles across/u);
    editor.destroy();
    mount.remove();
  });

  it('creates a scene heading after a transition', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: initialScreenplayContent,
      element: mount,
      extensions: screenplayExtensions,
    });
    const transitionPosition = findScreenplayBlockPosition(editor, transitionId);
    if (transitionPosition === undefined) {
      throw new Error('Initial transition block was not found.');
    }
    const transition = editor.state.doc.nodeAt(transitionPosition);
    if (transition === null) {
      throw new Error('Initial transition node was not found.');
    }

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, transitionPosition + transition.nodeSize - 1),
      ),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

    const insertedHeading = editor.state.doc.child(5);
    expect(insertedHeading.attrs.element).toBe('scene_heading');
    expect(insertedHeading.textContent).toBe('');
    expect(insertedHeading.attrs.id).not.toBe(transitionId);
    editor.destroy();
    mount.remove();
  });

  it('validates an empty screenplay and starts it as an action block on Enter', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: { content: [], type: 'screenplayDocument' },
      element: mount,
      extensions: screenplayExtensions,
    });

    const emptyProjection = projectLocalScreenplay(editor);
    expect(emptyProjection).toMatchObject({ valid: true });
    if (!emptyProjection.valid) {
      throw new Error('The empty local screenplay should be valid.');
    }
    expect(emptyProjection.screenplay.blocks).toEqual([]);
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).attrs.element).toBe('action');
    expect(projectLocalScreenplay(editor)).toMatchObject({ valid: true });
    editor.destroy();
    mount.remove();
  });

  it('covers empty-boundary splits and refuses an operation without an active text block', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    const editor = new Editor({
      content: initialScreenplayContent,
      element: mount,
      extensions: screenplayExtensions,
    });
    const actionPosition = findScreenplayBlockPosition(editor, firstActionId);
    if (actionPosition === undefined) {
      throw new Error('Initial action block was not found.');
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, actionPosition + 1)),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    expect(editor.state.doc.child(1).textContent).toBe('');

    const fullActionPosition = findScreenplayBlockPosition(
      editor,
      editor.state.doc.child(2).attrs.id as string,
    );
    if (fullActionPosition === undefined) {
      throw new Error('Split action block was not found.');
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(
          editor.state.doc,
          fullActionPosition + editor.state.doc.child(2).nodeSize - 1,
        ),
      ),
    );
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    expect(editor.state.doc.child(3).textContent).toBe('');

    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
    expect(getActiveScreenplayBlock(editor)).toBeUndefined();
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
    fireEvent.keyDown(editor.view.dom, { key: 'Tab' });
    expect(editor.state.doc.childCount).toBe(9);
    editor.destroy();
    mount.remove();
  });

  it('surfaces unsupported and schema-invalid projections without dropping their nodes', () => {
    const unsupportedEditor = {
      state: {
        doc: {
          forEach: (visitor: (node: unknown) => void) =>
            visitor({ attrs: {}, textContent: '', type: { name: 'paragraph' } }),
        },
      },
    } as unknown as Editor;
    const invalidEditor = {
      state: {
        doc: {
          forEach: (visitor: (node: unknown) => void) => {
            visitor({
              attrs: { element: 'action', id: firstActionId },
              textContent: 'Repeated identity.',
              type: { name: 'screenplayBlock' },
            });
            visitor({
              attrs: { element: 'action', id: firstActionId },
              textContent: 'Repeated identity.',
              type: { name: 'screenplayBlock' },
            });
          },
        },
      },
    } as unknown as Editor;
    const malformedEditor = {
      state: {
        doc: {
          forEach: (visitor: (node: unknown) => void) => {
            visitor({
              attrs: { element: 'action', id: firstActionId },
              textContent: 'Repeated identity.',
              type: { name: 'screenplayBlock' },
            });
            visitor({
              attrs: { element: 'bogus', id: 3 },
              textContent: '',
              type: { name: 'screenplayBlock' },
            });
          },
        },
      },
    } as unknown as Editor;

    expect(isScreenplayElementType('action')).toBe(true);
    expect(isScreenplayElementType('bogus')).toBe(false);
    expect(projectLocalScreenplay(unsupportedEditor)).toMatchObject({
      issues: ['Unsupported local editor node: paragraph.'],
      valid: false,
    });
    expect(projectLocalScreenplay(invalidEditor)).toMatchObject({
      valid: false,
    });
    expect(projectLocalScreenplay(malformedEditor)).toMatchObject({
      issues: ['Unsupported local editor node: invalid screenplay block.'],
      valid: false,
    });
  });

  it('retains the working canvas while panels, theme, and zoom change', async () => {
    const user = userEvent.setup();
    render(<App />);

    const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    await user.click(screen.getByRole('button', { name: 'Close inspector' }));
    await user.click(screen.getByRole('button', { name: 'Dark canvas' }));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));

    expect(screen.getByRole('main')).toHaveClass('dark');
    expect(screen.getByLabelText('Zoom level')).toHaveTextContent('110%');
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).not.toBeInTheDocument();
    expect(canvas).toBeVisible();
  });

  it('toggles the element-label overlay class without changing document state, defaulting off', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    const scriptBody = container.querySelector('.script-body');
    if (!scriptBody) {
      throw new Error('Missing .script-body container.');
    }
    expect(scriptBody).not.toHaveClass('show-element-labels');

    const labelToggle = screen.getByRole('button', { name: 'Toggle element labels' });
    expect(labelToggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(labelToggle);
    expect(scriptBody).toHaveClass('show-element-labels');
    expect(labelToggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(labelToggle);
    expect(scriptBody).not.toHaveClass('show-element-labels');
  });

  it('keeps .script-body as the first in-flow child of .page, with .page-number the sole exception', async () => {
    const { container } = render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    const pageEl = container.querySelector('.page');
    if (!pageEl) {
      throw new Error('Missing .page element.');
    }

    // .page-number is the only sibling allowed to precede .script-body: it is the sole element
    // inside .page that is removed from flow (position: absolute; see styles.css). Anything else
    // appearing here silently displaces the manuscript below where the pagination spacers assume
    // it starts, decoupling painted page boundaries from actual content -- exactly the defect a
    // .script-title/.script-meta pair caused before both were removed (see
    // progress/page-rendering.md's 2026-08-09 entry). This assertion is a guard against that
    // recurring: it fails loudly the moment a new in-flow child is added ahead of .script-body,
    // rather than requiring someone to remember why the order matters.
    const childrenBeforeScriptBody = Array.from(pageEl.children).filter(
      (child) => !child.classList.contains('script-body'),
    );
    expect(childrenBeforeScriptBody.map((child) => child.className)).toEqual(['page-number']);

    const scriptBodyIndex = Array.from(pageEl.children).findIndex((child) =>
      child.classList.contains('script-body'),
    );
    expect(scriptBodyIndex).toBe(1);
  });

  it("drives .page's minimum height from the real page count once the initial document paginates", async () => {
    // Three action blocks, each hard-wrapped (no whitespace to wrap at) to exactly 55 lines --
    // the page-fill cap (plan.md's "Page fill and the bottom margin") -- so each one exactly
    // fills its own page with nothing left over: 3 blocks, 3 pages, no ambiguity in the count.
    const linesOfLength = (budget: number, n: number): string => 'x'.repeat(budget * (n - 1) + 1);
    const actionBlock = (index: number): ScreenplayBlock => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      type: 'action',
      text: linesOfLength(60, 55),
    });
    const screenplay: Screenplay = {
      annotations: [],
      blocks: [0, 1, 2].map(actionBlock),
      id: '9c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
      schemaVersion: 1,
      title: 'Three full pages',
      titlePages: [],
      documentSettings: DEFAULT_DOCUMENT_SETTINGS,
    };

    const { container } = render(
      <App
        initial={{
          id: screenplay.id,
          projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
          screenplay,
          title: screenplay.title,
          version: 1,
        }}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    const pageEl = container.querySelector<HTMLElement>('.page');
    if (!pageEl) {
      throw new Error('Missing .page element.');
    }
    // `onCreate`'s `setPageCount` (App.tsx) is a React state update, applied on a render after
    // the one `findByRole` above resolved on (the canvas already exists at pageCount's initial
    // value of 0) -- so this has to poll rather than read the style synchronously. Sourced from
    // the pagination plugin's own PaginationState, not recomputed independently here, matching
    // what the component actually does. pageStackMinHeightIn is the one place the
    // pages*height+(pages-1)*gap arithmetic lives (pagination.ts), so this asserts against that
    // function rather than restating its formula.
    await waitFor(() => {
      expect(pageEl.style.getPropertyValue('--fd-page-stack-min-height')).toBe(
        `${pageStackMinHeightIn(3)}in`,
      );
    });
  });

  it('gives every icon-only control a title tooltip sourced from its accessible name', async () => {
    render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    for (const name of [
      'Undo local change',
      'Redo local change',
      'Toggle element labels',
      'Toggle navigator',
      'Toggle inspector',
      'Close navigator',
      'Close inspector',
      'Zoom out',
      'Zoom in',
    ]) {
      const control = screen.getByRole('button', { name });
      expect(control).toHaveAttribute('title', name);
    }
  });

  it('moves zoom into the toolbar, keeping the ceiling and the output element, with a floor lowered to 50 in this slice', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('100%');

    // The floor moved from 70 to 50 in this slice (zoom.ts's `ZOOM_MIN_PERCENT`, plan.md's "Zoom
    // controls": at 100% the page is roughly 816px, so fit-width lands around 60-85% on ordinary
    // windows and 50% only binds where 12pt Courier is already at the edge of legibility). Six
    // clicks of -10 from 100 is the first one that actually clamps (100, 90, 80, 70, 60, 50, then
    // clamped at 50 rather than reaching 40) -- mirroring this test's own pre-existing shape of
    // "reach the floor, then click once more and confirm it holds."
    const zoomOut = within(toolbar).getByRole('button', { name: 'Zoom out' });
    for (let i = 0; i < 6; i += 1) {
      await user.click(zoomOut);
    }
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('50%');
    await user.click(zoomOut);
    // Clamped at 50, the new floor -- a relocation must preserve the (updated) range.
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('50%');
  });
});

describe('zoom modes', () => {
  /**
   * jsdom lays nothing out, so `.editor-region`'s `clientWidth`/`clientHeight` (what
   * `measureAvailableArea`, zoom.ts, reads to resolve a fit mode) default to 0. Stated directly,
   * matching this suite's own precedent (`getBoundingClientRect` stubs elsewhere in this file) and
   * `floatingPanel.test.ts`'s house rule for anything jsdom cannot lay out for real. 816px is
   * `PAGE_WIDTH_IN` (8.5in) times the CSS specification's fixed 96px/in, i.e. the page's real
   * natural width -- every test below picks its stubbed width as a clean fraction of that number
   * so each assertion is an exact arithmetic claim, not a bound.
   */
  function stubEditorRegionSize(container: HTMLElement, widthPx: number, heightPx: number): void {
    const region = container.querySelector('.editor-region');
    if (!region) {
      throw new Error('Missing .editor-region.');
    }
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: widthPx });
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: heightPx });
  }

  /** `.editor-region`'s `scrollTop`/`scrollHeight`/`clientHeight` -- unlike `clientWidth` above,
   * `scrollTop` is left as jsdom's own plain writable property (no `defineProperty` override
   * needed, and none possible while keeping it settable the way `zoom.ts`'s `restoreCentredScroll`
   * needs to), so reading it back after a zoom click is exactly what the app wrote, nothing more. */
  function stubEditorRegionScroll(
    container: HTMLElement,
    options: { clientHeight: number; scrollHeight: number; scrollTop: number },
  ): HTMLElement {
    const region = container.querySelector<HTMLElement>('.editor-region');
    if (!region) {
      throw new Error('Missing .editor-region.');
    }
    Object.defineProperty(region, 'clientHeight', {
      configurable: true,
      value: options.clientHeight,
    });
    Object.defineProperty(region, 'scrollHeight', {
      configurable: true,
      value: options.scrollHeight,
    });
    region.scrollTop = options.scrollTop;
    return region;
  }

  it("centres zoom on .editor-region's current vertical middle, per the owner's own formula, when the toolbar's Zoom in is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });

    // clientHeight 200, scrollHeight 1000 (scrollableExtent 800), scrollTop 300: the viewport's
    // vertical centre sits 300 + 100 = 400px into the document at 100%.
    const region = stubEditorRegionScroll(container, {
      clientHeight: 200,
      scrollHeight: 1000,
      scrollTop: 300,
    });

    await user.click(within(toolbar).getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => {
      expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('110%');
    });

    // ratio 1.1 (100% -> 110%): centre moves to 400 * 1.1 = 440, then the viewport is re-centred
    // on it: 440 - 100 = 340. jsdom never changes scrollHeight/clientHeight on their own (no real
    // layout), so this also proves `restoreCentredScroll` reads them rather than some other,
    // possibly-stale source -- an unchanged, correctly-read 1000/200 is what makes 340 the right
    // answer here.
    expect(region.scrollTop).toBeCloseTo(340, 9);
  });

  it('resolves "Fit width" against the real available width, and recomputes when the window resizes -- the exact failure plan.md names', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });

    // 612 / 816 = 75%.
    stubEditorRegionSize(container, 612, 100000);
    await user.selectOptions(
      within(toolbar).getByRole('combobox', { name: 'Zoom preset' }),
      'fit-width',
    );
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('75%');

    // The window grows to exactly the page's natural width -- fit-width must now resolve to
    // 100%. A version of this that instead kept showing 75% (fit computed once, then frozen) is
    // the precise regression plan.md's "Zoom controls" warns about, and is what this assertion
    // exists to catch.
    stubEditorRegionSize(container, 816, 100000);
    fireEvent(window, new Event('resize'));

    await waitFor(() => {
      expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('100%');
    });
  });

  it('recomputes a fit mode when a panel opens or closes, not only on window resize', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });

    // 408 / 816 = 50%, the floor exactly -- chosen so the first reading is unambiguous.
    stubEditorRegionSize(container, 408, 100000);
    await user.selectOptions(
      within(toolbar).getByRole('combobox', { name: 'Zoom preset' }),
      'fit-width',
    );
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('50%');

    // Closing the navigator widens `.editor-region` in a real browser; jsdom does not lay that
    // out, so the wider box is stated directly here, the same as the resize test above. What this
    // proves is that the panel-toggle *event* itself triggers a recompute, independent of resize.
    stubEditorRegionSize(container, 816, 100000);
    await user.click(screen.getByRole('button', { name: 'Close navigator' }));

    await waitFor(() => {
      expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('100%');
    });
  });

  it('the preset dropdown jumps straight to a fixed percentage', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });

    await user.selectOptions(within(toolbar).getByRole('combobox', { name: 'Zoom preset' }), '125');

    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('125%');
  });

  it('stepping zoom in or out from a fit mode switches to a fixed percentage anchored on the current resolved value, and stops recomputing on resize', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });

    stubEditorRegionSize(container, 408, 100000); // -> 50%
    await user.selectOptions(
      within(toolbar).getByRole('combobox', { name: 'Zoom preset' }),
      'fit-width',
    );
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('50%');

    await user.click(within(toolbar).getByRole('button', { name: 'Zoom in' }));
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('60%');

    // Now fixed, not fit: growing the window must not silently jump back to a fit computation.
    stubEditorRegionSize(container, 816, 100000);
    fireEvent(window, new Event('resize'));
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('60%');
  });

  it('supports keyboard equivalents for zoom in, zoom out, and reset to 100 percent', async () => {
    render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });

    fireEvent.keyDown(window, { ctrlKey: true, key: '=' });
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('110%');

    fireEvent.keyDown(window, { ctrlKey: true, key: '-' });
    fireEvent.keyDown(window, { ctrlKey: true, key: '-' });
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('90%');

    fireEvent.keyDown(window, { ctrlKey: true, key: '0' });
    expect(within(toolbar).getByLabelText('Zoom level')).toHaveTextContent('100%');
  });

  it('ignores the zoom shortcut keys with no modifier held, so ordinary typing never zooms', async () => {
    render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    const toolbar = screen.getByRole('region', { name: 'Screenplay tools' });
    const zoomLevel = within(toolbar).getByLabelText('Zoom level');

    // Asserted after each key individually, not only once at the end: '=' then '-' would cancel
    // back to 100% even if the modifier guard were missing entirely and both keys were wrongly
    // acted on, which is exactly the kind of pass-for-the-wrong-reason result a single assertion
    // after all three keys cannot tell apart from the guard actually working.
    fireEvent.keyDown(window, { key: '=' });
    expect(zoomLevel).toHaveTextContent('100%');
    fireEvent.keyDown(window, { key: '-' });
    expect(zoomLevel).toHaveTextContent('100%');
    fireEvent.keyDown(window, { key: '0' });
    expect(zoomLevel).toHaveTextContent('100%');
  });
});

describe('title page editing', () => {
  const titlePageId = '00000000-0000-4000-8000-0000000000f1';

  function screenplayWithTitlePages(titlePages: TitlePage[]): PersistedScreenplay {
    const base = persistedScreenplay(
      '11111111-0000-4000-8000-000000000001',
      'Custom Title',
      'INT. APARTMENT - MORNING',
    );
    return { ...base, screenplay: { ...base.screenplay, titlePages } };
  }

  it("renders a screenplay's default title page and lets the writer edit it", async () => {
    const initial = screenplayWithTitlePages([createDefaultTitlePage(titlePageId, 'Custom Title')]);
    render(<App initial={initial} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    expect(screen.getByRole('article', { name: 'Title page' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Title page: title' })).toHaveTextContent(
      'Custom Title',
    );
    expect(screen.getByRole('textbox', { name: 'Title page: written by' })).toHaveTextContent(
      'written by',
    );
    // authors/contact start absent (createDefaultTitlePage's own contract): no line exists yet
    // to render, only the affordance to add one.
    expect(
      screen.queryByRole('textbox', { name: 'Title page: author line 1' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add author line' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add contact line' })).toBeVisible();
  });

  it('autosaves a title-page edit, preserving the rest of the title page exactly', async () => {
    const save = vi.spyOn(api, 'saveScreenplay').mockResolvedValue({ version: 2 });
    const initial = screenplayWithTitlePages([
      {
        id: titlePageId,
        title: 'Custom Title',
        authors: ['Morgan Vale'],
        credit: 'written by',
        source: 'a short story by Iris Kwan',
        draftDate: 'August 2026',
        contact: ['morgan@example.test'],
      },
    ]);
    render(<App initial={initial} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    // Every field is present before the edit, including the two the default-creation path never
    // sets (source, draftDate) -- proving this is real editing support for the whole schema, not
    // merely for the four fields plan.md's default lists.
    expect(screen.getByRole('textbox', { name: 'Title page: based on' })).toHaveTextContent(
      'a short story by Iris Kwan',
    );
    expect(screen.getByRole('textbox', { name: 'Title page: draft date' })).toHaveTextContent(
      'August 2026',
    );

    const draftDateField = screen.getByRole('textbox', { name: 'Title page: draft date' });
    draftDateField.textContent = 'September 2026';
    fireEvent.input(draftDateField);

    await waitFor(() => expect(save).toHaveBeenCalled());
    const savedScreenplay = save.mock.calls.at(-1)?.[2] as Screenplay;
    expect(savedScreenplay.titlePages).toEqual([
      {
        id: titlePageId,
        title: 'Custom Title',
        authors: ['Morgan Vale'],
        credit: 'written by',
        source: 'a short story by Iris Kwan',
        draftDate: 'September 2026',
        contact: ['morgan@example.test'],
      },
    ]);
    save.mockRestore();
  });

  it('does not autosave a freshly loaded title page before any edit', async () => {
    const save = vi.spyOn(api, 'saveScreenplay').mockResolvedValue({ version: 2 });
    const initial = screenplayWithTitlePages([createDefaultTitlePage(titlePageId, 'Custom Title')]);
    render(<App initial={initial} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  });

  it('still treats a screenplay with more than one title page as unsupported and read-only', async () => {
    const initial = screenplayWithTitlePages([
      createDefaultTitlePage(titlePageId, 'Custom Title'),
      createDefaultTitlePage('00000000-0000-4000-8000-0000000000f2', 'Alternate Title'),
    ]);
    render(<App initial={initial} />);

    expect(
      await screen.findByText(
        /contains more than one title page, notes, dual dialogue, or page breaks/i,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('article', { name: 'Title page' })).not.toBeInTheDocument();
  });
});

/**
 * Requirement 2, `progress/paste-sanitization.md`: an invalid projection can never again be
 * silent. `ScreenplayPasteSanitizer` (screenplayEditor.ts) closes the paste route these tests
 * used to reproduce this through, so this file's other invalid-projection test (`'surfaces
 * unsupported and schema-invalid projections without dropping their nodes'`, above) reaches
 * `projectLocalScreenplay` directly with a hand-built fake editor for exactly that reason -- there
 * is no longer a real user action left that drives a live, rendered `<App>` into this state. These
 * tests take the same approach one level up: a duplicate stable id planted directly in the
 * `initial` screenplay the app loads (bypassing the paste path entirely, the same way a
 * pre-this-fix save or a future bug elsewhere in the document pipeline could) reaches
 * `safeParseScreenplay`'s real "Stable id ... must be globally unique" rejection the moment the
 * editor mounts, which is what actually exercises the UI guards under test -- not a stub standing
 * in for `projection`.
 */
describe('an invalid projection is never silent', () => {
  const sharedBlockId = '00000000-0000-4000-8000-000000000501';

  function duplicateIdScreenplay(id: string, title: string): PersistedScreenplay {
    return {
      id,
      projectId: '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f',
      screenplay: {
        annotations: [],
        blocks: [
          { id: sharedBlockId, type: 'scene_heading', text: 'INT. STAGE - DAY' },
          { id: sharedBlockId, type: 'action', text: 'Two blocks, one identity.' },
        ],
        id,
        schemaVersion: 1,
        title,
        titlePages: [],
        documentSettings: DEFAULT_DOCUMENT_SETTINGS,
      },
      title,
      version: 1,
    };
  }

  it('renders an unmissable banner outside .status-center, which the narrow-viewport rule hides', async () => {
    render(
      <App
        initial={duplicateIdScreenplay('9c7c5f7b-c2f0-47a0-a639-dfd0c5702b90', 'Broken Draft')}
      />,
    );

    const banner = await screen.findByText(
      `Not saving · Stable id ${sharedBlockId} must be globally unique within a screenplay.`,
    );
    expect(banner).toBeVisible();
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner.closest('.status-center')).toBeNull();
  });

  it('turns the save-dot next to the title red, not leaving the "attention" class unstyled', async () => {
    const { container } = render(
      <App
        initial={duplicateIdScreenplay('9c7c5f7b-c2f0-47a0-a639-dfd0c5702b91', 'Broken Draft')}
      />,
    );

    await screen.findByText(/Not saving/);
    expect(container.querySelector('.save-dot')).toHaveClass('attention');
  });

  it('disables the export menu items with a reason instead of letting them silently no-op', async () => {
    const user = userEvent.setup();
    render(
      <App
        initial={duplicateIdScreenplay('9c7c5f7b-c2f0-47a0-a639-dfd0c5702b92', 'Broken Draft')}
      />,
    );
    await screen.findByText(/Not saving/);

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    const fdxItem = screen.getByRole('menuitem', { name: 'Download FDX…' });
    const docxItem = screen.getByRole('menuitem', { name: 'Download DOCX…' });
    // The owner's literal report (progress/paste-sanitization.md): "Download PDF did nothing
    // when clicked" on a document a paste had made invalid. This is that exact reproduction.
    const pdfItem = screen.getByRole('menuitem', { name: 'Download PDF…' });
    expect(fdxItem).toBeDisabled();
    expect(docxItem).toBeDisabled();
    expect(pdfItem).toBeDisabled();
    const expectedReason = `Can't export: Stable id ${sharedBlockId} must be globally unique within a screenplay.`;
    expect(fdxItem).toHaveAttribute('title', expectedReason);
    expect(docxItem).toHaveAttribute('title', expectedReason);
    expect(pdfItem).toHaveAttribute('title', expectedReason);

    // A disabled `<button>` never dispatches `click` at all -- this confirms that, rather than
    // trusting the `disabled` attribute's presence alone to mean nothing happens.
    const createObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL });
    await user.click(fdxItem);
    await user.click(docxItem);
    await user.click(pdfItem);
    expect(createObjectURL).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('never attempts a save while the projection is invalid', async () => {
    const save = vi.spyOn(api, 'saveScreenplay');
    render(
      <App
        initial={duplicateIdScreenplay('9c7c5f7b-c2f0-47a0-a639-dfd0c5702b93', 'Broken Draft')}
      />,
    );
    await screen.findByText(/Not saving/);

    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  });
});

describe('FDX download', () => {
  it('downloads the current screenplay as FDX from the File menu', async () => {
    const objectUrl = 'blob:mock-fdx-url';
    const createObjectURL = vi.fn().mockReturnValue(objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild');

    const user = userEvent.setup();
    render(
      <App
        initial={persistedScreenplay(
          '9c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
          'Downloadable Draft',
          'INT. STAGE - DAY',
        )}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download FDX…' }));

    // `fdxDownload.js` is loaded with a dynamic `import()` (App.tsx's `runExport`), not bundled
    // statically, so the object-URL/anchor/click sequence lands on a later microtask than
    // `user.click` itself resolves -- `waitFor` is required, same as DOCX and PDF below.
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blobArgument = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blobArgument.type).toBe('application/xml');
    const anchorCall = appendSpy.mock.calls.find(([node]) => (node as HTMLElement).tagName === 'A');
    expect((anchorCall?.[0] as HTMLAnchorElement).download).toBe('Downloadable Draft.fdx');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);

    vi.unstubAllGlobals();
    clickSpy.mockRestore();
    appendSpy.mockRestore();
  });

  it('tells the writer when the FDX export rejects, instead of an unhandled rejection', async () => {
    // `fdxDownload.js` used to be a static import bundled into App.tsx, so it could not fail to
    // load and never had a failure path at all: a click just ran it. Now that it is loaded with a
    // dynamic `import()` (App.tsx's `runExport`), everything downstream of that `import()` --
    // including a stale hashed chunk 404 after a deploy, or the exporter itself throwing -- is one
    // rejected promise `runExport`'s `.catch` handles uniformly. This mocks the exporter itself
    // throwing (reliable under Vitest's module runner, unlike simulating the `import()` call
    // itself failing) to prove the rejection reaches the same toast PDF already used, rather than
    // becoming a silent unhandled promise rejection -- the regression `runExport` closes for FDX.
    vi.doMock('./fdxDownload.js', () => ({
      triggerFdxDownload: () => {
        throw new Error('Simulated chunk load failure.');
      },
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <App
        initial={persistedScreenplay(
          '9c7c5f7b-c2f0-47a0-a639-dfd0c5702b8b',
          'Downloadable Draft',
          'INT. STAGE - DAY',
        )}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download FDX…' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Export failed/);
    expect(alert).toHaveTextContent(/Simulated chunk load failure/);
    expect(consoleError).toHaveBeenCalledWith('FDX export failed:', expect.any(Error));

    consoleError.mockRestore();
    vi.doUnmock('./fdxDownload.js');
  });
});

describe('DOCX download', () => {
  it('downloads the current screenplay as DOCX from the File menu', async () => {
    const objectUrl = 'blob:mock-docx-url';
    const createObjectURL = vi.fn().mockReturnValue(objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild');

    const user = userEvent.setup();
    render(
      <App
        initial={persistedScreenplay(
          '9c7c5f7b-c2f0-47a0-a639-dfd0c5702b88',
          'Downloadable Draft',
          'INT. STAGE - DAY',
        )}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download DOCX…' }));

    // `docxDownload.js` is loaded with a dynamic `import()` (App.tsx's `runExport`), not bundled
    // statically, so the object-URL/anchor/click sequence lands on a later microtask than
    // `user.click` itself resolves -- `waitFor` is required, same as FDX and PDF.
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blobArgument = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blobArgument.type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const anchorCall = appendSpy.mock.calls.find(([node]) => (node as HTMLElement).tagName === 'A');
    expect((anchorCall?.[0] as HTMLAnchorElement).download).toBe('Downloadable Draft.docx');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);

    vi.unstubAllGlobals();
    clickSpy.mockRestore();
    appendSpy.mockRestore();
  });

  it('tells the writer when the DOCX export rejects, instead of an unhandled rejection', async () => {
    // Same regression as the FDX case above: `docxDownload.js` used to be a static import with no
    // way to fail to load; now that it is loaded with a dynamic `import()`, this proves a rejection
    // downstream of that call reaches the toast instead of becoming a silent unhandled rejection.
    vi.doMock('./docxDownload.js', () => ({
      triggerDocxDownload: () => {
        throw new Error('Simulated chunk load failure.');
      },
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <App
        initial={persistedScreenplay(
          '9c7c5f7b-c2f0-47a0-a639-dfd0c5702b8c',
          'Downloadable Draft',
          'INT. STAGE - DAY',
        )}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download DOCX…' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Export failed/);
    expect(alert).toHaveTextContent(/Simulated chunk load failure/);
    expect(consoleError).toHaveBeenCalledWith('DOCX export failed:', expect.any(Error));

    consoleError.mockRestore();
    vi.doUnmock('./docxDownload.js');
  });
});

describe('PDF download', () => {
  it('downloads the current screenplay as PDF from the File menu', async () => {
    const objectUrl = 'blob:mock-pdf-url';
    const createObjectURL = vi.fn().mockReturnValue(objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild');

    const user = userEvent.setup();
    render(
      <App
        initial={persistedScreenplay(
          '9c7c5f7b-c2f0-47a0-a639-dfd0c5702b89',
          'Downloadable Draft',
          'INT. STAGE - DAY',
        )}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download PDF…' }));

    // `pdfDownload.js` is loaded with a dynamic `import()` (App.tsx's `runExport`), and
    // `triggerPdfDownload` is itself `async` on top of that (`screenplayToPdf` is -- see
    // `@finaler-draft/pdf`'s `index.ts`) -- either alone would put the object-URL/anchor/click
    // sequence on a later microtask than `user.click` itself resolves, so `waitFor` is required
    // here, same as FDX and DOCX above.
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blobArgument = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blobArgument.type).toBe('application/pdf');
    const anchorCall = appendSpy.mock.calls.find(([node]) => (node as HTMLElement).tagName === 'A');
    expect((anchorCall?.[0] as HTMLAnchorElement).download).toBe('Downloadable Draft.pdf');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);

    vi.unstubAllGlobals();
    clickSpy.mockRestore();
    appendSpy.mockRestore();
  });

  it('tells the writer when triggerPdfDownload itself throws, distinct from a screenplayToPdf rejection', async () => {
    // "tells the writer when a PDF export fails" above exercises a real `screenplayToPdf`
    // rejection reached through a real dynamic `import()`. This mocks `pdfDownload.js`'s export to
    // throw synchronously instead, standing in for the other failure mode dynamic `import()`
    // introduces on top of that (a stale hashed chunk 404, or a network failure while offline) --
    // both are just a rejected promise to `runExport`'s `.catch`, so this proves the same code path
    // handles a failure at any point in the chain, not only inside `screenplayToPdf` itself.
    vi.doMock('./pdfDownload.js', () => ({
      triggerPdfDownload: () => {
        throw new Error('Simulated chunk load failure.');
      },
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <App
        initial={persistedScreenplay(
          '9c7c5f7b-c2f0-47a0-a639-dfd0c5702b8d',
          'Downloadable Draft',
          'INT. STAGE - DAY',
        )}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download PDF…' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Export failed/);
    expect(alert).toHaveTextContent(/Simulated chunk load failure/);
    expect(consoleError).toHaveBeenCalledWith('PDF export failed:', expect.any(Error));

    consoleError.mockRestore();
    vi.doUnmock('./pdfDownload.js');
  });
});

describe('document settings', () => {
  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'File menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Document settings…' }));
    return screen.getByRole('dialog', { name: 'Document settings' });
  }

  it('opens from the File menu and closes on Escape, returning focus to the File menu trigger', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    const dialog = await openDialog(user);
    expect(dialog).toBeVisible();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'File menu' })).toHaveFocus();
  });

  /**
   * The bug this increment's scope opened with: `projectDocumentScreenplay` never threaded
   * `documentSettings` into `safeParseScreenplay` at all, so the schema's own `.default()` filled
   * in `DEFAULT_DOCUMENT_SETTINGS` on every save regardless of what was actually stored. A
   * screenplay loaded with non-default settings, edited in a way that has nothing to do with
   * settings at all, must still save those same non-default settings back -- not the
   * specification's defaults.
   */
  it('a loaded screenplay keeps its own non-default settings through an unrelated autosave, not the schema defaults', async () => {
    const custom = persistedScreenplay(
      '4c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
      'Custom settings',
      'INT. WORKSHOP - NIGHT',
      {
        characterIndentIn: 4.1,
        parentheticalIndentIn: 3.6,
        parentheticalWidthIn: 1.8,
        pageNumberStyle: 'roman',
        sceneNumbersEnabled: true,
        autoMoreContinued: false,
      },
    );
    const save = vi.spyOn(api, 'saveScreenplay').mockResolvedValue({ version: 2 });
    const user = userEvent.setup();
    render(<App initial={custom} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    // An edit that has nothing to do with document settings: converting the loaded scene heading
    // to a shot.
    await user.click(screen.getByRole('button', { name: /1\. INT\. WORKSHOP/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'shot',
    );

    await waitFor(() => expect(save).toHaveBeenCalled());
    const savedScreenplay = save.mock.calls.at(-1)?.[2] as Screenplay;
    expect(savedScreenplay.documentSettings).toEqual({
      characterIndentIn: 4.1,
      parentheticalIndentIn: 3.6,
      parentheticalWidthIn: 1.8,
      pageNumberStyle: 'roman',
      sceneNumbersEnabled: true,
      autoMoreContinued: false,
    });
    save.mockRestore();
  });

  /**
   * plan.md: scene numbers are "display only," rendered as decorations, never written into the
   * document. This is the guarantee that makes that true from the writer's side of the autosave
   * path, not just inside the pagination plugin -- the setting most likely to pass vacuously per
   * this scope's own verification note, since nothing else in this suite saves a screenplay with
   * the setting on and inspects what actually got sent.
   */
  it('toggling scene numbers on changes only documentSettings.sceneNumbersEnabled, leaving every block byte-identical', async () => {
    const twoSceneBlocks: ScreenplayBlock[] = [
      {
        id: '00000000-0000-4000-8000-000000000201',
        type: 'scene_heading',
        text: 'INT. APARTMENT - MORNING',
      },
      {
        id: '00000000-0000-4000-8000-000000000202',
        type: 'action',
        text: 'MARA studies the last page of a script.',
      },
      {
        id: '00000000-0000-4000-8000-000000000203',
        type: 'scene_heading',
        text: 'EXT. STREET - DAY',
      },
    ];
    const base = persistedScreenplay(
      '5c7c5f7b-c2f0-47a0-a639-dfd0c5702b87',
      'Two scenes',
      'unused',
    );
    const initial = { ...base, screenplay: { ...base.screenplay, blocks: twoSceneBlocks } };
    const save = vi.spyOn(api, 'saveScreenplay').mockResolvedValue({ version: 2 });
    const user = userEvent.setup();
    render(<App initial={initial} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Number scenes' }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const savedScreenplay = save.mock.calls.at(-1)?.[2] as Screenplay;
    expect(savedScreenplay.documentSettings.sceneNumbersEnabled).toBe(true);
    // `toEqual` is exact structural equality: a `sceneNumber` key silently written onto either
    // scene_heading block here would fail this, not just a changed value on an existing key.
    expect(savedScreenplay.blocks).toEqual(twoSceneBlocks);
    save.mockRestore();
  });

  /**
   * The architectural property `PaginationExtension`'s plugin-state redesign exists to protect:
   * changing a document setting must repaginate in place, never remount the editor, because a
   * remount would reset the ProseMirror document to `initial` and discard local undo history
   * (plan.md requires local undo to survive). Nothing else in this suite would catch a regression
   * back to `.configure()`-only settings, since that would still *render* correctly on the next
   * full page load -- it would only lose history for edits already made before the change.
   */
  it('undo history for an edit made before a settings change still works after the settings change', async () => {
    const user = userEvent.setup();
    render(<App />);
    const canvas = await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    await user.click(screen.getByRole('button', { name: /1\. INT\. APARTMENT/i }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Active screenplay element' }),
      'character',
    );
    expect(getBlock(canvas, firstSceneId)).toHaveAttribute('data-screenplay-element', 'character');
    expect(screen.getByRole('button', { name: 'Undo local change' })).toBeEnabled();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Number scenes' }));
    await user.keyboard('{Escape}');

    // The pre-existing edit and its undo availability both survive the settings change untouched
    // -- if the editor had been remounted, the block would already be back to a fresh
    // `scene_heading` (the remount reloads `initial`, discarding the conversion above entirely)
    // and there would be nothing to undo.
    expect(getBlock(canvas, firstSceneId)).toHaveAttribute('data-screenplay-element', 'character');
    expect(screen.getByRole('button', { name: 'Undo local change' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Undo local change' }));
    expect(getBlock(canvas, firstSceneId)).toHaveAttribute(
      'data-screenplay-element',
      'scene_heading',
    );
  });

  it('tells the writer when a PDF export fails instead of leaving the click silent', async () => {
    // The owner found this by testing paste: Cyrillic, Greek and emoji paste cleanly, save
    // cleanly, and export to FDX and DOCX cleanly -- but PDF's un-embedded standard Courier
    // cannot encode them, so `screenplayToPdf` rejects. The projection is genuinely valid, so
    // `disabled` does not and should not apply: the menu item is enabled, the click runs, and
    // before this the rejection reached `console.error` alone. A writer saw a button that did
    // nothing, which is the same silent failure this scope exists to remove.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <App
        initial={persistedScreenplay(
          '9c7c5f7b-c2f0-47a0-a639-dfd0c5702b8a',
          'Cyrillic Draft',
          'Они пересекают двор.',
        )}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    await user.click(screen.getByRole('button', { name: 'File menu' }));
    const pdfItem = screen.getByRole('menuitem', { name: 'Download PDF…' });
    // Precondition: this is NOT the disabled path. The screenplay is valid; only the export fails.
    expect(pdfItem).not.toBeDisabled();
    await user.click(pdfItem);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Export failed/);
    // The message must identify the failure, not merely announce one -- `@finaler-draft/pdf`
    // names the block and element precisely so a writer can find the offending text.
    expect(alert).toHaveTextContent(/cannot render/i);
    // A toast, not a line in the status bar: the bar has no room for a message naming a block and
    // an element, and it hides `.status-center` entirely below 600px -- exactly when a writer most
    // needs telling that an export failed.
    expect(alert).toHaveClass('toast');
    expect(alert.closest('.statusbar')).toBeNull();

    // Dismissible: unlike "not saving", this describes one completed attempt, not a live state.
    await user.click(screen.getByRole('button', { name: /Dismiss/ }));
    expect(screen.queryByRole('alert')).toBeNull();

    consoleError.mockRestore();
  });
});

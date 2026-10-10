import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { DEFAULT_DOCUMENT_SETTINGS, type Screenplay } from '@finaler-draft/screenplay';
import { editorContentFromScreenplay, seedScreenplayYDoc } from '@finaler-draft/screenplay-editor';
import { encodeCollabRestoredMessage, formatCollabDocumentName } from '@finaler-draft/config';
import type { PersistedScreenplay } from './api.js';

/**
 * Collaboration slice 5 in the browser (plan.md steps 4 and 5). `App.test.tsx`'s whole suite runs
 * with `COLLAB_WS_URL` unset, so it can never reach the branch where a provider is constructed at
 * all; this file mocks `collabConfig.js` to a real-looking URL -- the same technique
 * `App.historicalRevision.test.tsx` uses for the opposite claim -- specifically so the two most
 * load-bearing strings in this slice can be asserted directly:
 *
 *  - the Hocuspocus document name this tab connects with, and
 *  - the `y-indexeddb` database key it replays its offline work from.
 *
 * Both must be `<screenplayId>:<epoch>`. The second is the single most load-bearing line in slice
 * 5's "offline work is never auto-merged into the restored screenplay" guarantee: `y-indexeddb`
 * replays whatever it finds under its key straight into the `Y.Doc` the provider is about to sync,
 * so a bare screenplay id as the key would mean a browser returning from offline after a restore
 * replays its pre-restore document -- including work the server never saw -- into the *restored*
 * document and pushes the merge up as ordinary edits. No server-side check can undo that; it arrives
 * as a legitimate write from an authorized writer at the current epoch.
 */
vi.mock('./collabConfig.js', () => ({ COLLAB_WS_URL: 'wss://collab.example.test' }));

type Listener = (payload: never) => void;

/**
 * A `HocuspocusProvider` stand-in complete enough for everything `App.tsx` does with one: the shared
 * `Y.Doc` the editor binds to, the event surface its sync-state effect subscribes to, and the
 * stateless channel the restore message arrives on. `emit` is the test's hand on that channel --
 * standing in for `apps/collab`'s own `sendStateless`/`broadcastStateless`, whose server half is
 * proven over a real socket in `apps/collab/src/collaboration.integration.test.ts`.
 */
class FakeProvider {
  static instances: FakeProvider[] = [];
  /**
   * The bytes a real first sync would deliver, applied in the constructor so the document is already
   * populated by the time `App` binds an editor to it. This stands in for `apps/collab`'s
   * `createFetch` seeding a fresh epoch from `screenplays.canonical_screenplay`: in collaborative
   * mode the editor's content comes from the Yjs document, never from the `initial.screenplay` prop,
   * so a provider whose document stayed empty would make every assertion below one about an empty
   * screenplay.
   */
  static seed: Uint8Array | undefined;
  readonly document = new Y.Doc();
  readonly awareness = undefined;
  readonly name: string;
  isSynced = false;
  destroyed = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(configuration: { name: string }) {
    this.name = configuration.name;
    if (FakeProvider.seed) Y.applyUpdate(this.document, FakeProvider.seed);
    FakeProvider.instances.push(this);
  }

  on(event: string, listener: Listener): void {
    const existing = this.listeners.get(event) ?? new Set<Listener>();
    existing.add(listener);
    this.listeners.set(event, existing);
  }

  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload as never);
  }

  connect(): void {}
  disconnect(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

vi.mock('@hocuspocus/provider', () => ({ HocuspocusProvider: FakeProvider }));

const indexeddbKeys: string[] = [];
vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    constructor(name: string) {
      indexeddbKeys.push(name);
    }
    destroy(): void {}
  },
}));

const { App } = await import('./App.js');

const screenplayId = '99999999-0000-4000-8000-000000000099';
const projectId = '5d0c5594-64f4-4ca1-a1bd-b4b4840f8e7f';

function persisted(currentEpoch: number): PersistedScreenplay {
  const screenplay: Screenplay = {
    annotations: [],
    blocks: [
      {
        id: '99999999-8d05-4e6e-bac7-e471e8df33a1',
        type: 'scene_heading',
        text: 'INT. APARTMENT - MORNING',
      },
    ],
    documentSettings: DEFAULT_DOCUMENT_SETTINGS,
    id: screenplayId,
    schemaVersion: 1,
    title: 'A Working Draft',
    titlePages: [],
  };
  return { currentEpoch, id: screenplayId, projectId, screenplay, title: 'A Working Draft' };
}

function canvas(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Screenplay editing canvas' });
}

/** Renders, waits for the editor, and brings the connection to `synced` -- the state a real writer
 * is in when a restore lands on them, and the only state in which editing is allowed at all. */
async function renderSynced(
  props: Partial<Parameters<typeof App>[0]> = {},
  currentEpoch = 0,
): Promise<FakeProvider> {
  render(<App initial={persisted(currentEpoch)} {...props} />);
  await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
  const provider = FakeProvider.instances.at(-1)!;
  provider.isSynced = true;
  provider.emit('synced', {});
  await waitFor(() => expect(canvas()).toHaveAttribute('contenteditable', 'true'));
  return provider;
}

beforeEach(() => {
  FakeProvider.instances.length = 0;
  FakeProvider.seed = Y.encodeStateAsUpdate(
    seedScreenplayYDoc(
      editorContentFromScreenplay(persisted(0).screenplay).body,
      undefined,
      DEFAULT_DOCUMENT_SETTINGS,
    ),
  );
  indexeddbKeys.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: 'collab-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
});

describe('the collaboration document this tab connects to', () => {
  it('names the Hocuspocus document and the offline database after the screenplay *and* the epoch', async () => {
    await renderSynced({}, 3);

    expect(FakeProvider.instances).toHaveLength(1);
    expect(FakeProvider.instances[0]!.name).toBe(formatCollabDocumentName(screenplayId, 3));
    expect(indexeddbKeys).toEqual([formatCollabDocumentName(screenplayId, 3)]);
    // Stated as its own assertion rather than left implied by the equality above: a bare screenplay
    // id is exactly the key a pre-restore document's offline work would be replayed from.
    expect(indexeddbKeys[0]).not.toBe(screenplayId);
  });

  it('gives a different epoch of the same screenplay a different document and a different offline database', async () => {
    const { unmount } = render(<App initial={persisted(0)} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    unmount();

    render(<App initial={persisted(1)} />);
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });

    expect(FakeProvider.instances.map((instance) => instance.name)).toEqual([
      formatCollabDocumentName(screenplayId, 0),
      formatCollabDocumentName(screenplayId, 1),
    ]);
    // Two databases, not one: the restored document's store starts empty, and the retired epoch's
    // work stays intact in its own, available for the recovery copy the banner offers.
    expect(new Set(indexeddbKeys).size).toBe(2);
  });
});

describe('being told the screenplay was restored', () => {
  it('shows a terminal banner naming all three facts a writer needs, and stops accepting edits', async () => {
    const provider = await renderSynced();

    provider.emit('stateless', { payload: encodeCollabRestoredMessage(1) });

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('This screenplay was restored to an earlier revision.');
    expect(banner).toHaveTextContent('no longer the live one');
    expect(banner).toHaveTextContent('not part of it');
    // The server already refuses this tab's writes; this is what stops the writer typing into a
    // document whose keystrokes are being set aside rather than saved.
    await waitFor(() => expect(canvas()).not.toHaveAttribute('contenteditable', 'true'));
  });

  it('offers the restored document, and lets the route -- not this component -- decide what that means', async () => {
    const onReloadRestoredDocument = vi.fn();
    const provider = await renderSynced({ onReloadRestoredDocument });
    provider.emit('stateless', { payload: encodeCollabRestoredMessage(2) });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Open the restored screenplay' }),
    );
    expect(onReloadRestoredDocument).toHaveBeenCalledTimes(1);
  });

  it('omits that button when the caller supplies nowhere to reload to', async () => {
    const provider = await renderSynced();
    provider.emit('stateless', { payload: encodeCollabRestoredMessage(1) });

    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Open the restored screenplay' })).toBeNull();
  });

  /**
   * A stateless channel is shared by definition. An unrelated payload must be ignored here rather
   * than coerced into a restore: a client that mistook one for a restore would lock a writer out of
   * a document that was never superseded.
   */
  it('ignores every stateless payload that is not a restore message', async () => {
    const provider = await renderSynced();
    for (const payload of ['', 'not json', '{}', JSON.stringify({ type: 'something-else' })]) {
      provider.emit('stateless', { payload });
    }

    expect(screen.queryByRole('alert')).toBeNull();
    expect(canvas()).toHaveAttribute('contenteditable', 'true');
  });

  /**
   * Once the document this tab holds has been retired, every other explanation on this screen is
   * about a document that is no longer live -- showing two reasons would leave the writer guessing
   * which one to act on.
   */
  it('suppresses the entitlement banner, which is about a document that is no longer live', async () => {
    // Rendered directly rather than through `renderSynced`: an entitlement-read-only screenplay is
    // never editable, so there is no `contenteditable` state to wait for.
    render(
      <App
        entitlementReadOnly={{ message: 'This screenplay is read-only on your current plan.' }}
        initial={persisted(0)}
      />,
    );
    await screen.findByRole('textbox', { name: 'Screenplay editing canvas' });
    const provider = FakeProvider.instances.at(-1)!;
    provider.isSynced = true;
    provider.emit('synced', {});
    expect(screen.getByText('This screenplay is read-only on your current plan.')).toBeVisible();

    provider.emit('stateless', { payload: encodeCollabRestoredMessage(1) });

    await screen.findByText('This screenplay was restored to an earlier revision.');
    expect(
      screen.queryByText('This screenplay is read-only on your current plan.'),
    ).not.toBeInTheDocument();
  });
});

describe('the recovery fork offered to a cut-over writer', () => {
  async function restoredApp(): Promise<FakeProvider> {
    const provider = await renderSynced();
    provider.emit('stateless', { payload: encodeCollabRestoredMessage(1) });
    await screen.findByRole('alert');
    return provider;
  }

  /**
   * plan.md step 5: unsynced work is "preserved as a recovery fork/new screenplay for manual
   * comparison or copying; it is never auto-merged into the restored screenplay." The two things
   * asserted here are the whole of that: a *new* screenplay is created, in this project, and nothing
   * is ever written to the restored screenplay.
   */
  it('saves this browser’s work as a new screenplay in the same project, never into the restored one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await restoredApp();
    vi.stubGlobal('fetch', fetchMock);

    await userEvent.click(
      screen.getByRole('button', { name: 'Save my changes as a new screenplay' }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0]! as [string, { method: string; body: string }];
    expect(path).toBe(`/api/projects/${projectId}/screenplays`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as { title: string; screenplay: Screenplay };
    expect(body.title).toBe('A Working Draft (recovered)');
    expect(body.screenplay.title).toBe('A Working Draft (recovered)');
    // The content really is this browser's document, not an empty placeholder. Narrowed rather than
    // asserted straight through `.text`, which not every block type in the union carries
    // (`page_break` has none) -- and the narrowing doubles as proof the element type survived the
    // fork too, not just the characters.
    const firstBlock = body.screenplay.blocks[0]!;
    if (firstBlock.type !== 'scene_heading') throw new Error('Expected a scene heading first.');
    expect(firstBlock.text).toBe('INT. APARTMENT - MORNING');
    // Nothing is ever sent to the restored screenplay itself.
    expect(fetchMock.mock.calls.some(([callPath]) => String(callPath).includes(screenplayId))).toBe(
      false,
    );

    expect(
      await screen.findByText(/Saved as “A Working Draft \(recovered\)” in this project/),
    ).toBeVisible();
    // The offer is gone once taken -- a second copy would just be confusing.
    expect(
      screen.queryByRole('button', { name: 'Save my changes as a new screenplay' }),
    ).toBeNull();
  });

  it('shows the server’s own refusal inline, and says the work is still on this device', async () => {
    await restoredApp();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              'Free tier limit reached: only one editable screenplay is allowed. Choose an existing one to keep editing, or upgrade to create another.',
          }),
          { status: 402, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Save my changes as a new screenplay' }),
    );

    expect(await screen.findByText(/Free tier limit reached/)).toBeVisible();
    // Still offered: the work is safe locally and in the server's quarantine while the writer sorts
    // the refusal out, so the affordance must not disappear on failure.
    expect(
      screen.getByRole('button', { name: 'Save my changes as a new screenplay' }),
    ).toBeEnabled();
  });
});

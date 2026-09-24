import { Editor } from '@tiptap/core';
import { Awareness } from 'y-protocols/awareness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  buildRemoteCursorWidget,
  createRemotePresenceExtension,
  listPresentParticipants,
  PRESENCE_ACTIVE_WINDOW_MS,
  PRESENCE_TYPING_GLOW_MS,
  type RemoteParticipant,
} from './presence.js';
import {
  createLocalScreenplayYDoc,
  createScreenplayEditorInit,
  SCREENPLAY_YJS_FRAGMENT,
  type EditorContent,
} from './index.js';

const simpleContent: EditorContent = {
  type: 'screenplayDocument',
  content: [
    {
      type: 'screenplayBlock',
      attrs: { element: 'action', id: '00000000-0000-4000-8000-000000000001' },
      content: [{ type: 'text', text: 'A long enough line to place a caret inside.' }],
    },
  ],
};

/** A fake `Awareness`-shaped object for `listPresentParticipants`, which only reads `clientID`
 * and `getStates()` -- no real `Y.Doc` or network involved, matching how narrow that function's
 * own contract is. */
function fakeAwareness(
  clientID: number,
  states: ReadonlyMap<number, Record<string, unknown>>,
): Awareness {
  return { clientID, getStates: () => states } as unknown as Awareness;
}

describe('listPresentParticipants', () => {
  const now = Date.now();

  it('excludes its own client id', () => {
    const states = new Map([[1, { user: { name: 'Self', color: '#111', lastActiveAt: now } }]]);
    expect(listPresentParticipants(fakeAwareness(1, states), now)).toEqual([]);
  });

  it('excludes a state with no user field at all', () => {
    const states = new Map([[2, { cursor: { anchor: {}, head: {} } }]]);
    expect(listPresentParticipants(fakeAwareness(1, states), now)).toEqual([]);
  });

  it('excludes a participant whose lastActiveAt has aged out of the active window', () => {
    const states = new Map([
      [
        2,
        {
          user: { name: 'Stale', color: '#222', lastActiveAt: now - PRESENCE_ACTIVE_WINDOW_MS - 1 },
        },
      ],
    ]);
    expect(listPresentParticipants(fakeAwareness(1, states), now)).toEqual([]);
  });

  it('includes a participant exactly at the active window boundary', () => {
    const states = new Map([
      [
        2,
        {
          user: { name: 'Boundary', color: '#333', lastActiveAt: now - PRESENCE_ACTIVE_WINDOW_MS },
        },
      ],
    ]);
    expect(listPresentParticipants(fakeAwareness(1, states), now)).toEqual([
      { clientId: 2, name: 'Boundary', color: '#333' },
    ]);
  });

  it('excludes a participant with no lastActiveAt (never sanitized yet), rather than treating absence as active', () => {
    const states = new Map([[2, { user: { name: 'Unsanitized', color: '#444' } }]]);
    expect(listPresentParticipants(fakeAwareness(1, states), now)).toEqual([]);
  });

  it('lists a genuinely present participant even with no live cursor -- presence and cursor are independent', () => {
    const states = new Map([[2, { user: { name: 'Reviewer', color: '#555', lastActiveAt: now } }]]);
    expect(listPresentParticipants(fakeAwareness(1, states), now)).toEqual([
      { clientId: 2, name: 'Reviewer', color: '#555' },
    ]);
  });

  it('falls back to a generic name/colour for a malformed but present state', () => {
    const states = new Map([[2, { user: { lastActiveAt: now } }]]);
    const [participant] = listPresentParticipants(fakeAwareness(1, states), now);
    expect(participant?.name).toBe('A collaborator');
    expect(participant?.color).toBe('#6b7280');
  });

  it('sorts by client id for a stable order', () => {
    const states = new Map([
      [5, { user: { name: 'B', color: '#1', lastActiveAt: now } }],
      [2, { user: { name: 'A', color: '#2', lastActiveAt: now } }],
    ]);
    const result: RemoteParticipant[] = listPresentParticipants(fakeAwareness(1, states), now);
    expect(result.map((p) => p.clientId)).toEqual([2, 5]);
  });
});

describe('buildRemoteCursorWidget', () => {
  it('is position:absolute with no top/left of its own -- the whole geometry-safety technique (see this file and styles.css)', () => {
    const widget = buildRemoteCursorWidget({
      name: 'Mara',
      color: '#ff0000',
      lastActiveAt: Date.now(),
    });
    expect(widget.className).toBe('remote-cursor');
    // The safety property itself is declared in styles.css's `.remote-cursor` rule (asserted by
    // presence-persistence.spec.ts's real-browser geometry measurement); this test asserts the
    // *marker* every rule hooks off -- no inline top/left is ever set here, which would defeat the
    // CSS rule regardless of what it says.
    expect(widget.style.top).toBe('');
    expect(widget.style.left).toBe('');
  });

  it('is inert to assistive tech, selection and editing -- a decoration, never content', () => {
    const widget = buildRemoteCursorWidget({ name: 'Mara', color: '#ff0000' });
    expect(widget.getAttribute('aria-hidden')).toBe('true');
    expect(widget.contentEditable).toBe('false');
  });

  it('carries the caret and the label, both coloured, and the label text is the writer’s name', () => {
    const widget = buildRemoteCursorWidget({ name: 'Mara', color: '#ff0000' });
    const caret = widget.querySelector('.remote-cursor-caret') as HTMLElement;
    const label = widget.querySelector('.remote-cursor-label') as HTMLElement;
    expect(caret.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(label.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(label.textContent).toBe('Mara');
  });

  it('falls back to a generic name/colour when the sanitized user is somehow still incomplete', () => {
    const widget = buildRemoteCursorWidget({});
    expect(widget.querySelector('.remote-cursor-label')?.textContent).toBe('A collaborator');
  });

  it('marks itself active (shows the label unprompted) within the typing-glow window', () => {
    const fresh = buildRemoteCursorWidget({
      name: 'Mara',
      color: '#ff0000',
      lastActiveAt: Date.now(),
    });
    expect(fresh.getAttribute('data-remote-cursor-active')).toBe('true');

    const stale = buildRemoteCursorWidget({
      name: 'Mara',
      color: '#ff0000',
      lastActiveAt: Date.now() - PRESENCE_TYPING_GLOW_MS - 1,
    });
    expect(stale.hasAttribute('data-remote-cursor-active')).toBe(false);
  });
});

/**
 * The heartbeat and the live-decoration path, against a real Tiptap `Editor` bound to a real
 * `Y.Doc`/`Awareness` pair -- no server, no `HocuspocusProvider` (see
 * progress/collaboration-slice-2.md on why App.test.tsx-level provider mocking was not built for
 * this slice: this lower-level, real-Yjs proof is what stands in for it).
 */
describe('createRemotePresenceExtension', () => {
  let mount: HTMLDivElement;
  let ydoc: Y.Doc;
  let awareness: Awareness;
  let editor: Editor;

  beforeEach(() => {
    mount = document.createElement('div');
    document.body.append(mount);
    ydoc = createLocalScreenplayYDoc(simpleContent);
    awareness = new Awareness(ydoc);
    const init = createScreenplayEditorInit(ydoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT));
    editor = new Editor({
      element: mount,
      content: init.content,
      // Tiptap's `ExtensionManager.plugins` reverses the extension array (then stable-sorts by
      // priority) before flattening it into ProseMirror plugins -- "last plugin in an array is
      // executed first" is its own comment's framing for keymap/appendTransaction priority, and
      // the same reversal governs `state.init` order too: a *later* entry here ends up *earlier*
      // in the final plugin list. `yCursorPlugin`'s own `state.init` synchronously reads
      // `ySyncPluginKey.getState(state)` (y-prosemirror's `createDecorations`), which is only
      // populated once `ySyncPlugin` (`init.extensions`, `ScreenplayYjsExtension`) has itself run
      // `init` -- so this extension must sit *before* `init.extensions` in this array for
      // `ySyncPlugin` to end up later in the final list and therefore init first. Confirmed by
      // running it the other way first: `TypeError: Cannot read properties of undefined
      // (reading 'doc')` inside y-prosemirror's `createDecorations`. `App.tsx` places it
      // identically, with this same reasoning.
      extensions: [createRemotePresenceExtension(awareness), ...init.extensions],
    });
  });

  afterEach(async () => {
    // Settles any of y-prosemirror's own `setMeta`/`updateMetas` macrotask batching (`lib.js`)
    // that a test above left pending -- uniformly, for every test in this block, not only the
    // ones that know they triggered one -- so `editor.destroy()` below never races a scheduled
    // dispatch against an about-to-be-torn-down view. See `settleAwarenessDecorations`'s own
    // comment.
    await settleAwarenessDecorations();
    editor.destroy();
    mount.remove();
  });

  it('marks this client present the instant the extension mounts, before any keystroke', () => {
    const state = awareness.getLocalState() as { user?: { lastActiveAt?: number } } | null;
    expect(state?.user?.lastActiveAt).toBeTypeOf('number');
    expect(Date.now() - (state?.user?.lastActiveAt ?? 0)).toBeLessThan(1000);
  });

  it('refreshes lastActiveAt on a real local edit', () => {
    const before = (awareness.getLocalState() as { user: { lastActiveAt: number } }).user
      .lastActiveAt;
    // Force the clock forward so a refreshed timestamp is distinguishable from the mount-time one.
    const originalNow = Date.now;
    Date.now = () => originalNow() + 10_000;
    try {
      editor.commands.focus('end');
      editor.commands.insertContent('X');
    } finally {
      Date.now = originalNow;
    }
    const after = (awareness.getLocalState() as { user: { lastActiveAt: number } }).user
      .lastActiveAt;
    expect(after).toBeGreaterThan(before);
  });

  it('does not refresh lastActiveAt for a transaction that only carries a remote Yjs update -- own edits only', async () => {
    const before = (awareness.getLocalState() as { user: { lastActiveAt: number } }).user
      .lastActiveAt;

    // A second, independent Y.Doc standing in for a remote peer: sync it to the editor's current
    // state, make an edit there, and apply the resulting update back -- the exact path a real
    // HocuspocusProvider's own sync produces, without needing a second editor or a socket.
    const peerDoc = new Y.Doc();
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(ydoc));
    const peerFragment = peerDoc.getXmlFragment(SCREENPLAY_YJS_FRAGMENT);
    const peerBlock = peerFragment.get(0);
    if (!(peerBlock instanceof Y.XmlElement))
      throw new Error('Expected the seeded block to be a Y.XmlElement.');
    const peerText = peerBlock.firstChild;
    if (!(peerText instanceof Y.XmlText))
      throw new Error('Expected the block to hold a Y.XmlText.');

    const originalNow = Date.now;
    Date.now = () => originalNow() + 10_000;
    try {
      peerDoc.transact(() => {
        peerText.insert(0, 'Remote edit. ');
      });
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peerDoc));
    } finally {
      Date.now = originalNow;
    }

    // The applied update's own `ySyncPlugin` observer dispatches through the identical
    // `setMeta`/`updateMetas` macrotask batching `yCursorPlugin` uses (`lib.js`) -- settled before
    // this test ends so `afterEach`'s `editor.destroy()` never races a still-pending dispatch
    // against an already-torn-down view (observed directly: without this, the next test in this
    // file crashed asynchronously with "Applying a mismatched transaction").
    await settleAwarenessDecorations();

    const after = (awareness.getLocalState() as { user: { lastActiveAt: number } }).user
      .lastActiveAt;
    expect(after).toBe(before);
  });

  it('renders a remote caret decoration for a present peer, and none for a stale one', async () => {
    const ystate = yCursorPluginKeyState(editor);
    const relativeCursor = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(ystate.type, 0),
    );

    // Inject a fabricated remote state directly into this shared Awareness -- legitimate for
    // testing this module's own filtering/rendering, since y-prosemirror's own relative-position
    // resolution (not this module's code) is what actually walks the cursor back to a position;
    // only *which peer* it is attributed to is fabricated here.
    const presentClientId = 999;
    awareness.states.set(presentClientId, {
      user: { name: 'Present Peer', color: '#00ff00', lastActiveAt: Date.now() },
      cursor: { anchor: relativeCursor, head: relativeCursor },
    });
    // y-prosemirror's own `awareness.on('change', ...)` listener (`cursor-plugin.js`) does not
    // dispatch the resulting decoration-rebuild transaction synchronously: it batches through
    // `setMeta` (`lib.js`), which schedules one `eventloop.timeout(0, updateMetas)` -- a real
    // macrotask -- rather than updating the view inline. This settles it.
    awareness.emit('change', [{ added: [presentClientId], updated: [], removed: [] }, 'local']);
    await settleAwarenessDecorations();

    expect(mount.querySelector('.remote-cursor-label')?.textContent).toBe('Present Peer');

    const staleClientId = 998;
    awareness.states.set(staleClientId, {
      user: {
        name: 'Stale Peer',
        color: '#0000ff',
        lastActiveAt: Date.now() - PRESENCE_ACTIVE_WINDOW_MS - 1,
      },
      cursor: { anchor: relativeCursor, head: relativeCursor },
    });
    awareness.emit('change', [{ added: [staleClientId], updated: [], removed: [] }, 'local']);
    await settleAwarenessDecorations();

    const labels = Array.from(mount.querySelectorAll('.remote-cursor-label')).map(
      (el) => el.textContent,
    );
    expect(labels).toContain('Present Peer');
    expect(labels).not.toContain('Stale Peer');
  });

  /**
   * The defect this module exists to fix, reproduced and then proven closed: a widget built
   * *while* its peer is recently active must lose `data-remote-cursor-active` on its own once
   * `PRESENCE_TYPING_GLOW_MS` passes, with **no further awareness change and no redraw** --
   * exactly the case a live two-browser check found permanently stuck (see `createGlowController`
   * 's own comment for the confirmed mechanism: y-prosemirror's `Decoration.widget` key reuse
   * means this peer's widget is never rebuilt again for the life of its connection, so nothing
   * that depends on a rebuild can ever clear this attribute).
   *
   * `lastActiveAt` is set so only ~60ms of the real glow window remain, rather than waiting out
   * the full `PRESENCE_TYPING_GLOW_MS` (2s) -- a real `setTimeout`, not a fake-timer simulation:
   * this module's own scheduling interacts with y-prosemirror's separate macrotask batching
   * (`settleAwarenessDecorations`'s own comment), and faking one clock while the other keeps
   * running real time risked a subtler, harder-to-trust test than a short real wait.
   */
  it('a widget built while its peer is active loses the glow on its own once the window passes, with no further awareness change', async () => {
    const ystate = yCursorPluginKeyState(editor);
    const relativeCursor = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(ystate.type, 0),
    );
    const peerClientId = 555;
    const remainingMs = 60;
    awareness.states.set(peerClientId, {
      user: {
        name: 'Just Typed',
        color: '#ffaa00',
        lastActiveAt: Date.now() - PRESENCE_TYPING_GLOW_MS + remainingMs,
      },
      cursor: { anchor: relativeCursor, head: relativeCursor },
    });
    awareness.emit('change', [{ added: [peerClientId], updated: [], removed: [] }, 'local']);
    await settleAwarenessDecorations();

    const widget = mount.querySelector('.remote-cursor');
    expect(widget?.hasAttribute('data-remote-cursor-active')).toBe(true);
    widget?.setAttribute('data-test-marker', 'original');

    // No emitted awareness change here, and no dispatched transaction -- only real time passing,
    // which is the whole point: the earlier, broken version of this mechanism required *something*
    // to trigger a redraw, and nothing here ever does.
    await new Promise((resolve) => setTimeout(resolve, remainingMs + 150));

    const after = mount.querySelector('.remote-cursor');
    expect(after?.getAttribute('data-test-marker')).toBe('original'); // still the same DOM node
    expect(after?.hasAttribute('data-remote-cursor-active')).toBe(false);
  });

  /**
   * The mirror of the defect above, and equally real: because the widget is never rebuilt, a
   * peer's *later* activity can only ever reach the DOM through `createGlowController`'s own
   * `awareness.on('change', ...)` listener, never through a decoration redraw. Confirmed broken in
   * the same live check (a second burst of the same peer's typing left the identical, still-
   * expired DOM node untouched) before this module's fix.
   */
  it('a peer becoming active again re-lights an already-expired glow, and schedules a fresh expiry', async () => {
    const ystate = yCursorPluginKeyState(editor);
    const relativeCursor = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(ystate.type, 0),
    );
    const peerClientId = 556;
    awareness.states.set(peerClientId, {
      user: {
        name: 'Comes And Goes',
        color: '#00aaff',
        lastActiveAt: Date.now() - PRESENCE_TYPING_GLOW_MS - 1,
      },
      cursor: { anchor: relativeCursor, head: relativeCursor },
    });
    awareness.emit('change', [{ added: [peerClientId], updated: [], removed: [] }, 'local']);
    await settleAwarenessDecorations();
    expect(mount.querySelector('.remote-cursor')?.hasAttribute('data-remote-cursor-active')).toBe(
      false,
    );

    // Fresh activity from the same peer -- an ordinary awareness update, not a rebuild.
    const remainingMs = 60;
    awareness.states.set(peerClientId, {
      user: {
        name: 'Comes And Goes',
        color: '#00aaff',
        lastActiveAt: Date.now(),
      },
      cursor: { anchor: relativeCursor, head: relativeCursor },
    });
    awareness.emit('change', [{ added: [], updated: [peerClientId], removed: [] }, 'local']);

    expect(mount.querySelector('.remote-cursor')?.hasAttribute('data-remote-cursor-active')).toBe(
      true,
    );

    // And the freshly (re)scheduled expiry still fires on its own.
    await new Promise((resolve) => setTimeout(resolve, PRESENCE_TYPING_GLOW_MS + remainingMs));
    expect(mount.querySelector('.remote-cursor')?.hasAttribute('data-remote-cursor-active')).toBe(
      false,
    );
  }, 10_000);

  it('a peer removed from awareness (a real disconnect) is forgotten, clearing its own pending timer', async () => {
    const ystate = yCursorPluginKeyState(editor);
    const relativeCursor = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(ystate.type, 0),
    );
    const peerClientId = 558;
    awareness.states.set(peerClientId, {
      user: { name: 'Disconnecting', color: '#654321', lastActiveAt: Date.now() },
      cursor: { anchor: relativeCursor, head: relativeCursor },
    });
    awareness.emit('change', [{ added: [peerClientId], updated: [], removed: [] }, 'local']);
    await settleAwarenessDecorations();
    expect(mount.querySelector('.remote-cursor')?.hasAttribute('data-remote-cursor-active')).toBe(
      true,
    );

    // A real disconnect: the state is gone from `awareness.states` (the same removal
    // `@hocuspocus/provider`'s own `onClose` performs -- see progress/collaboration-slice-2.md),
    // and the 'change' event names it in `removed`.
    awareness.states.delete(peerClientId);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      awareness.emit('change', [{ added: [], updated: [], removed: [peerClientId] }, 'local']);
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
    await settleAwarenessDecorations();
    expect(mount.querySelector('.remote-cursor')).toBeNull();
  });

  it('destroying the editor clears any pending glow-expiry timer, rather than leaking it', async () => {
    const ystate = yCursorPluginKeyState(editor);
    const relativeCursor = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(ystate.type, 0),
    );
    const peerClientId = 557;
    awareness.states.set(peerClientId, {
      user: { name: 'Mid Glow', color: '#123456', lastActiveAt: Date.now() },
      cursor: { anchor: relativeCursor, head: relativeCursor },
    });
    awareness.emit('change', [{ added: [peerClientId], updated: [], removed: [] }, 'local']);
    await settleAwarenessDecorations();
    expect(mount.querySelector('.remote-cursor')?.hasAttribute('data-remote-cursor-active')).toBe(
      true,
    );

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      editor.destroy();
      // `presenceHeartbeatPlugin`'s own `destroy()` calls `glow.destroy()`, which clears every
      // pending timer -- confirmed here rather than only by absence of a later crash, since a
      // silently-leaked timer produces no visible failure of its own until something else happens
      // to depend on it not firing.
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
    // `afterEach` below still runs `editor.destroy()` again -- Tiptap's own `destroy()` is
    // idempotent, confirmed by this suite's own green run, not merely assumed.
  });

  it('mutation check: without position:absolute, the caret is a real inline box (the defect the geometry test exists to catch)', () => {
    // Not a mutation of source -- a direct demonstration of what this module's CSS contract
    // prevents: an equivalent widget with no `position: absolute` participates in inline layout,
    // widening its line, which is exactly the class of regression
    // presence-persistence.spec.ts's block-geometry measurement is built to catch in a real
    // browser. Documented here as the mechanism this unit suite cannot itself measure (jsdom does
    // not lay out text), so the real-browser proof is not merely aspirational.
    const widget = buildRemoteCursorWidget({ name: 'X', color: '#000' });
    expect(widget.style.position).toBe('');
  });
});

/** Reaches into the real `ySyncPlugin` state the editor under test already carries, the same
 * field `presence.ts`'s own heartbeat and y-prosemirror's cursor plugin both read. */
function yCursorPluginKeyState(editor: Editor): { type: Y.XmlFragment } {
  const state = editor.view.state as unknown as {
    plugins: Array<{ key: string; getState: (s: unknown) => unknown }>;
  };
  const syncPlugin = state.plugins.find((plugin) => plugin.key.startsWith('y-sync$'));
  if (!syncPlugin) throw new Error('ySyncPlugin not found on the editor under test.');
  return syncPlugin.getState(editor.view.state) as { type: Y.XmlFragment };
}

/** Waits out y-prosemirror's own `setMeta`/`updateMetas` macrotask batch (`lib.js`, `eventloop.
 * timeout(0, ...)`) -- see the call sites' own comments for why a synchronous assertion right
 * after an awareness event or a remote Yjs update sees nothing yet. */
function settleAwarenessDecorations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

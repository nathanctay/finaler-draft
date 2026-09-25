import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  PRESENCE_ACTIVE_WINDOW_MS,
  PRESENCE_TYPING_GLOW_MS,
} from '@finaler-draft/screenplay-editor';
import { TitlePageView } from './titlePageEditor.js';
import type { TitlePageState } from './titlePageState.js';
import {
  computeOverlayPosition,
  locateTitlePageCursorField,
  measureCaretRect,
  titlePageCursorFromSelection,
  type TitlePageCursor,
} from './titlePageCursors.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const id = '00000000-0000-4000-8000-000000000001';

function populatedState(): TitlePageState {
  return {
    id,
    title: 'THE LAST STOP',
    credit: 'written by',
    source: '',
    draftDate: '',
    authors: ['Morgan Vale', 'Iris Kwan'],
    contact: ['morgan@example.test', 'iris@example.test'],
  };
}

/** A second, independent `Awareness` instance standing in for a remote peer -- copied from
 * `ParticipantIndicator.test.tsx`'s own helper of the same name and for the identical reason:
 * `listPresentParticipants`/this module both exclude the *local* client id, so a state has to come
 * from a genuinely different `Awareness` to read as "someone else". */
function otherAwareness(): Awareness {
  return new Awareness(new Y.Doc());
}

/** Collapses the real DOM selection at `offset` characters into `field`'s own text -- the
 * "keystroke moves the caret" signal a real browser produces, which `useTitlePagePresence`'s own
 * `selectionchange` listener reads. jsdom does not fire `selectionchange` on its own when a
 * selection is mutated programmatically (a long-standing gap, the same category
 * `titlePageEditor.test.tsx`'s own `typeInto` helper works around for `input`), so this dispatches
 * it manually. */
function selectAt(field: HTMLElement, offset: number): void {
  const selection = document.getSelection();
  if (!selection) throw new Error('Expected a Selection in this environment.');
  const range = document.createRange();
  const textNode = field.firstChild;
  if (textNode instanceof Text) {
    range.setStart(textNode, offset);
    range.setEnd(textNode, offset);
  } else {
    range.setStart(field, 0);
    range.setEnd(field, 0);
  }
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

/** Moves the selection to somewhere outside the title page entirely -- the "left the title page"
 * signal that must clear a broadcast cursor. */
function selectOutside(): void {
  const outside = document.createElement('div');
  outside.textContent = 'elsewhere';
  document.body.append(outside);
  const selection = document.getSelection();
  if (!selection) throw new Error('Expected a Selection in this environment.');
  const range = document.createRange();
  range.setStart(outside.firstChild!, 0);
  range.setEnd(outside.firstChild!, 0);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('titlePageCursorFromSelection', () => {
  it('returns undefined with no selection at all', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    expect(titlePageCursorFromSelection(root, null)).toBeUndefined();
  });

  it('returns undefined when the selection has no ranges', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    const selection = document.getSelection();
    selection?.removeAllRanges();
    expect(titlePageCursorFromSelection(root, selection)).toBeUndefined();
  });

  it('returns undefined when the selection is outside the title page entirely', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    selectOutside();
    expect(titlePageCursorFromSelection(root, document.getSelection())).toBeUndefined();
  });

  it('reads a caret offset inside a simple field', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    selectAt(screen.getByRole('textbox', { name: 'Title page: title' }), 4);
    expect(titlePageCursorFromSelection(root, document.getSelection())).toEqual({
      field: 'title',
      offset: 4,
    });
  });

  it('reads the offset as the field’s full text length when the caret is collapsed after the sole text child rather than misreading it as offset zero', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    const titleField = screen.getByRole('textbox', { name: 'Title page: title' });
    const selection = document.getSelection()!;
    const range = document.createRange();
    // `startContainer` is the field element itself, `startOffset: 1` -- a child-node index (the
    // field has exactly one child), not a character offset -- reported by real browsers for a
    // caret at the very end of a field's text.
    range.setStart(titleField, 1);
    range.setEnd(titleField, 1);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(titlePageCursorFromSelection(root, selection)).toEqual({
      field: 'title',
      offset: 'THE LAST STOP'.length,
    });
  });

  it('reads offset 0 for a genuinely empty field with no text node at all', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    const sourceField = screen.getByRole('textbox', { name: 'Title page: based on' });
    expect(sourceField.childNodes.length).toBe(0);
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(sourceField, 0);
    range.setEnd(sourceField, 0);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(titlePageCursorFromSelection(root, selection)).toEqual({ field: 'source', offset: 0 });
  });

  it('resolves the line index for the second author line, not the first', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    selectAt(screen.getByRole('textbox', { name: 'Title page: author line 2' }), 2);
    expect(titlePageCursorFromSelection(root, document.getSelection())).toEqual({
      field: 'author',
      lineIndex: 1,
      offset: 2,
    });
  });

  it('resolves the line index for the first contact line independently of the author list', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    selectAt(screen.getByRole('textbox', { name: 'Title page: contact line 1' }), 3);
    expect(titlePageCursorFromSelection(root, document.getSelection())).toEqual({
      field: 'contact',
      lineIndex: 0,
      offset: 3,
    });
  });
});

describe('locateTitlePageCursorField', () => {
  it('finds a simple field by name', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    expect(locateTitlePageCursorField(root, { field: 'title', offset: 0 })).toBe(
      screen.getByRole('textbox', { name: 'Title page: title' }),
    );
  });

  it('finds the second author line, not the first, for lineIndex 1', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    expect(locateTitlePageCursorField(root, { field: 'author', lineIndex: 1, offset: 0 })).toBe(
      screen.getByRole('textbox', { name: 'Title page: author line 2' }),
    );
  });

  it('returns undefined for a lineIndex beyond the current number of lines -- the line was removed since the cursor was broadcast', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    expect(
      locateTitlePageCursorField(root, { field: 'author', lineIndex: 99, offset: 0 }),
    ).toBeUndefined();
  });

  it('returns undefined for a multi-line field with no lineIndex at all', () => {
    const { container } = render(
      <TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />,
    );
    const root = container.querySelector('.title-page')!;
    expect(
      locateTitlePageCursorField(root, { field: 'author', offset: 0 } as TitlePageCursor),
    ).toBeUndefined();
  });
});

describe('measureCaretRect', () => {
  it('returns the field’s own bounding rect for a genuinely empty field, not a zero-width Range', () => {
    const field = document.createElement('div');
    document.body.append(field);
    const fakeRect = new DOMRect(10, 20, 0, 18);
    vi.spyOn(field, 'getBoundingClientRect').mockReturnValue(fakeRect);
    expect(measureCaretRect(field, 0)).toBe(fakeRect);
  });

  it('clamps an offset past the end of the text rather than throwing an IndexSizeError', () => {
    const field = document.createElement('div');
    field.textContent = 'Hi';
    document.body.append(field);
    expect(() => measureCaretRect(field, 999)).not.toThrow();
  });

  it('clamps a negative offset to zero rather than throwing', () => {
    const field = document.createElement('div');
    field.textContent = 'Hi';
    document.body.append(field);
    expect(() => measureCaretRect(field, -5)).not.toThrow();
  });
});

describe('computeOverlayPosition', () => {
  it('computes the local top/left at zoom 100% as a plain rect delta', () => {
    const caretRect = new DOMRect(150, 250, 0, 18);
    const containerRect = new DOMRect(100, 200, 800, 1000);
    expect(computeOverlayPosition(caretRect, containerRect, 1)).toEqual({ top: 50, left: 50 });
  });

  it('divides the rendered delta by the zoom fraction, undoing the second scaling a zoomed ancestor would otherwise apply', () => {
    // At 0.6 zoom, a *local* 100px/100px offset renders as 60px/60px -- the rendered delta this
    // function is given -- so dividing by 0.6 must recover exactly 100/100.
    const caretRect = new DOMRect(160, 260, 0, 18);
    const containerRect = new DOMRect(100, 200, 800, 1000);
    const { top, left } = computeOverlayPosition(caretRect, containerRect, 0.6);
    expect(left).toBeCloseTo(100, 5);
    expect(top).toBeCloseTo(100, 5);
  });

  it('falls back to a fraction of 1 rather than dividing by zero for a non-positive zoom fraction', () => {
    const caretRect = new DOMRect(150, 250, 0, 18);
    const containerRect = new DOMRect(100, 200, 800, 1000);
    expect(computeOverlayPosition(caretRect, containerRect, 0)).toEqual({ top: 50, left: 50 });
  });
});

describe('useTitlePagePresence (through TitlePageView)', () => {
  it('renders no remote cursor at all with no awareness -- local, unconnected mode', () => {
    render(<TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />);
    expect(document.querySelector('.remote-cursor')).toBeNull();
  });

  it('renders a peer already present and positioned at mount, not only one who moves later -- the exact defect slice 2 shipped once', () => {
    const awareness = new Awareness(new Y.Doc());
    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Reviewer', color: '#2563eb', lastActiveAt: Date.now() },
      titlePageCursor: { field: 'title', offset: 3 },
    });
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);
    // No `awareness.emit('change', ...)` anywhere in this test -- the initial render's own effect
    // must already read this pre-seeded state.
    expect(document.querySelector('.remote-cursor')).not.toBeNull();
    expect(document.querySelector('.remote-cursor-label')).toHaveTextContent('Reviewer');
  });

  it('renders a peer who becomes present after mount, via an awareness change', async () => {
    const awareness = new Awareness(new Y.Doc());
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);
    expect(document.querySelector('.remote-cursor')).toBeNull();

    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Writer', color: '#16a34a', lastActiveAt: Date.now() },
      titlePageCursor: { field: 'credit', offset: 0 },
    });
    awareness.emit('change', [{ added: [peer.clientID], updated: [], removed: [] }, 'local']);

    await waitFor(() => expect(document.querySelector('.remote-cursor')).not.toBeNull());
  });

  it('never renders a cursor for a peer with no titlePageCursor, or one who has aged out of the active window', () => {
    const awareness = new Awareness(new Y.Doc());
    const noCursorPeer = otherAwareness();
    awareness.states.set(noCursorPeer.clientID, {
      user: { name: 'Body Writer', color: '#000', lastActiveAt: Date.now() },
    });
    const stalePeer = otherAwareness();
    awareness.states.set(stalePeer.clientID, {
      user: {
        name: 'Stale',
        color: '#111',
        lastActiveAt: Date.now() - PRESENCE_ACTIVE_WINDOW_MS - 1,
      },
      titlePageCursor: { field: 'title', offset: 0 },
    });
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);
    expect(document.querySelector('.remote-cursor')).toBeNull();
  });

  it('never throws for a titlePageCursor naming a line that no longer exists', () => {
    const awareness = new Awareness(new Y.Doc());
    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Ghost Line', color: '#000', lastActiveAt: Date.now() },
      titlePageCursor: { field: 'author', lineIndex: 99, offset: 0 },
    });
    expect(() =>
      render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />),
    ).not.toThrow();
    expect(document.querySelector('.remote-cursor')).toBeNull();
  });

  it('positions the widget from a measured caret rect, divided by the current zoom fraction', () => {
    const awareness = new Awareness(new Y.Doc());
    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Writer', color: '#16a34a', lastActiveAt: Date.now() },
      titlePageCursor: { field: 'title', offset: 0 },
    });
    const { container } = render(
      <TitlePageView
        awareness={awareness}
        onChange={vi.fn()}
        state={populatedState()}
        zoomPercent={50}
      />,
    );
    const article = container.querySelector('.title-page') as HTMLElement;
    vi.spyOn(article, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 600));
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      new DOMRect(40, 20, 0, 16),
    ] as unknown as DOMRectList);

    awareness.emit('change', [{ added: [], updated: [peer.clientID], removed: [] }, 'local']);

    const widget = document.querySelector('.remote-cursor') as HTMLElement;
    // (40 - 0) / 0.5 = 80, (20 - 0) / 0.5 = 40 -- see computeOverlayPosition's own tests for the
    // arithmetic in isolation; this proves the full pipeline actually applies it to the DOM.
    expect(widget.style.left).toBe('80px');
    expect(widget.style.top).toBe('40px');
  });

  it('never appends a widget inside a [data-title-page-field] subtree -- it is always a sibling, never a descendant that could corrupt the field’s own textContent', () => {
    const awareness = new Awareness(new Y.Doc());
    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Writer', color: '#16a34a', lastActiveAt: Date.now() },
      titlePageCursor: { field: 'title', offset: 3 },
    });
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);
    const widget = document.querySelector('.remote-cursor');
    expect(widget).not.toBeNull();
    expect(widget?.closest('[data-title-page-field]')).toBeNull();
    // Its own direct parent is the title-page article itself.
    expect(widget?.parentElement).toHaveClass('title-page');
  });

  it('a widget built while its peer is active loses the glow on its own once the window passes, with no further awareness change', async () => {
    const awareness = new Awareness(new Y.Doc());
    const peer = otherAwareness();
    const remainingMs = 60;
    awareness.states.set(peer.clientID, {
      user: {
        name: 'Just Typed',
        color: '#ffaa00',
        lastActiveAt: Date.now() - PRESENCE_TYPING_GLOW_MS + remainingMs,
      },
      titlePageCursor: { field: 'title', offset: 0 },
    });
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);

    const widget = document.querySelector('.remote-cursor');
    expect(widget?.hasAttribute('data-remote-cursor-active')).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, remainingMs + 150));

    expect(widget?.hasAttribute('data-remote-cursor-active')).toBe(false);
  });

  it('a peer becoming active again re-lights an already-expired glow', async () => {
    const awareness = new Awareness(new Y.Doc());
    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: {
        name: 'Comes And Goes',
        color: '#00aaff',
        lastActiveAt: Date.now() - PRESENCE_TYPING_GLOW_MS - 1,
      },
      titlePageCursor: { field: 'title', offset: 0 },
    });
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);
    expect(
      document.querySelector('.remote-cursor')?.hasAttribute('data-remote-cursor-active'),
    ).toBe(false);

    awareness.states.set(peer.clientID, {
      user: { name: 'Comes And Goes', color: '#00aaff', lastActiveAt: Date.now() },
      titlePageCursor: { field: 'title', offset: 0 },
    });
    awareness.emit('change', [{ added: [], updated: [peer.clientID], removed: [] }, 'local']);

    expect(
      document.querySelector('.remote-cursor')?.hasAttribute('data-remote-cursor-active'),
    ).toBe(true);
  });

  it('a peer removed from awareness (a real disconnect) is forgotten, clearing its own pending timer', () => {
    const awareness = new Awareness(new Y.Doc());
    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Disconnecting', color: '#654321', lastActiveAt: Date.now() },
      titlePageCursor: { field: 'title', offset: 0 },
    });
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);
    expect(document.querySelector('.remote-cursor')).not.toBeNull();

    awareness.states.delete(peer.clientID);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    awareness.emit('change', [{ added: [], updated: [], removed: [peer.clientID] }, 'local']);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(document.querySelector('.remote-cursor')).toBeNull();
  });

  it('a peer who leaves the title page (but stays connected elsewhere) has their widget removed, even with no disconnect at all', () => {
    const awareness = new Awareness(new Y.Doc());
    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Moved On', color: '#654321', lastActiveAt: Date.now() },
      titlePageCursor: { field: 'title', offset: 0 },
    });
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);
    expect(document.querySelector('.remote-cursor')).not.toBeNull();

    // Still connected and present -- just no longer editing the title page.
    awareness.states.set(peer.clientID, {
      user: { name: 'Moved On', color: '#654321', lastActiveAt: Date.now() },
    });
    awareness.emit('change', [{ added: [], updated: [peer.clientID], removed: [] }, 'local']);
    expect(document.querySelector('.remote-cursor')).toBeNull();
  });

  it('unmounting clears every pending glow-expiry timer, rather than leaking it', () => {
    const awareness = new Awareness(new Y.Doc());
    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Mid Glow', color: '#123456', lastActiveAt: Date.now() },
      titlePageCursor: { field: 'title', offset: 0 },
    });
    const { unmount } = render(
      <TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />,
    );
    expect(
      document.querySelector('.remote-cursor')?.hasAttribute('data-remote-cursor-active'),
    ).toBe(true);

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('broadcasts this writer’s own cursor when the selection moves inside a title-page field, and marks presence active', () => {
    const awareness = new Awareness(new Y.Doc());
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);

    selectAt(screen.getByRole('textbox', { name: 'Title page: title' }), 4);

    const local = awareness.getLocalState() as {
      titlePageCursor?: TitlePageCursor;
      user?: { lastActiveAt?: number };
    } | null;
    expect(local?.titlePageCursor).toEqual({ field: 'title', offset: 4 });
    expect(local?.user?.lastActiveAt).toBeTypeOf('number');
    expect(Date.now() - (local?.user?.lastActiveAt ?? 0)).toBeLessThan(1000);
  });

  it('broadcasts the correct line index for a multi-line field', () => {
    const awareness = new Awareness(new Y.Doc());
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);

    selectAt(screen.getByRole('textbox', { name: 'Title page: contact line 2' }), 1);

    const local = awareness.getLocalState() as { titlePageCursor?: TitlePageCursor } | null;
    expect(local?.titlePageCursor).toEqual({ field: 'contact', lineIndex: 1, offset: 1 });
  });

  it('clears the broadcast cursor when the selection leaves the title page', () => {
    const awareness = new Awareness(new Y.Doc());
    render(<TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />);
    selectAt(screen.getByRole('textbox', { name: 'Title page: title' }), 4);
    expect(
      (awareness.getLocalState() as { titlePageCursor?: TitlePageCursor } | null)?.titlePageCursor,
    ).toBeDefined();

    selectOutside();

    expect(
      (awareness.getLocalState() as { titlePageCursor?: TitlePageCursor } | null)?.titlePageCursor,
    ).toBeUndefined();
  });

  it('clears the broadcast cursor on unmount, so a departing writer’s stale position does not linger for peers still connected', () => {
    const awareness = new Awareness(new Y.Doc());
    const { unmount } = render(
      <TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />,
    );
    selectAt(screen.getByRole('textbox', { name: 'Title page: title' }), 2);
    expect(
      (awareness.getLocalState() as { titlePageCursor?: TitlePageCursor } | null)?.titlePageCursor,
    ).toBeDefined();

    unmount();

    expect(
      (awareness.getLocalState() as { titlePageCursor?: TitlePageCursor } | null)?.titlePageCursor,
    ).toBeUndefined();
  });

  it('a read-only viewer’s own cursor still broadcasts -- visible, per plan.md, even though their keystrokes are separately blocked', () => {
    const awareness = new Awareness(new Y.Doc());
    render(
      <TitlePageView awareness={awareness} onChange={vi.fn()} readOnly state={populatedState()} />,
    );
    const titleField = screen.getByRole('textbox', { name: 'Title page: title' });
    expect(titleField).not.toHaveAttribute('contenteditable', 'true');

    selectAt(titleField, 2);

    expect(
      (awareness.getLocalState() as { titlePageCursor?: TitlePageCursor } | null)?.titlePageCursor,
    ).toEqual({ field: 'title', offset: 2 });
  });

  it('stops listening -- both broadcasting and rendering -- once awareness is swapped out from under it', () => {
    const awareness = new Awareness(new Y.Doc());
    const { rerender } = render(
      <TitlePageView awareness={awareness} onChange={vi.fn()} state={populatedState()} />,
    );
    rerender(<TitlePageView awareness={undefined} onChange={vi.fn()} state={populatedState()} />);

    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Ghost', color: '#000', lastActiveAt: Date.now() },
      titlePageCursor: { field: 'title', offset: 0 },
    });
    awareness.emit('change', [{ added: [peer.clientID], updated: [], removed: [] }, 'local']);
    expect(document.querySelector('.remote-cursor')).toBeNull();

    // And a selection change reaching the now-detached instance must not throw or write anywhere
    // a later test could observe.
    expect(() =>
      selectAt(screen.getByRole('textbox', { name: 'Title page: title' }), 1),
    ).not.toThrow();
  });
});

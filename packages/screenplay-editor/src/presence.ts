/**
 * Remote presence: awareness-driven cursors, and the participant list `apps/web`'s status bar
 * reads. `progress/collaboration-plan.md` ("Slice 2 -- presence, cursors, and reconnection"):
 * "Cursors and presence are transient and never belong in history." Nothing in this module ever
 * touches the Yjs *document* -- it only ever reads and writes `Awareness`, y-protocols' own
 * separate, non-persistent CRDT-adjacent structure that `@hocuspocus/server`'s Database extension
 * (`apps/collab/src/database.ts`) never sees, since only `onStoreDocument` -- document updates --
 * reaches it. `apps/collab/src/presence.test.ts` and `presence.integration.test.ts` prove that
 * boundary from the server side; this module is what makes it true on the client side, by
 * construction: it has no reference to anything that could write to `document_yjs_state`.
 *
 * ## What awareness carries, and why
 *
 * Each connected browser's local awareness state has exactly two fields this module ever sets:
 *
 *  - `cursor`: y-prosemirror's own field (`yCursorPlugin`, reused unmodified below), a pair of Yjs
 *    relative positions (`{anchor, head}`) that remap correctly across concurrent edits -- an
 *    absolute integer position would be meaningless the instant a peer typed before it.
 *  - `user`: `{ name, color, lastActiveAt }`. `apps/collab/src/presence.ts`'s
 *    `sanitizeAwarenessStates` (`beforeHandleAwareness`) overwrites `name`/`color` on every inbound
 *    update with the value it derives server-side from the authenticated connection's own actor id
 *    -- never trusting what a client claims about its own identity, the same "a collaboration
 *    server that trusts its clients is a data-integrity problem" principle slice 1 applied to
 *    writes now applied to identity. This client therefore never even computes its own name/colour
 *    -- there would be nothing for anyone to read them from. `lastActiveAt` is the one field the
 *    server does *not* recompute (see that module's own comment for why: only the client can tell
 *    a real keystroke apart from the periodic awareness heartbeat that keeps a connection from
 *    being locally garbage-collected -- y-protocols' own `Awareness` class doc comment: "Awareness
 *    states must be updated every 30 seconds. Otherwise the Awareness instance will delete the
 *    client state," which is a liveness requirement, not an activity signal).
 *
 * Deliberately absent: email, role, account id, or anything else the session carries. A display
 * name is the only identity a collaborator's cursor needs to be legible, and awareness reaches
 * every other connected client (plan.md: "Presence is a privacy surface... decide what it exposes
 * before building it, not after") -- so this defaults to less, not more.
 *
 * ## Colour
 *
 * Stable per *user*, not per session: `apps/collab/src/presence.ts`'s `deriveParticipantColor`
 * hashes the actor id into a fixed palette. A reconnecting writer keeps the same colour (a colour
 * that changes on every reload would be its own kind of confusing), at the cost of two accounts
 * occasionally hashing to the same slot -- accepted, since the name label (on hover, or briefly
 * while typing) is always available to disambiguate, and a small palette across a handful of
 * concurrent collaborators makes a collision rare in practice, not structural.
 *
 * ## Presence lifetime
 *
 * `PRESENCE_ACTIVE_WINDOW_MS` is what "present" means for the participant list and for whether a
 * remote cursor draws at all: a connected socket alone is not enough (the 30-second heartbeat
 * above would otherwise make a tab left open overnight look like a live participant forever), so
 * this module additionally requires `lastActiveAt` to be recent. `PRESENCE_TYPING_GLOW_MS` is a
 * shorter, separate window: within it, the caret's name label shows without needing a hover, per
 * the owner's decision ("a thin coloured caret, with the writer's name on hover or briefly when
 * they start typing" -- not a persistent label, which would compete with the manuscript on a fixed
 * 12pt Courier grid and move on every keystroke).
 *
 * ## A second surface: the title page
 *
 * `apps/web/src/titlePageCursors.ts` reuses several of this module's exports wholesale rather than
 * building a parallel colour/name/expiry mechanism for the title page's own remote cursors: the
 * title page is a set of bare `contentEditable` divs, not a ProseMirror document, so it has no
 * `yCursorPlugin`/decoration surface to bind to (`createRemotePresenceExtension` below is
 * unavoidably ProseMirror-specific), but `isRecentlyActive`, `createGlowController`,
 * `buildRemoteCursorWidget`, `markPresenceActive`, and the two duration constants above are all
 * surface-agnostic -- they read and write plain `Awareness` state and plain DOM, never anything
 * ProseMirror-specific -- so they are exported for that reuse instead of being reimplemented a
 * second time for one more kind of cursor.
 */
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { yCursorPlugin, ySyncPluginKey } from 'y-prosemirror';
import type { Awareness } from 'y-protocols/awareness';

/** How long a connected participant may go without real activity before this module stops
 * treating them as present -- excluded from the participant list, and their cursor stops drawing.
 * See this module's own top-of-file comment for why a connected socket alone is not "present". */
export const PRESENCE_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** How long after real activity a remote cursor's name label shows without a hover. See
 * `createGlowController`'s own comment for why this has to be enforced by a direct per-node
 * timer, not by asking the decoration layer to redraw. */
export const PRESENCE_TYPING_GLOW_MS = 2_000;

/** The shape `user` carries once `apps/collab`'s `beforeHandleAwareness` has sanitized it -- see
 * this module's own top-of-file comment. Optional throughout: a state this module has not yet
 * seen a sanitized update for (or one from a non-conforming peer, defensively) supplies none of
 * it, and every reader here treats an absent field as "unknown", never as a crash. */
export type PresenceUser = {
  readonly name?: string;
  readonly color?: string;
  readonly lastActiveAt?: number;
};

export type RemoteParticipant = {
  readonly clientId: number;
  readonly name: string;
  readonly color: string;
};

const FALLBACK_COLOR = '#6b7280';
const FALLBACK_NAME = 'A collaborator';

/** Whether `lastActiveAt` (possibly absent, possibly a client's honest self-report -- this is a
 * display-only signal, not a security boundary; see the module comment on why the server does not
 * re-stamp it) falls inside `windowMs` of `now`. Missing or non-finite is never "active": a peer
 * this module has not sanitized `user` from yet must not flash into the participant list only to
 * vanish once its own value arrives.
 *
 * Exported for `apps/web/src/titlePageCursors.ts`'s reuse -- see this module's own top-of-file
 * comment on why the title page's remote cursors read the identical "present"/"active" windows
 * rather than defining their own. */
export function isRecentlyActive(
  lastActiveAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  return (
    typeof lastActiveAt === 'number' &&
    Number.isFinite(lastActiveAt) &&
    now - lastActiveAt <= windowMs
  );
}

/**
 * Every other participant this browser currently considers present -- excludes this client's own
 * state (`awareness.clientID`, the same identity y-prosemirror's own default cursor filter
 * compares against) and anyone whose `lastActiveAt` has aged out of `PRESENCE_ACTIVE_WINDOW_MS`.
 * Deliberately independent of whether a cursor position exists: a participant who clicked outside
 * the editor still has focus lost, clearing `cursor` (`yCursorPlugin`'s own `focusout` handler),
 * but is still there, still worth showing in the list -- the cursor and the participant list are
 * two different questions about the same awareness state, not one gating the other.
 */
export function listPresentParticipants(
  awareness: Awareness,
  now: number = Date.now(),
): RemoteParticipant[] {
  const participants: RemoteParticipant[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const user = (state as { user?: PresenceUser }).user;
    if (!user || !isRecentlyActive(user.lastActiveAt, now, PRESENCE_ACTIVE_WINDOW_MS)) return;
    participants.push({
      clientId,
      name: user.name ?? FALLBACK_NAME,
      color: user.color ?? FALLBACK_COLOR,
    });
  });
  // Stable order: `Map` iteration is insertion order, which is connection order, not name order
  // -- sorting keeps the list from visibly reshuffling as unrelated awareness fields update.
  return participants.sort((a, b) => a.clientId - b.clientId);
}

/**
 * y-prosemirror's own awareness-state filter (`defaultAwarenessStateFilter`), narrowed by the
 * active-activity window above. `currentClientId`/`userClientId` are the two client ids
 * `createDecorations` (y-prosemirror, `cursor-plugin.js`) already compares for "is this someone
 * else" -- `currentClientId` is `y.clientID`, the *document's* own client id, which is the same
 * number `Awareness` is constructed against (`new Awareness(doc)` sets `this.clientID =
 * doc.clientID`), so this agrees with `listPresentParticipants`'s own self-check without needing
 * the `Awareness` instance passed in here too.
 */
function activeAwarenessStateFilter(
  currentClientId: number,
  userClientId: number,
  state: { user?: PresenceUser },
): boolean {
  return (
    currentClientId !== userClientId &&
    isRecentlyActive(state.user?.lastActiveAt, Date.now(), PRESENCE_ACTIVE_WINDOW_MS)
  );
}

/**
 * The remote caret's DOM. This is a `Decoration.widget` (y-prosemirror's own `createDecorations`
 * inserts it via `Decoration.widget(head, createCursor, ...)`), which means the returned element
 * is spliced directly into the manuscript's own DOM, inline, at the writer's live text position --
 * exactly the class of thing `progress/collaboration-slice-2.md` and this codebase's own history
 * (the seam caret, the page-break widgets, `smarttype-ghost` -- see `styles.css`'s `.smarttype-
 * ghost` rule for the identical technique) treat as load-bearing, not cosmetic. The single
 * property that makes it safe is CSS, not this function: `.remote-cursor` is `position: absolute`
 * with no `top`/`left` of its own (`styles.css`), which paints at exactly the position this inline
 * insertion would have had while being completely removed from layout -- it cannot widen a line,
 * wrap a line, or grow `.script-body`'s content-sized height, regardless of how much text the name
 * label inside it holds. `page-rendering-persistence.spec.ts`'s `measurePage` -- reused, not
 * reinvented, by the new `presence-persistence.spec.ts` -- measures this claim in a real browser
 * rather than trusting the CSS rule to keep working.
 *
 * "Displaces nothing" and "is visible" are two different claims, and a real-browser check found
 * this codebase's first version proved only the first one: `.remote-cursor-caret`'s own painted
 * width had collapsed to zero (a `box-sizing` interaction with this app's own global `border-box`
 * default and the element's padding -- see that rule's own comment in `styles.css`), while still
 * satisfying "attached, correctly positioned, displaces no line" perfectly. `presence-persistence
 * .spec.ts` now also measures the caret's actual painted area and colour, not only its geometry.
 *

 * `data-remote-cursor-active` distinguishes the two visibility states styles.css hooks: `:hover`
 * always reveals the label (a writer curious who this is can always find out); a JS-set attribute
 * additionally reveals it, unprompted, for `PRESENCE_TYPING_GLOW_MS` after activity, per the
 * owner's decision. Set here from `user.lastActiveAt` at the moment this element is constructed --
 * correct for that one moment, but this function has no way to *un*-set it later, and, as
 * `createGlowController` below exists specifically to handle, nothing else ever calls this
 * function again for the same peer's connection either. That decay is `createGlowController`'s
 * job, applied to the exact element this function returns; this function's own responsibility
 * stops at getting the starting state right.
 */
export function buildRemoteCursorWidget(user: PresenceUser): HTMLElement {
  const name = user.name ?? FALLBACK_NAME;
  const color = user.color ?? FALLBACK_COLOR;
  const wrapper = document.createElement('span');
  wrapper.className = 'remote-cursor';
  wrapper.contentEditable = 'false';
  wrapper.setAttribute('aria-hidden', 'true');
  if (isRecentlyActive(user.lastActiveAt, Date.now(), PRESENCE_TYPING_GLOW_MS)) {
    wrapper.setAttribute('data-remote-cursor-active', 'true');
  }

  const caret = document.createElement('span');
  caret.className = 'remote-cursor-caret';
  caret.style.backgroundColor = color;
  wrapper.append(caret);

  const label = document.createElement('span');
  label.className = 'remote-cursor-label';
  label.style.backgroundColor = color;
  label.textContent = name;
  wrapper.append(label);

  return wrapper;
}

/**
 * y-prosemirror also always builds a `Decoration.inline` across the remote selection alongside the
 * caret (`createDecorations`, unconditionally whenever `aw.cursor != null`). The owner's decision
 * was narrower than that -- "a thin coloured caret", not a highlighted selection range -- so this
 * supplies no attributes at all, making that decoration exist (satisfying y-prosemirror's own
 * control flow, which this module reuses rather than forking) without rendering anything.
 */
function noRemoteSelectionAttrs(): Record<string, never> {
  return {};
}

/**
 * Refreshes this browser's own `lastActiveAt` to now -- the one write both the body's
 * `presenceHeartbeatPlugin` (below) and the title page's own local-cursor tracking
 * (`apps/web/src/titlePageCursors.ts`) need to make on real, locally-originated activity. Kept as
 * one exported function, not duplicated per surface, so "what counts as marking a writer active"
 * has exactly one implementation regardless of which part of the document they are typing in.
 */
export function markPresenceActive(awareness: Awareness): void {
  const current = (awareness.getLocalState() as { user?: PresenceUser } | null)?.user;
  awareness.setLocalStateField('user', { ...current, lastActiveAt: Date.now() });
}

/**
 * The heartbeat: refreshes this browser's own `lastActiveAt` on real, locally-originated activity
 * (a keystroke, a click that moves the caret) -- never on a remote peer's edit merging in locally,
 * which also changes `view.state` but must not count as *this* writer's own activity.
 *
 * `ySyncPluginKey.getState(view.state)?.isChangeOrigin` is how `y-prosemirror` itself tells the two
 * apart internally (`sync-plugin.js`'s own `apply`, and `cursor-plugin.js`'s `createDecorations`
 * reads the identical field for the identical reason): a transaction the *local* Yjs binding
 * produced while applying a remote update carries `isChangeOrigin: true` on the plugin's own
 * persisted state, while an ordinary local keystroke or caret move -- before `ySyncPlugin`'s own
 * `appendTransaction` has converted it into a Yjs update -- does not. Reusing that exact field
 * rather than re-deriving "was this local" some other way keeps this module in agreement with the
 * library it wraps by construction, not by a second, possibly-drifting implementation.
 *
 * Also owns `glow`'s teardown (`createGlowController`, below): both are per-editor-instance
 * lifecycle state with nothing to do with decorations or applied-transaction bookkeeping, so one
 * plain `Plugin` with only a `view` -- the same shape `SeamCaretExtension`'s own resize listener
 * uses -- covers both rather than adding a second plugin whose only job would be a `destroy()`.
 */
function presenceHeartbeatPlugin(
  awareness: Awareness,
  glow: Pick<ReturnType<typeof createGlowController>, 'destroy'>,
): Plugin {
  return new Plugin({
    view(editorView: EditorView) {
      // Present the instant this tab connects, before any keystroke -- see the module comment
      // on why "present" must not require having already typed.
      markPresenceActive(awareness);

      let previousState = editorView.state;
      const update = (view: EditorView) => {
        const next = view.state;
        const changedLocally =
          (!next.doc.eq(previousState.doc) || !next.selection.eq(previousState.selection)) &&
          !ySyncPluginKey.getState(next)?.isChangeOrigin;
        previousState = next;
        if (changedLocally) markPresenceActive(awareness);
      };

      return {
        update,
        destroy() {
          glow.destroy();
        },
      };
    },
  });
}

/**
 * Owns the one thing `buildRemoteCursorWidget` cannot: taking `data-remote-cursor-active` away
 * again once `PRESENCE_TYPING_GLOW_MS` has passed, and putting it back if the same peer becomes
 * active again later.
 *
 * This exists because asking the decoration layer to redraw -- what an earlier version of this
 * module did, on a 500ms interval -- does not work, confirmed directly rather than assumed: read
 * from the installed `prosemirror-view` source, `Decoration.widget`'s own `key` option (which
 * y-prosemirror's unmodified `createDecorations` sets to the peer's Yjs client id) makes
 * `WidgetViewDesc.matchesWidget` report two widgets with the same key as identical *without
 * calling the widget's `toDOM` factory again* -- so `buildRemoteCursorWidget` is only ever invoked
 * once per peer per connection, no matter how often (or via what mechanism) the surrounding
 * decoration set is recomputed. A live, two-browser-context check confirmed this concretely: a
 * peer's cursor element, tagged with a unique marker the instant it first showed the glow, was
 * still the *identical* DOM node -- and the attribute was still set -- more than 4 seconds later,
 * and remained the same node through a second, later burst of that peer's own typing. The
 * decoration's *position* still updates correctly on every redraw (that is a property of the
 * decoration object, applied to the reused node at render time, independent of whether the node
 * itself was rebuilt) -- only attributes baked in at construction, like this one, are frozen.
 *
 * A CSS-only decay (an `animation` that plays once and settles at `opacity: 0`, so no further JS
 * involvement is needed) was considered and rejected for the identical reason: it would play back
 * exactly once, at the widget's one-and-only construction, and could never replay for that peer's
 * later activity -- correct for "stuck on" but wrong for "never glows again after the first time",
 * the mirror-image defect this module's own earlier design also had (confirmed by the same live
 * check: a second burst of typing left the node, and therefore any one-shot animation on it,
 * completely unaffected).
 *
 * Direct DOM mutation, scheduled per node, is what is left once decoration-driven redraws are
 * ruled out -- and it is materially *cheaper* than the interval it replaces: no transaction
 * dispatch, no decoration recompute, just a `Map` lookup and a `setAttribute`/`removeAttribute`
 * call, and it only ever runs in response to a real awareness change (this peer's own periodic
 * keep-alive included) or a precisely-timed expiry, never on a fixed polling cadence.
 *
 * Exported so `apps/web/src/titlePageCursors.ts` can run a second, independent instance of this
 * same controller against the same `Awareness`, scoped to the title page's own cursor widgets --
 * see this module's top-of-file comment. Two instances never interfere: each tracks only the
 * `clientId -> HTMLElement` pairs it was itself `register`ed with, so the body's own instance
 * (inside `createRemotePresenceExtension`, below) and the title page's are simply two independent
 * listeners on the same `awareness.on('change', ...)` event, each blind to the other's nodes.
 */
export function createGlowController(awareness: Awareness) {
  const nodes = new Map<number, HTMLElement>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function clearScheduled(clientId: number): void {
    const timer = timers.get(clientId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(clientId);
    }
  }

  /** Arranges for the attribute to be removed at the moment it is due (or removes it immediately
   * if that moment has already passed) -- never *sets* it: the caller already knows, and has
   * already applied, whichever starting state is correct for right now. */
  function scheduleExpiry(
    clientId: number,
    element: HTMLElement,
    lastActiveAt: number | undefined,
  ): void {
    clearScheduled(clientId);
    const now = Date.now();
    if (!isRecentlyActive(lastActiveAt, now, PRESENCE_TYPING_GLOW_MS)) return;
    const remaining = Math.max((lastActiveAt as number) + PRESENCE_TYPING_GLOW_MS - now, 0);
    timers.set(
      clientId,
      setTimeout(() => {
        element.removeAttribute('data-remote-cursor-active');
        timers.delete(clientId);
      }, remaining),
    );
  }

  /** Called once, immediately after `buildRemoteCursorWidget` constructs a peer's element --
   * registers it so a *later* awareness change (the only path left, per this function's own
   * comment) can still reach it, and schedules the one expiry this construction's own starting
   * state implies. */
  function register(
    clientId: number,
    element: HTMLElement,
    lastActiveAt: number | undefined,
  ): void {
    nodes.set(clientId, element);
    scheduleExpiry(clientId, element, lastActiveAt);
  }

  function forget(clientId: number): void {
    clearScheduled(clientId);
    nodes.delete(clientId);
  }

  // The only place a peer's *later* activity can ever reach an already-built widget -- see this
  // function's own top comment. `removed` (a real disconnect, or y-protocols' own outdated-client
  // sweep) stops tracking a node this module will never hear from again, rather than leaking its
  // entry and a possibly-still-pending timer.
  const onAwarenessChange = ({
    removed,
  }: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    for (const clientId of removed) forget(clientId);
    awareness.getStates().forEach((state, clientId) => {
      const element = nodes.get(clientId);
      if (!element) return;
      const lastActiveAt = (state as { user?: PresenceUser }).user?.lastActiveAt;
      if (isRecentlyActive(lastActiveAt, Date.now(), PRESENCE_TYPING_GLOW_MS)) {
        element.setAttribute('data-remote-cursor-active', 'true');
      }
      scheduleExpiry(clientId, element, lastActiveAt);
    });
  };
  awareness.on('change', onAwarenessChange);

  return {
    register,
    // Exposed (unlike before this slice, when it was only ever called internally for a real
    // `removed` disconnect) for `apps/web/src/titlePageCursors.ts`'s own case: a peer who is still
    // connected but no longer has an active title-page cursor (they moved to the manuscript body,
    // or clicked outside the title page entirely) is not a `removed` awareness client id at all --
    // the caller has to be able to say "stop tracking this one" without a disconnect ever
    // happening, or its pending expiry timer would otherwise leak for the life of the connection.
    forget,
    destroy(): void {
      awareness.off('change', onAwarenessChange);
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      nodes.clear();
    },
  };
}

/**
 * The whole of remote presence rendering, as one Tiptap extension: y-prosemirror's own
 * `yCursorPlugin` (correctness-critical relative-position tracking and decoration lifecycle,
 * reused rather than reimplemented -- see this module's top-of-file comment) configured with the
 * geometry-safe builders above, plus the heartbeat plugin that keeps `lastActiveAt` honest.
 *
 * Registered by `App.tsx` only when a real `HocuspocusProvider`'s `awareness` exists -- there is
 * nothing for this extension to do against a local, unconnected `Y.Doc` with no other participant
 * who could ever appear in it, and every existing editor test that builds a bare editor (no
 * collaboration server configured) continues to build one with no presence layer, unaffected.
 */
export function createRemotePresenceExtension(awareness: Awareness) {
  return Extension.create({
    addProseMirrorPlugins() {
      // Scoped to this one extension instance (matches `SeamCaretExtension`'s own
      // `pendingKeyMotion` convention) so two open editors -- or two editors across tests -- never
      // share a glow controller.
      const glow = createGlowController(awareness);
      return [
        yCursorPlugin(awareness, {
          awarenessStateFilter: activeAwarenessStateFilter,
          cursorBuilder: (user: PresenceUser, clientId: number) => {
            const element = buildRemoteCursorWidget(user);
            glow.register(clientId, element, user.lastActiveAt);
            return element;
          },
          selectionBuilder: noRemoteSelectionAttrs,
        }),
        presenceHeartbeatPlugin(awareness, glow),
      ];
    },
    name: 'remotePresence',
  });
}

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { PRESENCE_ACTIVE_WINDOW_MS } from '@finaler-draft/screenplay-editor';
import { ParticipantIndicator } from './ParticipantIndicator.js';

function otherAwareness(): Awareness {
  // A second `Y.Doc`/`Awareness` pair, not the one under test: `listPresentParticipants`
  // (`@finaler-draft/screenplay-editor`) excludes its own client id, so a state has to originate
  // from a genuinely different `Awareness` instance to read as "someone else" -- the same
  // constraint `presence.test.ts` documents for the identical reason.
  return new Awareness(new Y.Doc());
}

describe('ParticipantIndicator', () => {
  it('renders nothing with no awareness at all -- local, unconnected mode', () => {
    render(<ParticipantIndicator awareness={undefined} />);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('renders nothing when connected but alone', () => {
    render(<ParticipantIndicator awareness={new Awareness(new Y.Doc())} />);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('shows a coloured initial for a present peer, and updates live as awareness changes', async () => {
    const awareness = new Awareness(new Y.Doc());
    render(<ParticipantIndicator awareness={awareness} />);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();

    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Mara Quinn', color: '#2563eb', lastActiveAt: Date.now() },
    });
    awareness.emit('change', [{ added: [peer.clientID], updated: [], removed: [] }, 'local']);

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Also here: Mara Quinn' })).toBeVisible();
    });
    expect(screen.getByText('M')).toBeVisible();
  });

  it('never shows a participant who has aged out of the active window', async () => {
    const awareness = new Awareness(new Y.Doc());
    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: {
        name: 'Stale Peer',
        color: '#000',
        lastActiveAt: Date.now() - PRESENCE_ACTIVE_WINDOW_MS - 1,
      },
    });
    render(<ParticipantIndicator awareness={awareness} />);
    // No `awareness.emit` needed here -- the initial render's own effect already reads the
    // pre-seeded (already stale) state.
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('lists more than one present participant, each with its own initial', async () => {
    const awareness = new Awareness(new Y.Doc());
    const peerA = otherAwareness();
    const peerB = otherAwareness();
    awareness.states.set(peerA.clientID, {
      user: { name: 'Ava', color: '#2563eb', lastActiveAt: Date.now() },
    });
    awareness.states.set(peerB.clientID, {
      user: { name: 'Ben', color: '#16a34a', lastActiveAt: Date.now() },
    });
    render(<ParticipantIndicator awareness={awareness} />);
    awareness.emit('change', [
      { added: [peerA.clientID, peerB.clientID], updated: [], removed: [] },
      'local',
    ]);

    await waitFor(() => {
      expect(screen.getByText('A')).toBeVisible();
      expect(screen.getByText('B')).toBeVisible();
    });
  });

  it('stops listening when the awareness instance is swapped out from under it', async () => {
    const awareness = new Awareness(new Y.Doc());
    const { rerender } = render(<ParticipantIndicator awareness={awareness} />);
    rerender(<ParticipantIndicator awareness={undefined} />);

    // Emitting on the now-detached instance must reach no listener this component still owns --
    // a leaked subscription would otherwise keep updating state on an unmounted concern.
    const peer = otherAwareness();
    awareness.states.set(peer.clientID, {
      user: { name: 'Ghost', color: '#000', lastActiveAt: Date.now() },
    });
    awareness.emit('change', [{ added: [peer.clientID], updated: [], removed: [] }, 'local']);

    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });
});

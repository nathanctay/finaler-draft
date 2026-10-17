import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  apcaContrast,
  PARTICIPANT_LABEL_INK,
  PARTICIPANT_LABEL_MINIMUM_LC,
  PARTICIPANT_LABEL_PAPER,
  PRESENCE_ACTIVE_WINDOW_MS,
} from '@finaler-draft/screenplay-editor';
import { ParticipantIndicator } from './ParticipantIndicator.js';

/** An inline `color`/`background-color` comes back out of the DOM as `rgb(r, g, b)`; this returns
 * it to the hex form `apcaContrast` reads. Throws rather than guessing, so a style that was never
 * set fails the test instead of silently measuring black. */
function toHexColor(value: string): string {
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u.exec(value.trim());
  if (!match) throw new Error(`Not an rgb() colour: ${value}`);
  return `#${match
    .slice(1, 4)
    .map((channel) => Number(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

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

  /*
   * The initial's own colour. `styles.css` used to declare `color: #fff` for `.participant-avatar`
   * beside the inline background this component sets from awareness data -- a contrast claim about
   * every colour the palette might ever hold, made where nothing could check it. Measured here
   * against the swatch the component actually painted, and compared with the alternative it
   * rejected, so the assertion is about the pair agreeing rather than about any one colour
   * resolving a particular way.
   *
   * Ranked and floored in APCA, the metric `participantLabelTextColor` decides in; contrast.ts
   * explains why, and `apps/collab/src/participantPalette.test.ts` records what that costs against
   * WCAG's 4.5:1 on three of these eight.
   */
  it.each(['#b85162', '#be865b', '#887306', '#015a1e', '#10a2a0', '#345fdf', '#af79e2', '#9e0067'])(
    'paints the initial in whichever of paper or ink reads better on %s',
    async (color) => {
      const awareness = new Awareness(new Y.Doc());
      const peer = otherAwareness();
      awareness.states.set(peer.clientID, {
        user: { name: 'Mara Quinn', color, lastActiveAt: Date.now() },
      });
      render(<ParticipantIndicator awareness={awareness} />);
      const initial = await waitFor(() => screen.getByText('M'));

      const background = toHexColor(initial.style.backgroundColor);
      const painted = toHexColor(initial.style.color);
      expect(background).toBe(color);
      expect([PARTICIPANT_LABEL_PAPER, PARTICIPANT_LABEL_INK]).toContain(painted);
      const rejected =
        painted === PARTICIPANT_LABEL_PAPER ? PARTICIPANT_LABEL_INK : PARTICIPANT_LABEL_PAPER;
      expect(Math.abs(apcaContrast(painted, background))).toBeGreaterThanOrEqual(
        Math.abs(apcaContrast(rejected, background)),
      );
      expect(Math.abs(apcaContrast(painted, background))).toBeGreaterThanOrEqual(
        PARTICIPANT_LABEL_MINIMUM_LC,
      );
    },
  );

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

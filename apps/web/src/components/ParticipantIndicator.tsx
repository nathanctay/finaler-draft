/**
 * The status bar's participant list (slice 2's "a participant indicator" --
 * progress/collaboration-slice-2.md). Shows every *other* connected, recently active writer as a
 * small coloured initial, reusing `listPresentParticipants`'s own definition of "present"
 * (`packages/screenplay-editor/src/presence.ts`) rather than a second one: a connected socket
 * alone is not enough -- see that module's own comment on why a tab left open overnight must not
 * linger here.
 *
 * Deliberately independent of the remote-cursor caret (`presence.ts`'s `createRemotePresenceExtension`):
 * this reads the same `Awareness` instance directly, not through the editor or its plugins, so it
 * renders correctly even before the editor has mounted (`syncState === 'connecting'`) and even for
 * a participant who has no live cursor right now (clicked outside the editor, or is on a device
 * that never focused it).
 */
import { useEffect, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { listPresentParticipants, type RemoteParticipant } from '@finaler-draft/screenplay-editor';

/** How often this polls for a participant aging out of the active window with no awareness event
 * of its own to trigger a re-render -- matches the recheck cadence `presence.ts`'s own typing-glow
 * interval uses, for the same reason: staleness is a function of wall-clock time, not an event. */
const PRESENCE_LIST_RECHECK_INTERVAL_MS = 5_000;

function useParticipants(awareness: Awareness | undefined): readonly RemoteParticipant[] {
  const [participants, setParticipants] = useState<readonly RemoteParticipant[]>([]);

  useEffect(() => {
    if (!awareness) {
      setParticipants([]);
      return;
    }
    const refresh = () => setParticipants(listPresentParticipants(awareness));
    refresh();
    awareness.on('change', refresh);
    const interval = setInterval(refresh, PRESENCE_LIST_RECHECK_INTERVAL_MS);
    return () => {
      awareness.off('change', refresh);
      clearInterval(interval);
    };
  }, [awareness]);

  return participants;
}

/** One coloured initial. `title` (a native tooltip) carries the full name -- the same "hover to
 * find out who this is" affordance the remote-cursor caret's own label offers, kept consistent
 * rather than inventing a second disclosure pattern for the identical information. */
function ParticipantAvatar({ participant }: { participant: RemoteParticipant }) {
  const initial = participant.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden="true"
      className="participant-avatar"
      style={{ backgroundColor: participant.color }}
      title={participant.name}
    >
      {initial}
    </span>
  );
}

export function ParticipantIndicator({ awareness }: { awareness: Awareness | undefined }) {
  const participants = useParticipants(awareness);
  if (participants.length === 0) return null;

  const names = participants.map((participant) => participant.name).join(', ');
  return (
    <span
      aria-label={`Also here: ${names}`}
      className="participant-indicator"
      // A live region would announce every join/leave as it happens -- too chatty for a fact this
      // unobtrusive; the aria-label above is enough for a screen reader user who tabs to it.
      role="group"
    >
      {participants.map((participant) => (
        <ParticipantAvatar key={participant.clientId} participant={participant} />
      ))}
    </span>
  );
}

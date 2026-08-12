import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';

/**
 * The inline "Deleted — Undo" affordance plan.md specifies in place of a confirmation dialog.
 * Shared by the writing desk's project rows and a project's screenplay rows -- both need the
 * identical shape (an announced status message plus a keyboard-reachable Undo), differing only
 * in which restore endpoint `restore` calls.
 *
 * `role="status"` (implicit `aria-live="polite"`) on the message is the same pattern already
 * used for `.sign-out-error`'s `role="alert"` in projects/index.tsx: a freshly mounted live
 * region carrying its final text, not a region whose text changes after mount. "Deleted" is
 * status, not an error, so `status` rather than `alert` is the correct role here.
 *
 * Two accessibility properties that are easy to get right in isolation and wrong in composition:
 *
 * - The Undo button's accessible name includes `title`, not a bare "Undo" repeated on every row
 *   -- if two rows are simultaneously in this state, a screen reader user needs to tell them
 *   apart by name, not by adjacent visual text they may not be reading linearly.
 * - This component moves focus to its own Undo button on mount. Without this, a keyboard-driven
 *   delete leaves focus nowhere: the OverflowMenu's focused "Delete" menuitem unmounts when the
 *   menu closes, then the row's trigger unmounts when it is replaced by this component, and
 *   nothing else claims focus -- it silently falls back to the document body, ending the
 *   keyboard workflow the scope specifically required stay reachable. Firing unconditionally
 *   (not only for keyboard-initiated deletes) matches the same "toast with undo" convention this
 *   affordance is modeled on and is simpler than tracking input modality; a mouse user briefly
 *   seeing a focus ring here is a minor cost against silently losing focus for a keyboard user.
 */
export function DeletedRow({
  onRestored,
  restore,
  title,
}: {
  onRestored: () => void;
  restore: () => Promise<unknown>;
  title: string;
}) {
  const undoRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    undoRef.current?.focus();
  }, []);
  const restoreMutation = useMutation({ mutationFn: restore, onSuccess: onRestored });
  return (
    <div className="deleted-row">
      <p className="deleted-row-message" role="status">
        {`${title} — Deleted`}
      </p>
      <button
        aria-label={`Undo delete of ${title}`}
        className="text-button"
        disabled={restoreMutation.isPending}
        onClick={() => restoreMutation.mutate()}
        ref={undoRef}
        type="button"
      >
        {restoreMutation.isPending ? 'Restoring…' : 'Undo'}
      </button>
      {restoreMutation.isError && (
        <p className="field-error" role="alert">
          Restore failed. Try again.
        </p>
      )}
    </div>
  );
}

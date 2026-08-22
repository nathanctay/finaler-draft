/**
 * The application's first toast. It exists because the status bar could not hold this message:
 * an export failure names a block and an element, which is far more text than a bar that also
 * carries the save state, the word count and the page count, and which collapses to 30px and
 * hides `.status-center` entirely below 600px (`styles.css`).
 *
 * Deliberately built from this product's own surfaces rather than a component-library toast, per
 * plan.md's design rules: "square or subtly rounded rectangles, clear borders, purposeful
 * separators, and compact controls", "one functional accent color", "do not use ... excessive
 * floating shadows, or generic component-library styling", and "do not adopt an unmodified
 * Tailwind/shadcn visual language". It therefore reuses `.dialog`'s exact border token, corner
 * radius and surface -- the only other floating panel in the product -- so the two read as the
 * same system seen twice, and takes its accent from the same `--feedback-error` the save-dot and
 * status-attention text already use.
 *
 * Errors do not auto-dismiss. A message that names the thing a writer has to go and fix is not
 * something to take away on a timer; it stays until dismissed or superseded.
 */
export function Toast({
  message,
  onDismiss,
  title,
}: {
  message: string;
  onDismiss: () => void;
  title: string;
}) {
  return (
    // `role="alert"` carries an implicit assertive live region, so the message is announced when
    // it appears without the writer having to be looking at the corner it appears in.
    <div className="toast" role="alert">
      <div className="toast-body">
        <p className="toast-title">{title}</p>
        <p className="toast-message">{message}</p>
      </div>
      <button
        aria-label={`Dismiss: ${title}`}
        className="toast-dismiss"
        onClick={onDismiss}
        type="button"
      >
        ×
      </button>
    </div>
  );
}

import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, type BillingPlan } from './api.js';
import { redirectToExternalUrl } from './externalRedirect.js';

/**
 * The upgrade entry point (plan.md's Checkout Session purchase path). Reached from two places:
 * the account menu's "Upgrade to Pro" item (routes/projects/index.tsx, always available to a
 * restricted account) and the free-tier limit prompt a writer hits trying to create a second
 * screenplay (routes/projects/$projectId/index.tsx, where `message` carries the server's own
 * explanation of what just happened).
 *
 * Choosing a plan starts a Checkout Session and redirects the whole tab to Stripe's hosted page --
 * this component never itself grants anything (plan.md: entitlement comes only from the webhook),
 * it only gets the writer to the page where they can pay. There is no in-app confirmation step
 * because there is nothing yet to confirm; `/billing/success` (routes/billing/success.tsx) is
 * where the writer lands afterward.
 *
 * A plain, hand-built modal, matching documentSettingsDialog.tsx's own top-of-file reasoning: this
 * codebase's test environment (jsdom) does not implement `HTMLDialogElement.showModal`, and
 * OverflowMenu.tsx/documentSettingsDialog.tsx already establish the pattern this follows rather
 * than inventing a second one. Escape closes and returns focus to the trigger (the caller's own
 * `onClose`, same convention as documentSettingsDialog.tsx); Tab/Shift+Tab cycle within the
 * dialog's own focusable controls.
 */
export function UpgradeDialog({
  message,
  onClose,
}: {
  message?: string | undefined;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const checkout = useMutation({
    mutationFn: (plan: BillingPlan) => api.createCheckoutSession(plan),
    onSuccess: (result) => redirectToExternalUrl(result.url),
  });

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  function focusableElements(): HTMLElement[] {
    return Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [],
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const elements = focusableElements();
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first || !last) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-overlay">
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="dialog upgrade-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id={headingId}>Upgrade to Finaler Draft Pro</h2>
        {message && <p>{message}</p>}
        <p>
          A Pro subscription lifts the one-screenplay limit: create and edit as many screenplays as
          you like.
        </p>
        <div className="dialog-actions upgrade-dialog-plans">
          <button
            className="primary-button"
            disabled={checkout.isPending}
            onClick={() => checkout.mutate('monthly')}
            type="button"
          >
            Upgrade monthly
          </button>
          <button
            className="primary-button"
            disabled={checkout.isPending}
            onClick={() => checkout.mutate('annual')}
            type="button"
          >
            Upgrade annually
          </button>
        </div>
        {checkout.isError && (
          <p className="field-error" role="alert">
            Could not start checkout. Try again.
          </p>
        )}
        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

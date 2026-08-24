import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { GENERIC_AUTH_ERROR_MESSAGE, api } from '../api.js';

export const Route = createFileRoute('/forgot-password')({ component: ForgotPasswordPage });

/**
 * Better Auth's own `/request-password-reset` route always answers with this same generic
 * message, regardless of whether `email` is registered (installed `api/routes/password.mjs`) --
 * a deliberate anti-enumeration property of the account-recovery path plan.md requires, not
 * something this page may narrow by branching on the response. Every submission, valid address or
 * not, renders this same sentence; `api.requestPasswordReset`'s own comment covers the same point
 * from the request side.
 */
const CONFIRMATION_MESSAGE =
  'If an account exists for that email address, check your inbox for a link to reset your password.';

function ForgotPasswordPage() {
  const emailId = useId();
  const [email, setEmail] = useState('');
  // Driven by `onSuccess` rather than `request.isSuccess` -- the same pattern sign-in.tsx's
  // `awaitingVerification` uses -- so this page works with the same mutation-mock shape every
  // other route test in this codebase already relies on (`routeHarness.tsx`'s `useMutation`
  // triggers `onSuccess`; it does not track a query-library-shaped `isSuccess` flag).
  const [submitted, setSubmitted] = useState(false);

  const request = useMutation({
    mutationFn: () => api.requestPasswordReset(email),
    onSuccess: () => setSubmitted(true),
  });

  return (
    <main className="entry-screen">
      <section className="entry-card" aria-labelledby="entry-title">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
        <p className="eyebrow">ACCOUNT RECOVERY</p>
        <h1 id="entry-title">Reset your password.</h1>
        {submitted ? (
          <p role="status">{CONFIRMATION_MESSAGE}</p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              request.mutate();
            }}
          >
            <div className="entry-field">
              <label htmlFor={emailId}>Email</label>
              <input
                autoComplete="email"
                id={emailId}
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <button className="primary-button" disabled={request.isPending} type="submit">
              {request.isPending ? 'Working…' : 'Send reset link'}
            </button>
          </form>
        )}
        {request.isError && (
          <p className="field-error" role="alert">
            {GENERIC_AUTH_ERROR_MESSAGE}
          </p>
        )}
        <Link className="text-button" to="/sign-in">
          Back to sign in
        </Link>
      </section>
    </main>
  );
}

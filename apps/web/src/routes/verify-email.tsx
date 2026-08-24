import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/verify-email')({ component: VerifyEmailPage });

/**
 * The landing page the verification link redirects to (`signUp`'s `callbackURL` in api.ts) once
 * Better Auth has already verified the token server-side -- this page never calls the API itself,
 * it only reports what already happened. An expired or otherwise invalid token redirects here too,
 * with `?error=...` appended instead of the account actually being verified (installed
 * `api/routes/email-verification.mjs`'s `redirectOnError`), which is the one case this branches
 * on. `sendOnSignIn` (auth.ts) means the honest recovery path for that case is simply signing in
 * again -- Better Auth sends a fresh link on that same rejected attempt -- so this page points
 * there rather than duplicating a "resend" affordance that was deliberately left out of this
 * slice's UI surface.
 */
function VerifyEmailPage() {
  const [failed] = useState(() => new URLSearchParams(window.location.search).has('error'));

  return (
    <main className="entry-screen">
      <section className="entry-card" aria-labelledby="entry-title">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
        {failed ? (
          <>
            <h1 id="entry-title">This link is invalid or has expired.</h1>
            <p role="alert">Sign in and we will send you a new one.</p>
          </>
        ) : (
          <>
            <h1 id="entry-title">Email verified.</h1>
            <p role="status">Your email address is verified. Sign in to get back to work.</p>
          </>
        )}
        <Link className="primary-button" to="/sign-in">
          Sign in
        </Link>
      </section>
    </main>
  );
}

import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { PASSWORD_MIN_LENGTH, PASSWORD_REQUIREMENTS_MESSAGE } from '@finaler-draft/config';
import { AuthApiError, GENERIC_AUTH_ERROR_MESSAGE, api } from '../api.js';

export const Route = createFileRoute('/reset-password')({ component: ResetPasswordPage });

function ResetPasswordPage() {
  const passwordId = useId();
  const [password, setPassword] = useState('');
  // The route this page is reached by (`requestPasswordReset`'s `redirectTo`, in api.ts) is the
  // GET Better Auth's own `/reset-password/:token` callback redirects to once it has already
  // validated the token server-side, appending `?token=...` (installed `api/routes/password.mjs`)
  // -- so a valid visit always carries one. Read directly from `window.location.search` rather
  // than `Route.useSearch()`/`useSearch()`: this component is rendered under test (sign-in.test.tsx's
  // shared harness, and this file's own tests) without a `RouterProvider`, the same reason
  // `useParams`/`useNavigate` are shimmed there instead of used for real -- a hook that reads
  // router-managed search state has nothing to read from without one. This link is followed
  // exactly once, from an email client, never an in-app route transition that would need parsed
  // search state carried forward, so a provider-free read costs nothing real users would notice.
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token'));
  // Driven by `onSuccess` rather than `reset.isSuccess` -- see the matching comment in
  // forgot-password.tsx: the shared test harness's `useMutation` mock triggers `onSuccess`, not a
  // query-library-shaped `isSuccess` flag.
  const [done, setDone] = useState(false);
  // Declared unconditionally, ahead of the `!token` return below, per the rules of hooks -- even
  // though `mutate()` is only ever reachable from the form the other branch renders. The guard
  // inside is therefore defensive, not dead: it is what keeps this mutation from ever calling
  // `api.resetPassword` with a null token if that invariant is ever broken by a future change.
  const reset = useMutation({
    mutationFn: () => {
      if (!token) throw new Error('missing-token');
      return api.resetPassword(password, token);
    },
    onSuccess: () => setDone(true),
  });

  if (!token) {
    return (
      <main className="entry-screen">
        <section className="entry-card" aria-labelledby="entry-title">
          <div className="brand">
            <span className="brand-mark">F</span>
            <span>Finaler Draft</span>
          </div>
          <h1 id="entry-title">This link is invalid.</h1>
          <p role="alert">Request a new password reset link.</p>
          <Link className="primary-button" to="/forgot-password">
            Request a new link
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="entry-screen">
      <section className="entry-card" aria-labelledby="entry-title">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
        <p className="eyebrow">ACCOUNT RECOVERY</p>
        <h1 id="entry-title">Set a new password.</h1>
        {done ? (
          <>
            <p role="status">Your password has been reset.</p>
            <Link className="primary-button" to="/sign-in">
              Sign in
            </Link>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              reset.mutate();
            }}
          >
            <div className="entry-field">
              <label htmlFor={passwordId}>New password</label>
              <input
                aria-describedby={`${passwordId}-hint`}
                autoComplete="new-password"
                id={passwordId}
                minLength={PASSWORD_MIN_LENGTH}
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="field-hint" id={`${passwordId}-hint`}>
                {PASSWORD_REQUIREMENTS_MESSAGE}
              </p>
            </div>
            <button className="primary-button" disabled={reset.isPending} type="submit">
              {reset.isPending ? 'Working…' : 'Set new password'}
            </button>
          </form>
        )}
        {reset.isError && (
          <p className="field-error" role="alert">
            {reset.error instanceof AuthApiError
              ? reset.error.safeMessage
              : GENERIC_AUTH_ERROR_MESSAGE}
          </p>
        )}
      </section>
    </main>
  );
}

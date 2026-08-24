import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { PASSWORD_MIN_LENGTH, PASSWORD_REQUIREMENTS_MESSAGE } from '@finaler-draft/config';
import { AuthApiError, GENERIC_AUTH_ERROR_MESSAGE, api } from '../api.js';
import { guardSessionUser, sessionQueryOptions } from '../session.js';

export const Route = createFileRoute('/sign-in')({
  beforeLoad: async ({ context }) => {
    const user = await guardSessionUser(context.queryClient);
    if (user) throw redirect({ to: '/projects' });
  },
  component: SignInPage,
});

function EyeIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M1 8s2.7-5 7-5 7 5 7 5-2.7 5-7 5-7-5-7-5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M1 8s2.7-5 7-5c1.5 0 2.8.4 3.9 1.1M15 8s-1.1 2-3 3.4M8 11.2c-2.4 0-4.3-1.5-5.6-3.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3.2 3.2l9.6 9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function PasswordVisibilityToggle({
  label,
  pressed,
  onToggle,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button aria-pressed={pressed} className="password-toggle" onClick={onToggle} type="button">
      <span className="visually-hidden">{label}</span>
      {pressed ? <EyeIcon /> : <EyeOffIcon />}
    </button>
  );
}

function SignInPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const passwordRequirementsId = useId();
  const confirmPasswordId = useId();
  const confirmPasswordErrorId = useId();

  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  // Set once a sign-up succeeds without creating a session -- see the `onSuccess` branch below.
  // Never set by sign-in itself: an unverified account's sign-in attempt is a rejected mutation
  // (`EMAIL_NOT_VERIFIED`), not a success with no token, so it renders through the existing error
  // path instead.
  const [awaitingVerification, setAwaitingVerification] = useState(false);

  const authentication = useMutation({
    mutationFn: () =>
      mode === 'sign-in' ? api.signIn(email, password) : api.signUp(name, email, password),
    onSuccess: (result) => {
      // `requireEmailVerification` (auth.ts) means a fresh sign-up no longer creates a session --
      // Better Auth skips auto-sign-in for an unverified account -- so `token` comes back `null`
      // instead of a session cookie ever being set. Navigating to /projects here regardless would
      // send the visitor straight into the signed-out redirect that guards it, back to this same
      // page, having told them nothing about why. This is the one outcome sign-up can reach that
      // sign-in cannot (see the `token` comment on `api.signIn`), so it is safe to key off `mode`.
      if (mode === 'sign-up' && result.token === null) {
        setAwaitingVerification(true);
        return;
      }
      // A prior visit to this page may have cached a signed-out `null` under ['session'].
      // `ensureQueryData` returns cached data whenever an entry exists at all, even
      // `null`, so the /projects guard would otherwise see that stale answer and bounce
      // straight back here. Removing the entry, rather than just invalidating it, is what
      // forces the next `ensureQueryData` call to actually fetch the now-signed-in session.
      queryClient.removeQueries({ queryKey: sessionQueryOptions.queryKey });
      return navigate({ to: '/projects' });
    },
  });

  const passwordsMismatch = mode === 'sign-up' && password !== confirmPassword;
  const showMismatchError = passwordsMismatch && (confirmTouched || submitAttempted);

  function switchMode() {
    setMode((value) => (value === 'sign-in' ? 'sign-up' : 'sign-in'));
    setConfirmPassword('');
    setConfirmTouched(false);
    setSubmitAttempted(false);
    setAwaitingVerification(false);
    authentication.reset();
  }

  return (
    <main className="entry-screen">
      <section className="entry-card" aria-labelledby="entry-title">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
        {awaitingVerification ? (
          // Sign-up succeeded but created no session -- see the `onSuccess` comment above. This
          // replaces the form entirely rather than sitting alongside it: there is nothing left
          // for the visitor to submit until they have followed the link, and leaving the form
          // visible would invite a second, redundant sign-up attempt against the same address.
          <>
            <h1 id="entry-title">Check your email.</h1>
            <p role="status">
              We sent a verification link to {email}. Follow it to finish setting up your account,
              then sign in.
            </p>
            <button className="text-button" onClick={switchMode} type="button">
              I already have an account
            </button>
          </>
        ) : (
          <>
            <p className="eyebrow">WRITER WORKSPACE</p>
            <h1 id="entry-title">
              {mode === 'sign-in' ? 'Return to the work.' : 'Set up your writing desk.'}
            </h1>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (mode === 'sign-up') {
                  setSubmitAttempted(true);
                  if (passwordsMismatch) return;
                }
                authentication.mutate();
              }}
            >
              {mode === 'sign-up' && (
                <div className="entry-field">
                  <label htmlFor={nameId}>Name</label>
                  <input
                    autoComplete="name"
                    id={nameId}
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              )}
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
              <div className="entry-field">
                <label htmlFor={passwordId}>Password</label>
                <div className="password-field">
                  <input
                    aria-describedby={passwordRequirementsId}
                    autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                    id={passwordId}
                    minLength={PASSWORD_MIN_LENGTH}
                    required
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <PasswordVisibilityToggle
                    label="Show password"
                    onToggle={() => setShowPassword((value) => !value)}
                    pressed={showPassword}
                  />
                </div>
                {mode == 'sign-up' && (
                  <p className="field-hint" id={passwordRequirementsId}>
                    {PASSWORD_REQUIREMENTS_MESSAGE}
                  </p>
                )}
                {mode === 'sign-in' && (
                  <Link className="text-button" to="/forgot-password">
                    Forgot password?
                  </Link>
                )}
              </div>
              {mode === 'sign-up' && (
                <div className="entry-field">
                  <label htmlFor={confirmPasswordId}>Confirm password</label>
                  <div className="password-field">
                    <input
                      aria-describedby={showMismatchError ? confirmPasswordErrorId : undefined}
                      aria-invalid={showMismatchError}
                      autoComplete="new-password"
                      id={confirmPasswordId}
                      required
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value);
                        setConfirmTouched(true);
                      }}
                    />
                    <PasswordVisibilityToggle
                      label="Show confirm password"
                      onToggle={() => setShowConfirmPassword((value) => !value)}
                      pressed={showConfirmPassword}
                    />
                  </div>
                  {showMismatchError && (
                    <p className="field-error" id={confirmPasswordErrorId} role="alert">
                      Passwords do not match.
                    </p>
                  )}
                </div>
              )}
              <button className="primary-button" disabled={authentication.isPending} type="submit">
                {authentication.isPending
                  ? 'Working…'
                  : mode === 'sign-in'
                    ? 'Sign in'
                    : 'Create account'}
              </button>
            </form>
            {authentication.isError && (
              <p className="field-error" role="alert">
                {authentication.error instanceof AuthApiError
                  ? authentication.error.safeMessage
                  : GENERIC_AUTH_ERROR_MESSAGE}
              </p>
            )}
            <button className="text-button" onClick={switchMode} type="button">
              {mode === 'sign-in' ? 'Create an account' : 'I already have an account'}
            </button>
          </>
        )}
      </section>
    </main>
  );
}

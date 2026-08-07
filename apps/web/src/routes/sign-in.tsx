import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PASSWORD_MIN_LENGTH, PASSWORD_REQUIREMENTS_MESSAGE } from '@finaler-draft/config';
import { api } from '../api.js';

export const Route = createFileRoute('/sign-in')({ component: SignInPage });

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

  const authentication = useMutation({
    mutationFn: () =>
      mode === 'sign-in' ? api.signIn(email, password) : api.signUp(name, email, password),
    onSuccess: () => void navigate({ to: '/projects' }),
  });

  const passwordsMismatch = mode === 'sign-up' && password !== confirmPassword;
  const showMismatchError = passwordsMismatch && (confirmTouched || submitAttempted);

  function switchMode() {
    setMode((value) => (value === 'sign-in' ? 'sign-up' : 'sign-in'));
    setConfirmPassword('');
    setConfirmTouched(false);
    setSubmitAttempted(false);
  }

  return (
    <main className="entry-screen">
      <section className="entry-card" aria-labelledby="entry-title">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>Finaler Draft</span>
        </div>
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
          <p role="alert">We could not complete that request. Check your details and try again.</p>
        )}
        <button className="text-button" onClick={switchMode} type="button">
          {mode === 'sign-in' ? 'Create an account' : 'I already have an account'}
        </button>
      </section>
    </main>
  );
}

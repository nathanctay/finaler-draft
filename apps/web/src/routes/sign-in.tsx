import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENTS_MESSAGE,
} from '@finaler-draft/config';
import { z } from 'zod';
import { AuthApiError, GENERIC_AUTH_ERROR_MESSAGE, api } from '../api.js';
import { emailFieldSchema } from '../formFieldSchemas.js';
import { guardSessionUser, sessionQueryOptions } from '../session.js';
import { describedBy, useFormValidation } from '../useFormValidation.js';

/** "Not blank" is this one's whole rule -- Better Auth's own sign-up accepts any non-empty name,
 * and there is no server-side bound beyond that to share (see `useFormValidation.ts`'s own top
 * comment on why a field with no shared bound still gets a schema, for uniformity). */
const nameFieldSchema = z.string().trim().min(1, 'Enter your name.');

/**
 * Sign-up's password field enforces the real bound -- `packages/auth-server/src/index.ts`'s
 * `minPasswordLength`/`maxPasswordLength`, both read from these same `@finaler-draft/config`
 * constants, is what Better Auth actually checks server-side for a *new* password. `PASSWORD_
 * REQUIREMENTS_MESSAGE` for both ends, matching the static hint text already shown beneath this
 * field and the server-error mapping `api.ts`'s `PASSWORD_TOO_SHORT`/`PASSWORD_TOO_LONG` already
 * use for the identical two Better Auth codes.
 */
const signUpPasswordFieldSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, PASSWORD_REQUIREMENTS_MESSAGE)
  .max(PASSWORD_MAX_LENGTH, PASSWORD_REQUIREMENTS_MESSAGE);

/**
 * Sign-in's password field deliberately does **not** enforce `PASSWORD_MIN_LENGTH`/`_MAX_LENGTH`,
 * unlike sign-up's. Before this slice, the input itself carried a bare `minLength={PASSWORD_MIN
 * _LENGTH}` attribute in *both* modes -- which, now that `noValidate` makes that attribute inert
 * for the browser's own validation anyway, would have been straightforward to reproduce as a
 * client-side message instead. It was not reproduced, on purpose: that bound describes what a
 * *new* password must satisfy, not what an *existing* account's password looks like. An account
 * created before this policy existed, or before a future tightening of it, still has to be able to
 * sign in with the password it actually has; blocking that submission client-side on today's bound
 * would be refusing a password the server was never asked about and might well still accept. The
 * only thing sign-in validates client-side is that something was typed at all -- the real
 * correctness check is, and must stay, the server's own credential verification.
 */
const signInPasswordFieldSchema = z.string().min(1, 'Enter your password.');

/** Sign-in mode renders no `name`/`confirmPassword` field at all, but `useFormValidation` is
 * called with a fixed four-key schema object every render (varying the *key set* between modes
 * would make "first invalid field" resolve against a different order depending on mode, and gains
 * nothing a trivial schema does not already give for free) -- so each mode's two inapplicable
 * fields get this schema, which no value can ever fail, rather than being omitted. */
const alwaysValidFieldSchema = z.string();

/**
 * The explicit "send me another link" affordance. Rendered in both places a visitor can be stuck
 * without a session: straight after signing up, and on a sign-in refused for an unverified
 * address.
 *
 * Deliberately reports its own outcome rather than staying silent on success -- a button that
 * appears to do nothing is indistinguishable from one that is broken, and this one is reached by
 * people who are already unsure whether the first email was ever sent. The failure message stays
 * generic because the underlying endpoint is unauthenticated and answers the same way regardless
 * of whether the address is registered (Better Auth's own anti-enumeration behaviour, the same
 * reason forgot-password.tsx renders one message unconditionally).
 */
function ResendVerification({
  email,
  resend,
}: {
  email: string;
  resend: { isPending: boolean; isSuccess: boolean; isError: boolean; mutate: () => void };
}) {
  if (resend.isSuccess) {
    return <p role="status">If {email} needs verifying, a new link is on its way.</p>;
  }
  return (
    <>
      <button
        className="text-button"
        disabled={resend.isPending}
        onClick={() => resend.mutate()}
        type="button"
      >
        {resend.isPending ? 'Sending…' : 'Resend verification email'}
      </button>
      {resend.isError && (
        <p className="field-error" role="alert">
          Could not send the email just now. Try again in a moment.
        </p>
      )}
    </>
  );
}

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

  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  // Set once a sign-up succeeds without creating a session -- see the `onSuccess` branch below.
  // Never set by sign-in itself: an unverified account's sign-in attempt is a rejected mutation
  // (`EMAIL_NOT_VERIFIED`), not a success with no token, so it renders through the existing error
  // path instead.
  const [awaitingVerification, setAwaitingVerification] = useState(false);

  // Declared in the same top-to-bottom order the fields render (`useFormValidation.ts`'s own
  // contract for which field "first invalid" resolves to). `confirmPassword`'s schema is built
  // fresh every render because it closes over the live `password` value -- it cannot be a
  // module-level constant the way the others are.
  const {
    fields,
    reset: resetValidation,
    validateOnSubmit,
  } = useFormValidation(
    {
      name: mode === 'sign-up' ? nameFieldSchema : alwaysValidFieldSchema,
      email: emailFieldSchema,
      password: mode === 'sign-up' ? signUpPasswordFieldSchema : signInPasswordFieldSchema,
      confirmPassword:
        mode === 'sign-up'
          ? z.string().refine((value) => value === password, { message: 'Passwords do not match.' })
          : alwaysValidFieldSchema,
    },
    { confirmPassword, email, name, password },
  );

  // An explicit resend, rather than the automatic one a rejected sign-in used to trigger (see
  // auth.ts's `sendOnSignIn` comment). A visitor whose link expired, or who never received the
  // first one, needs a way to ask for another that does not depend on guessing that re-attempting
  // sign-in would send one. Reachable from both places a visitor can be stuck: the post-sign-up
  // panel, and a sign-in refused because the address is not verified.
  const resendVerification = useMutation({
    mutationFn: () => api.sendVerificationEmail(email),
  });

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

  function switchMode() {
    setMode((value) => (value === 'sign-in' ? 'sign-up' : 'sign-in'));
    setConfirmPassword('');
    // Without this, a validation state left over from an abandoned attempt in the mode just left
    // would still be showing once the writer switched back -- describing fields `setConfirmPassword`
    // above (and, for a sign-up abandoned mid-attempt, the form itself re-rendering blank) had just
    // reset to a different value than the one the message was about.
    resetValidation();
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
              If {email} is not already registered, a verification link is on its way -- follow it
              to finish setting up your account. If you already have an account, sign in instead.
            </p>
            <ResendVerification email={email} resend={resendVerification} />
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
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (!validateOnSubmit()) return;
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
                    {...fields.name.inputProps}
                  />
                  {fields.name.showError && <p {...fields.name.errorProps}>{fields.name.error}</p>}
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
                  {...fields.email.inputProps}
                />
                {fields.email.showError && <p {...fields.email.errorProps}>{fields.email.error}</p>}
              </div>
              <div className="entry-field">
                <label htmlFor={passwordId}>Password</label>
                <div className="password-field">
                  <input
                    autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                    id={passwordId}
                    minLength={mode === 'sign-up' ? PASSWORD_MIN_LENGTH : undefined}
                    required
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    {...fields.password.inputProps}
                    aria-describedby={describedBy(
                      mode === 'sign-up' ? passwordRequirementsId : undefined,
                      fields.password.showError ? fields.password.errorProps.id : undefined,
                    )}
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
                {fields.password.showError && (
                  <p {...fields.password.errorProps}>{fields.password.error}</p>
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
                      autoComplete="new-password"
                      id={confirmPasswordId}
                      required
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value);
                        // Revealed on every keystroke here, not only on blur -- unlike every other
                        // field's "touched" moment, a confirmation mismatch is naturally watched
                        // *while* retyping it, which is the one case this app already treated this
                        // way before this hook existed (the pre-existing `confirmTouched`, set in
                        // this same `onChange`). `fields.confirmPassword.inputProps.onBlur` is the
                        // hook's own "mark touched" callback; calling it here, not only from a real
                        // blur event, reproduces that exact behaviour through the shared mechanism
                        // rather than losing it.
                        fields.confirmPassword.inputProps.onBlur();
                      }}
                      {...fields.confirmPassword.inputProps}
                    />
                    <PasswordVisibilityToggle
                      label="Show confirm password"
                      onToggle={() => setShowConfirmPassword((value) => !value)}
                      pressed={showConfirmPassword}
                    />
                  </div>
                  {fields.confirmPassword.showError && (
                    <p {...fields.confirmPassword.errorProps}>{fields.confirmPassword.error}</p>
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
            {authentication.isError &&
              authentication.error instanceof AuthApiError &&
              authentication.error.code === 'EMAIL_NOT_VERIFIED' && (
                <ResendVerification email={email} resend={resendVerification} />
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

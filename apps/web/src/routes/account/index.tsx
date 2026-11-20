import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { GENERIC_AUTH_ERROR_MESSAGE, api, type BillingSubscription } from '../../api.js';
import { formatDate, PLAN_NAMES, STATUS_LABELS } from '../../billingPresentation.js';
import { emailFieldSchema, nameFieldSchema } from '../../formFieldSchemas.js';
import { sessionQueryOptions } from '../../session.js';
import { useFormValidation } from '../../useFormValidation.js';

/**
 * The Account info tab of the Manage account page (`routes/account.tsx`,
 * `progress/manage-account-page.md`) -- the index route, so this is what a writer sees on
 * `/account` itself. The owner's own words: "We can have also include account info update on
 * this page (name, email). This can be the one that has the delete account button at the
 * bottom."
 *
 * Guarded once, by the parent layout's own `beforeLoad` -- see `routes/account.deleted.tsx`'s
 * identical comment.
 *
 * **View mode / edit mode.** The first version of this tab rendered both fields permanently
 * editable, each with its own always-visible Save button. The owner's own follow-up: "I think
 * there should be an edit info button that turns them into editable fields, and then a save info
 * button to write any changes to the db." `AccountInfoForm` is the replacement: a single `mode`
 * (`'view' | 'edit'`), one "Edit info" button that enters edit mode, and one "Save info" that
 * writes whatever actually changed.
 *
 * **Name and email keep their own write semantics even though they now share one Save button.**
 * A name applies the moment the write succeeds, trimmed and non-empty; an email does not change
 * until the *new* address is verified (below) -- "Save info" must not flatten that difference
 * into one message. Better Auth's own `/update-user` also refuses a body carrying `email` at all
 * (`api.ts`'s `updateName` comment), so these were always two requests, never one, regardless of
 * how many buttons sit above them.
 *
 * **Email change -- verification first, the owner's explicit decision.** `api.changeEmail` calls
 * Better Auth's own `user.changeEmail` (configured in `packages/auth-server/src/index.ts`): the
 * stored address is never touched by this call. A link is mailed to the *new* address, and only
 * clicking it (`verify-email.tsx`) ever updates `user.email`. No password re-prompt -- the owner
 * declined that stricter variant.
 *
 * **"Already in use by another account" is the one case this form cannot name specifically.**
 * Better Auth's installed `changeEmail` handler (confirmed by reading it directly --
 * `packages/auth-server/src/index.ts`'s own comment on this config has the detail) answers a
 * taken address with the identical `{status: true}` a free one gets, and sends no mail for it --
 * deliberate anti-enumeration behaviour, the same shape `requestPasswordReset` already has in
 * this app, with no flag that changes it. Claiming to distinguish the two here would be lying
 * about what the server actually told this page, so the pending-email status message below
 * names the possibility instead of asserting either outcome.
 *
 * **Read-only facts, a later owner addition.** The owner, on the panel reading sparse with just
 * two fields: "Member since" and "Plan", with a project count and a sessions/"sign out everywhere"
 * control explicitly declined (the first duplicates the dashboard, the second is real
 * functionality for its own future slice, not information). `AccountFacts` renders both, always
 * read-only, in both modes.
 *
 * A third fact, an "Email status" row, was built and then **removed at the owner's request**:
 * "I decided we dont need an email status field. We can put an indicator dot next to email though
 * thats green when confirmed and red when not, and a tooltip that says confirmed or not ocnfirmed
 * when hovering over the dot." A whole row spent saying one word was not worth the line.
 * `EmailStatusDot` is that replacement, and sits beside the address itself rather than apart from
 * it -- which is also where the fact belongs, since it is a property *of* that address.
 *
 * Both `createdAt` and `emailVerified` come off the same `/get-session` response this page already
 * fetches, with `apiSession.ts`'s own `sessionUserSchema` widened to parse them -- no server
 * change. "Plan" reads `GET /api/billing/subscription` under the same query key
 * `routes/account.subscription.tsx` already uses, so a writer who visited that tab first pays no
 * second fetch, and links there rather than duplicating its controls -- "a glance, not a second
 * set of actions," the owner's own words.
 */
export const Route = createFileRoute('/account/')({ component: AccountInfoPage });

function AccountInfoPage() {
  const session = useQuery(sessionQueryOptions);

  if (session.isLoading) {
    return (
      <section className="project-list">
        <h1>Account info</h1>
        <p>Loading your account…</p>
      </section>
    );
  }

  if (session.isError || !session.data) {
    return (
      <section className="project-list">
        <h1>Account info</h1>
        <p role="alert">Your account details could not be loaded.</p>
      </section>
    );
  }

  return (
    <section className="project-list">
      <h1>Account info</h1>
      <AccountInfoForm
        createdAt={session.data.createdAt}
        currentEmail={session.data.email}
        currentName={session.data.name}
        emailVerified={session.data.emailVerified}
      />
      <p>
        <Link className="destructive-button" to="/account/delete">
          Delete account
        </Link>
      </p>
    </section>
  );
}

/** One outcome per field, from the most recent save attempt. `'skipped'` -- the field was never
 * part of the submitted write at all, because it had not changed -- is distinct from `'ok'`
 * precisely so a partial failure (say, name saved, email failed) can report the one that
 * actually happened without implying the other one was ever attempted. */
type FieldOutcome = 'error' | 'ok' | 'skipped';

function AccountInfoForm({
  createdAt,
  currentEmail,
  currentName,
  emailVerified,
}: {
  createdAt: string;
  currentEmail: string;
  currentName: string;
  emailVerified: boolean;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'edit' | 'view'>('view');
  const [draftName, setDraftName] = useState(currentName);
  const [draftEmail, setDraftEmail] = useState(currentEmail);
  // Set only once a save actually resolves (success or failure) -- `undefined` means "nothing to
  // report yet," which is also what a fresh "Edit info" clears it back to, so a stale outcome
  // from a previous edit session never lingers into a new one.
  const [outcome, setOutcome] = useState<
    { email: FieldOutcome; name: FieldOutcome; savedEmail: string } | undefined
  >(undefined);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const emailId = useId();

  // Declared in render order (name, then email) -- `useFormValidation.ts`'s own contract for
  // which field "first invalid" resolves to. Called unconditionally, in both modes: hook order
  // cannot depend on `mode`, and the computed `fields` are simply unused while viewing.
  const {
    fields,
    reset: resetValidation,
    validateOnSubmit,
  } = useFormValidation(
    { name: nameFieldSchema, email: emailFieldSchema },
    { name: draftName, email: draftEmail },
  );
  // `fields.name.inputProps` already carries its own `ref` (the hook's `elementsRef`, which
  // `validateOnSubmit` needs to focus the first invalid field). This input also needs
  // `nameInputRef`, for the separate "entering edit mode focuses the first field" effect below --
  // two different refs, same element, so this merges them into one callback rather than spreading
  // a `ref` key and then trying to override it (TypeScript's own `ref` specified twice than once
  // warning is what catches that mistake, not a style preference).
  const { ref: hookNameRef, ...nameInputProps } = fields.name.inputProps;
  function combinedNameRef(element: HTMLInputElement | null) {
    nameInputRef.current = element;
    hookNameRef(element);
  }

  const mutation = useMutation({
    mutationFn: async ({
      email,
      name,
    }: {
      email: string | undefined;
      name: string | undefined;
    }) => {
      // Each write is attempted independently and never throws out of this function -- a
      // rejected `name` write must not stop the `email` write (or the reverse) from being tried,
      // and the caller needs to know which, if either, actually failed rather than losing that
      // distinction to whichever rejection a thrown `Promise.all` surfaced first.
      const nameOutcome: FieldOutcome =
        name === undefined
          ? 'skipped'
          : await api.updateName(name).then(
              () => 'ok' as const,
              () => 'error' as const,
            );
      const emailOutcome: FieldOutcome =
        email === undefined
          ? 'skipped'
          : await api.changeEmail(email).then(
              () => 'ok' as const,
              () => 'error' as const,
            );
      return { email: emailOutcome, name: nameOutcome };
    },
  });

  useEffect(() => {
    // "Entering edit mode should move focus to the first editable field" -- the owner's own
    // requirement. Runs on the transition into edit mode, not on every render inside it, so
    // retyping or a failed save-and-retry never steals focus back from wherever the writer is.
    if (mode === 'edit') nameInputRef.current?.focus();
  }, [mode]);

  function startEditing() {
    setDraftName(currentName);
    setDraftEmail(currentEmail);
    setOutcome(undefined);
    // A fresh logical session, the same reasoning `useFormValidation.ts`'s own `reset()` comment
    // gives for `routes/sign-in.tsx`'s mode switch: without this, a `submitAttempted`/`touched`
    // left over from a prior edit-cancel-re-edit cycle could reveal a validation message before
    // this session's writer has touched anything.
    resetValidation();
    setMode('edit');
  }

  function cancelEditing() {
    resetValidation();
    setMode('view');
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateOnSubmit() || mutation.isPending) return;
    const trimmedName = draftName.trim();
    const trimmedEmail = draftEmail.trim();
    const nameChanged = trimmedName !== currentName;
    const emailChanged = trimmedEmail.toLowerCase() !== currentEmail.toLowerCase();

    // "If nothing changed, call nothing" -- the owner's own requirement. No mutation, no
    // request; this is indistinguishable from Cancel except that it is reachable from Save too.
    if (!nameChanged && !emailChanged) {
      setMode('view');
      return;
    }

    const result = await mutation.mutateAsync({
      email: emailChanged ? trimmedEmail : undefined,
      name: nameChanged ? trimmedName : undefined,
    });
    if (result.name === 'ok') void queryClient.invalidateQueries({ queryKey: ['session'] });

    if (result.name !== 'error' && result.email !== 'error') {
      // Every attempted write succeeded (an untouched field is `'skipped'`, not an attempt) --
      // only now does this return to view mode, carrying what actually happened into the status
      // message below. `savedEmail` is `trimmedEmail`, not `currentEmail`: the status names the
      // address a confirmation was sent *to*, which is only ever the new one.
      setOutcome({ email: result.email, name: result.name, savedEmail: trimmedEmail });
      setMode('view');
      return;
    }
    // At least one write failed. Stay in edit mode -- `draftName`/`draftEmail` are untouched by
    // any of the above, so whatever the writer typed is still exactly what the form shows -- and
    // report every attempted field's own outcome, including a field that *did* succeed alongside
    // one that did not: hiding that would be its own kind of dishonesty about what just happened.
    setOutcome({ email: result.email, name: result.name, savedEmail: trimmedEmail });
  }

  if (mode === 'view') {
    return (
      <div className="account-info-field">
        <ReadOnlyField label="Name" value={currentName} />
        <ReadOnlyField
          indicator={<EmailStatusDot verified={emailVerified} />}
          label="Email"
          value={currentEmail}
        />
        {outcome?.name === 'ok' && <p className="account-info-status">Name updated.</p>}
        {outcome?.email === 'ok' && (
          <EmailPendingStatus currentEmail={currentEmail} savedEmail={outcome.savedEmail} />
        )}
        <AccountFacts createdAt={createdAt} />
        <div className="account-info-field-row">
          <button className="primary-button" onClick={startEditing} type="button">
            Edit info
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="account-info-field" noValidate onSubmit={handleSave}>
      <label className="dialog-field" htmlFor={nameId}>
        <span>Name</span>
        <input
          id={nameId}
          onChange={(event) => setDraftName(event.target.value)}
          type="text"
          value={draftName}
          {...nameInputProps}
          ref={combinedNameRef}
        />
      </label>
      {fields.name.showError && <p {...fields.name.errorProps}>{fields.name.error}</p>}
      {outcome?.name === 'error' && (
        <p className="field-error" role="alert">
          {GENERIC_AUTH_ERROR_MESSAGE}
        </p>
      )}
      {outcome?.name === 'ok' && <p className="account-info-status">Name updated.</p>}

      <label className="dialog-field" htmlFor={emailId}>
        <span>Email</span>
        <input
          id={emailId}
          onChange={(event) => setDraftEmail(event.target.value)}
          type="email"
          value={draftEmail}
          {...fields.email.inputProps}
        />
      </label>
      {fields.email.showError && <p {...fields.email.errorProps}>{fields.email.error}</p>}
      {outcome?.email === 'error' && (
        <p className="field-error" role="alert">
          {GENERIC_AUTH_ERROR_MESSAGE}
        </p>
      )}
      {outcome?.email === 'ok' && (
        <EmailPendingStatus currentEmail={currentEmail} savedEmail={outcome.savedEmail} />
      )}

      <AccountFacts createdAt={createdAt} />

      <div className="account-info-field-row">
        <button className="primary-button" disabled={mutation.isPending} type="submit">
          {mutation.isPending ? 'Saving…' : 'Save info'}
        </button>
        <button
          className="secondary-button"
          disabled={mutation.isPending}
          onClick={cancelEditing}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The view-mode read-only pairing. Not a bare `<p>` beside a `<label>` -- a `<label>` only
 * programmatically associates with an actual form control, so a plain paragraph next to one
 * reads to a screen reader as two unrelated pieces of text. `aria-labelledby` is what gives the
 * value its accessible name from the label it sits beside, the same association a real
 * `<label htmlFor>` would give an `<input>`.
 *
 * `.account-info-value` on the value, never on the label: the owner's own words, "the text of
 * the info needs to be bigger. Not the label, but the info itself" -- the label stays the
 * existing quiet caption (`.dialog-field`'s own 12px), the value becomes the prominent thing on
 * the row, matched to `.subscription-plan`'s own 15px/700 ("the plan name" on the Manage
 * Subscription page -- the closest existing idiom for one bold stated fact) rather than a size
 * invented for this one rule. `muted`, not `.account-info-value`, is for a row reporting that it
 * *couldn't* load a fact -- `PlanRow` below is the one caller that needs both.
 */
function ReadOnlyField({
  action,
  indicator,
  label,
  muted = false,
  value,
}: {
  action?: ReactNode;
  /** Rendered immediately after `value`, on the same line, as a *sibling* of the value span rather
   * than inside it. Inside, its own `aria-label` would compete with the value's `aria-labelledby`
   * for the same node's accessible name; beside it, the two are announced as what they are -- the
   * address, then its state. `EmailStatusDot` is the only caller. */
  indicator?: ReactNode;
  label: string;
  muted?: boolean;
  value: string;
}) {
  const labelId = useId();
  return (
    <p className="dialog-field account-fact">
      <span id={labelId}>{label}</span>
      <span className={indicator ? 'account-info-value-with-indicator' : undefined}>
        <span aria-labelledby={labelId} className={muted ? 'muted' : 'account-info-value'}>
          {value}
        </span>
        {indicator}
      </span>
      {action}
    </p>
  );
}

/**
 * The email confirmation dot -- the owner's own request, replacing an earlier full "Email status"
 * row: "We can put an indicator dot next to email though thats green when confirmed and red when
 * not, and a tooltip that says confirmed or not confirmed when hovering over the dot."
 *
 * **It reports the *stored* address, never a pending change.** `emailVerified` comes straight off
 * the session's current user row, which a pending `changeEmail` never touches (see
 * `packages/auth-server/src/index.ts`'s verification-first configuration). So the dot cannot
 * contradict the "Your email stays <old address> until you follow it" message beside it: the
 * address this dot describes is exactly the one still in force. For every account that can reach
 * this page the stored address is already verified, since `requireEmailVerification: true` blocks
 * sign-in otherwise -- the unconfirmed state is therefore defensive rather than routine, which is
 * precisely why it must not be silent when it does occur.
 *
 * `role="img"` with an `aria-label`, not a bare styled `<span>`: colour alone must not carry this,
 * and red/green is the most commonly confused pair there is. `title` supplies the hover tooltip the
 * owner asked for and is a second visible channel for the same fact.
 */
function EmailStatusDot({ verified }: { verified: boolean }) {
  const state = verified ? 'Confirmed' : 'Not confirmed';
  return (
    <span
      aria-label={verified ? 'Email confirmed' : 'Email not confirmed'}
      className="email-status"
      role="img"
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className={verified ? 'email-status-dot' : 'email-status-dot email-status-dot-unconfirmed'}
      />
      {/* `aria-hidden`, because the host above already carries the same fact as its accessible
          name -- without this a reader announces the state twice. The bubble is for eyes. */}
      <span aria-hidden="true" className="email-status-tooltip">
        {state}
      </span>
    </span>
  );
}

/**
 * The read-only facts the owner asked for, in both modes, never editable: "Member since" and
 * "Plan". ("Email status" was a third until he replaced it with the dot beside the address --
 * `EmailStatusDot` above -- because a whole row spent saying one word was not worth the line.) Deliberately excludes a project count (duplicates the dashboard) and
 * active sessions / "sign out everywhere" (real functionality, its own future slice) -- both the
 * owner's own explicit exclusions, not oversights.
 */
function AccountFacts({ createdAt }: { createdAt: string }) {
  return (
    <>
      <ReadOnlyField label="Member since" value={formatDate(createdAt)} />
      <PlanRow />
    </>
  );
}

/**
 * "Plan" -- one line read from the same `GET /api/billing/subscription` the Manage Subscription
 * tab already calls, under the identical `['billingSubscription']` query key (so visiting both
 * tabs costs one fetch, not two), plus a link there rather than a second set of controls -- "a
 * glance, not a second set of actions," the owner's own words. Loading and a failed fetch are
 * both `muted`, not `.account-info-value`: a fact this row could not establish is not the
 * prominent thing the eye should land on, unlike an actual resolved plan.
 */
function PlanRow() {
  const subscription = useQuery({
    queryKey: ['billingSubscription'],
    queryFn: api.billingSubscription,
  });

  if (subscription.isLoading) {
    return <ReadOnlyField label="Plan" muted value="Loading…" />;
  }

  if (subscription.isError) {
    return (
      <ReadOnlyField
        action={<Link to="/account/subscription">Manage Subscription</Link>}
        label="Plan"
        muted
        value="Your plan could not be loaded."
      />
    );
  }

  return (
    <ReadOnlyField
      action={<Link to="/account/subscription">Manage Subscription</Link>}
      label="Plan"
      value={planSummary(subscription.data?.subscription ?? null)}
    />
  );
}

/**
 * "Plan, status, and renewal date" -- the owner's own list of what belongs on this one line.
 * `'unknown'` (a plan this app's own `PLAN_NAMES` has no narrower name for) and every
 * `SubscriptionStatus` value already have an established, plain-language label elsewhere
 * (`PLAN_NAMES`/`STATUS_LABELS`, `manageSubscriptionPage.tsx`'s own imports) -- reused here
 * rather than a second copy. "Ends" (not "renews") once cancellation is already in motion, and
 * "Canceled" with its own date rather than a renewal date that will not happen, mirror the same
 * two distinctions `manageSubscriptionPage.tsx`'s own subscription-status block already makes;
 * this is the one-line version of the identical facts, not a conflicting account of them.
 */
function planSummary(subscription: BillingSubscription): string {
  if (!subscription) return 'Free';
  const name = PLAN_NAMES[subscription.plan];
  const status = STATUS_LABELS[subscription.status] ?? subscription.status;
  if (subscription.cancelAtPeriodEnd) {
    return `${name} -- ${status}, ends ${formatDate(subscription.currentPeriodEnd)}`;
  }
  if (subscription.status === 'canceled' && subscription.canceledAt) {
    return `${name} -- ${status} ${formatDate(subscription.canceledAt)}`;
  }
  return `${name} -- ${status}, renews ${formatDate(subscription.currentPeriodEnd)}`;
}

/**
 * The email field's own post-save status -- rendered in view mode after a fully successful save,
 * or inline during edit mode when the email write succeeded but the name write did not (so the
 * email's own success is never hidden behind a failure that is entirely the name field's).
 * Wording unchanged from before this revision: never claims the address changed, only that a
 * confirmation was sent to it. "The result must report them distinctly" -- the owner's own
 * wording -- is why this is never merged into one sentence with the name's own "Name updated."
 */
function EmailPendingStatus({
  currentEmail,
  savedEmail,
}: {
  currentEmail: string;
  savedEmail: string;
}) {
  return (
    <p className="account-info-status">
      {`If ${savedEmail} isn't already used by another account, we've sent a link there to confirm the change. Your email stays ${currentEmail} until you follow it.`}
    </p>
  );
}

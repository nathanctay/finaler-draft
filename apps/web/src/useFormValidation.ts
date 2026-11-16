import { useId, useRef, useState } from 'react';
import type { ZodType } from 'zod';

/**
 * The one mechanism behind every inline, in-red, beneath-the-field validation message in this
 * app (`routes/sign-in.tsx`, `routes/forgot-password.tsx`, `routes/reset-password.tsx`,
 * `routes/projects/index.tsx`, `routes/projects/$projectId/index.tsx`, `renameDialog.tsx`,
 * `namedRevisionDialog.tsx`, `feedbackDialog.tsx`, `sharingDialog.tsx`) -- built once here rather
 * than let each of those nine forms hand-roll its own `touched`/`submitAttempted`/`validationError`
 * trio, which is exactly what `renameDialog.tsx` and `routes/sign-in.tsx` already did independently
 * before this module existed, and which the brief that commissioned this module named directly as
 * the drift risk worth stopping before a tenth form repeated it a third way.
 *
 * **Why Zod, not a hand-written `if (!value.trim())`.** Two of this app's rules are not this form's
 * own opinion: a title's maximum length and a password's length bounds are also the server's rules
 * (`apps/api/src/projects.ts`'s `projectTitle`, `packages/auth-server/src/index.ts`'s
 * `minPasswordLength`/`maxPasswordLength`), both already expressed as Zod schemas reading the exact
 * same `@finaler-draft/config` constants this module's own schemas read
 * (`RESOURCE_TITLE_MAX_LENGTH`, `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH`,
 * `FEEDBACK_BODY_MAX_LENGTH`). A hand-written client check restates the *number* in a second place
 * with no shared source; a Zod schema reading the shared constant cannot restate a number that
 * drifts, because there is only one number. Where a field's only rule is "not blank" (a name, a
 * revision label, an invite's role is never blank by construction) there is no server bound to
 * share, and a schema here is used anyway, for uniformity of the one mechanism below -- not because
 * Zod is pulling any particular weight for that one field. See each schema's own module (this repo
 * keeps them beside the form that owns them, not centralized, because `confirmPassword`'s schema in
 * `routes/sign-in.tsx` closes over the live `password` value and genuinely cannot be a module-level
 * constant) for which case it is.
 *
 * **Timing: on blur after an edit, or on a submit attempt -- never on every keystroke.** `error`
 * below is always computed, from the current value, on every render; `showError` is what gates
 * whether it is *displayed*, and is true once a submit has been attempted (`submitAttempted`), or
 * once the field has both been edited at least once and then blurred (`touched` *and* `dirty` --
 * see this file's inline comment on `dirtyRef`, "Blur alone is not enough," for why both are
 * required rather than blur alone). This is not a new policy invented for this module: it is
 * `renameDialog.tsx`'s pre-existing `showValidationError = validationError !== undefined &&
 * (touched || submitAttempted)` and `routes/sign-in.tsx`'s pre-existing `showMismatchError`, lifted
 * out and generalized rather than redesigned, because both were already the right answer to "do
 * not tell someone their half-typed email is wrong while they are still typing it" -- and, in both
 * of their own original call sites, "touched" already meant "edited" (`renameDialog.tsx`'s own
 * precedent always cleared or retyped the field before blurring it; `sign-in.tsx`'s own
 * `confirmTouched` was set from inside `onChange`, never from a bare blur). The reason blur (not
 * only submit) also reveals it: a writer who edits a required field down to empty and tabs past it
 * has declared themselves done with it, the identical moment a submit attempt declares the whole
 * form done -- validating only at submit would make a keyboard user tab through five fields with
 * no feedback at all until the one moment they click the button at the end.
 *
 * **Clearing.** There is no separate "clear the error" step. `error` is recomputed from `values` on
 * every render, so the instant a field's value becomes valid, `error` becomes `undefined` and
 * `showError` follows it to `false` on that same render -- a field cannot keep showing a stale
 * message about a problem it no longer has.
 *
 * **Focus on an invalid submit.** `validateOnSubmit` marks every field as if submitted, focuses the
 * *first* invalid one (so a keyboard user is never left to hunt for which of several fields is the
 * problem), and returns whether the whole form was valid. "First" is positional in the `schemas`
 * object's own key order -- `Object.keys` on a plain object literal of non-numeric string keys
 * preserves insertion order, which is a language guarantee, not a convention this module invented
 * -- so **callers must declare `schemas` in the same top-to-bottom order the fields render in**, or
 * "first invalid" and "first on screen" can disagree.
 *
 * **What this deliberately does not do.** It does not disable a submit button, render anything, or
 * decide what counts as a submission -- every caller keeps its own existing convention for that
 * (some disable Submit while invalid, as `renameDialog.tsx`/`namedRevisionDialog.tsx`/
 * `feedbackDialog.tsx` already did; `routes/sign-in.tsx` does not, and still must not, because its
 * submit button's `disabled` is reserved for "a request is in flight"). The only contract a caller
 * must honour is calling `validateOnSubmit()` first inside its `onSubmit`, and returning without
 * calling its mutation when it answers `false` -- see this project's mutation table in
 * `progress/form-validation-messages.md` for the test that catches a caller which stops doing that.
 */
function fieldError(schema: ZodType<string>, value: string): string | undefined {
  const result = schema.safeParse(value);
  // Only the first issue is ever shown. Every schema in this app expresses one rule's worth of
  // explanation per field (either it is blank, or it is too long, or it does not look like an
  // email, never two independent concerns stacked on one field), so there is never a second issue
  // worth picking over the first -- see the schemas themselves.
  return result.success ? undefined : result.error.issues[0]?.message;
}

export interface FieldValidation {
  /** The field's current problem, or `undefined` if the current value satisfies its schema.
   * Computed unconditionally -- see `showError` for whether it is actually displayed. */
  readonly error: string | undefined;
  /** Whether `error` should render right now. See this module's own top comment, "Timing." */
  readonly showError: boolean;
  /** Spread onto the `<p>` that renders `error`: `<p {...fields.title.errorProps}>{fields.title
   * .error}</p>`. Callers render this element only while `showError` is true -- the id is not
   * reserved when nothing wears it, so `aria-describedby` below never points at a missing node. */
  readonly errorProps: { readonly id: string; readonly role: 'alert'; readonly className: string };
  /** Spread onto the `<input>`/`<textarea>`/`<select>` this field validates. `aria-describedby`
   * joins with any static hint id the caller already has via this module's `describedBy` helper --
   * never just assigned over it, which would silently stop a screen reader from ever hearing the
   * hint once a field had an error, or the reverse. */
  readonly inputProps: {
    readonly 'aria-invalid': boolean;
    readonly 'aria-describedby': string | undefined;
    readonly onBlur: () => void;
    readonly ref: (element: HTMLElement | null) => void;
  };
}

export type FieldSchemas<Name extends string> = Record<Name, ZodType<string>>;
export type FieldValues<Name extends string> = Record<Name, string>;

export interface UseFormValidationResult<Name extends string> {
  readonly fields: Record<Name, FieldValidation>;
  /** Call first, inside `onSubmit`, ahead of the mutation. Returns whether the whole form is
   * valid; when it is not, every field's error becomes visible and the first invalid field is
   * focused, and the caller must return without submitting. */
  readonly validateOnSubmit: () => boolean;
  /** Clears every field back to "nothing touched, nothing submitted" -- for a caller that reuses
   * one mounted form for more than one logical session, the way `routes/sign-in.tsx`'s own
   * `switchMode` reuses one `SignInPage` for both sign-in and sign-up. Without this, a validation
   * state left over from an abandoned sign-up attempt would still be showing once the writer
   * switched back to it, describing fields that had just been reset to blank. */
  readonly reset: () => void;
}

export function useFormValidation<Name extends string>(
  schemas: FieldSchemas<Name>,
  values: FieldValues<Name>,
): UseFormValidationResult<Name> {
  const baseId = useId();
  const [touched, setTouched] = useState<ReadonlySet<Name>>(() => new Set());
  const [submitAttempted, setSubmitAttempted] = useState(false);
  // A plain ref keyed by field name, not one `useRef` per field: the set of field names can
  // legitimately differ between renders of the same component (`routes/sign-in.tsx`'s `schemas`
  // has four keys in sign-up mode and two in sign-in mode), and calling a hook from inside the loop
  // below that builds `fields` would break the rule that a component's hook calls must be the same
  // on every render. One `useRef` holding a plain object sidesteps that entirely.
  const elementsRef = useRef<Partial<Record<Name, HTMLElement | null>>>({});
  // Tracks which fields have ever actually changed value, across renders -- see "Blur alone is not
  // enough" below. Monotonic: once a field is marked dirty it stays dirty for this mount, even if
  // its value is later edited back to what it started as.
  const dirtyRef = useRef<Set<Name>>(new Set());
  const previousValuesRef = useRef<Partial<Record<Name, string>>>({});

  const names = Object.keys(schemas) as Name[];
  const fields = {} as Record<Name, FieldValidation>;
  for (const name of names) {
    const value = values[name] ?? '';
    const previousValue = previousValuesRef.current[name];
    // `previousValue !== undefined` excludes this field's first-ever render from the comparison --
    // otherwise a field whose caller seeds it with a non-blank initial value (`renameDialog.tsx`'s
    // `initialTitle`) would compare against `undefined`, see a "change", and be marked dirty before
    // the writer has touched anything at all.
    if (previousValue !== undefined && previousValue !== value) dirtyRef.current.add(name);
    previousValuesRef.current[name] = value;

    const error = fieldError(schemas[name], value);
    // **Blur alone is not enough.** A dialog that autofocuses its first field on mount
    // (`renameDialog.tsx`, `namedRevisionDialog.tsx`, `feedbackDialog.tsx`, `sharingDialog.tsx` all
    // do, for keyboard accessibility) puts focus on that field before the writer has done anything
    // at all -- so in a dialog with *other* controls below it (`sharingDialog.tsx`'s member list is
    // the one that actually has this shape), the writer's very first click on an unrelated button
    // fires a blur on the still-blank, still-untouched invite field as a pure side effect of focus
    // moving away. Revealing "Enter an email address." at that moment would be describing a field
    // the writer has not interacted with yet, triggered by an action that has nothing to do with
    // it -- found by exactly that happening in `sharingDialog.test.tsx`'s member-management tests,
    // which click "Remove"/"Make owner" buttons and never touch the invite field at all. Requiring
    // the field to also be `dirty` (its value has genuinely changed at least once) is what tells
    // "the writer left a field blank on purpose" (`renameDialog.test.tsx`: clear, then Tab) apart
    // from "a blur happened to this field because focus went somewhere else" (nothing changed it).
    // `submitAttempted` is unaffected by this -- a submit reveals every invalid field regardless of
    // whether any of them was ever touched, exactly as before.
    const showError =
      error !== undefined && (submitAttempted || (touched.has(name) && dirtyRef.current.has(name)));
    const errorId = `${baseId}-${name}-error`;
    fields[name] = {
      error,
      errorProps: { className: 'field-error', id: errorId, role: 'alert' },
      inputProps: {
        'aria-describedby': showError ? errorId : undefined,
        'aria-invalid': showError,
        onBlur: () => {
          setTouched((current) => (current.has(name) ? current : new Set(current).add(name)));
        },
        ref: (element) => {
          elementsRef.current[name] = element;
        },
      },
      showError,
    };
  }

  function validateOnSubmit(): boolean {
    setSubmitAttempted(true);
    const firstInvalid = names.find((name) => fields[name].error !== undefined);
    if (firstInvalid === undefined) return true;
    elementsRef.current[firstInvalid]?.focus();
    return false;
  }

  function reset(): void {
    setTouched(new Set());
    setSubmitAttempted(false);
  }

  return { fields, reset, validateOnSubmit };
}

/**
 * Joins the `aria-describedby` references a field needs into the one space-separated id list the
 * attribute wants, dropping whichever of "a static hint" / "this field's current error" is not
 * currently present -- rather than either one being assigned over the other, which is what a form
 * with both a hint (`routes/sign-in.tsx`'s password requirements) and a validation message on the
 * same input would do if each were wired to the attribute independently.
 */
export function describedBy(...ids: readonly (string | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => id !== undefined);
  return present.length > 0 ? present.join(' ') : undefined;
}

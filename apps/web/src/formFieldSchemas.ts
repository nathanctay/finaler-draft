import { RESOURCE_TITLE_MAX_LENGTH } from '@finaler-draft/config';
import { z } from 'zod';

/**
 * The field-level Zod schemas genuinely shared by more than one form, pulled out here rather than
 * left as a module-level constant inside whichever form happened to need one first -- the exact
 * mistake that would have repeated `RESOURCE_TITLE_MAX_LENGTH`'s rule as three near-identical
 * literals (`renameDialog.tsx`, `routes/projects/index.tsx`, `routes/projects/$projectId/index.tsx`)
 * and the email format rule as three more (`routes/sign-in.tsx`, `routes/forgot-password.tsx`,
 * `sharingDialog.tsx`). See `useFormValidation.ts`'s own top comment for why these are schemas at
 * all, and why some of this app's field rules (a revision label, a feedback message) are *not*
 * here: those have no second caller, so a shared module would just be indirection with one import
 * site.
 */

/**
 * Exactly `projectTitle`'s own rule (`apps/api/src/projects.ts`:
 * `z.string().trim().min(1).max(RESOURCE_TITLE_MAX_LENGTH)`), which backs project creation,
 * screenplay creation, and both rename endpoints identically (that file's own comment: "Rename
 * shares the exact same title constraints as create"). Read from the shared
 * `@finaler-draft/config` constant that schema itself uses, not a second `200` literal: a bound
 * that drifted from the server's own would mean a title accepted here still being rejected with a
 * 400, or one rejected here that the server would have allowed.
 */
export const titleFieldSchema = z
  .string()
  .trim()
  .min(1, 'Enter a title.')
  .max(RESOURCE_TITLE_MAX_LENGTH, `Titles can be at most ${RESOURCE_TITLE_MAX_LENGTH} characters.`);

/**
 * Not tied to a shared `@finaler-draft/config` constant the way `titleFieldSchema` is: the
 * server's own email bound (`apps/api/src/sharing.ts`'s `inviteInput.email`:
 * `z.string().trim().min(3).max(320).email()`) is a private literal inside `apps/api`, never
 * exported, and Better Auth's own sign-up/sign-in email handling carries no equivalent exported
 * constant either. Restating `320` here as a second, independent literal would be exactly the
 * drift this module exists to prevent elsewhere -- a private literal that moved in `apps/api`
 * would leave this one silently wrong with no shared source to catch it. So this schema validates
 * only what every caller can state with no invented bound: non-empty, and `.email()`-shaped. A
 * message that happens to be longer than the server's defensive 320-character ceiling still
 * reaches the server and is refused there, through the ordinary server-refusal path every one of
 * these forms already has (`MessageApiError.serverMessage`) -- not silently accepted, just not
 * pre-empted a second time for a bound this module cannot verify stayed in sync.
 */
export const emailFieldSchema = z
  .string()
  .trim()
  .min(1, 'Enter an email address.')
  .email('Enter a valid email address.');

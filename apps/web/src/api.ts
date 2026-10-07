import {
  screenplaySchema,
  screenplayBlockSchema,
  titlePageSchema,
  type Screenplay,
} from '@finaler-draft/screenplay';
import { PASSWORD_REQUIREMENTS_MESSAGE } from '@finaler-draft/config';
import { z } from 'zod';
import { authClient } from './authClient.js';
import { ApiError, json, request, session, type SessionUser } from './apiSession.js';

export { ApiError };

const projectSchema = z.object({
  id: z.string().uuid(),
  role: z.string(),
  title: z.string(),
  updatedAt: z.string(),
});
const screenplaySummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  updatedAt: z.string(),
});
const screenplayResponseSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  screenplay: screenplaySchema,
  title: z.string(),
});
// Better Auth's `/sign-up/email` and `/sign-in/email` both return `{token, user}` (installed
// `api/routes/sign-up.mjs`/`sign-in.mjs`). Only `signUp` below reads `token`: now that
// `requireEmailVerification` (auth.ts) is on, a fresh sign-up no longer creates a session --
// Better Auth skips auto-sign-in for an unverified account -- so `token` comes back `null`
// instead of a session token, and that is exactly the signal sign-in.tsx needs to show "check
// your email" instead of navigating to /projects as if a session had actually been created.
const authTokenResponseSchema = z.object({ token: z.string().nullable() });
const renameResponseSchema = z.object({ id: z.string().uuid(), title: z.string() });
const deleteResponseSchema = z.object({ id: z.string().uuid() });
const deletedProjectSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string(),
});
const deletedScreenplaySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string(),
  projectId: z.string().uuid(),
  projectTitle: z.string(),
});
const deletedResponseSchema = z.object({
  projects: z.array(deletedProjectSchema),
  screenplays: z.array(deletedScreenplaySchema),
});
// Mirrors apps/api/src/app.ts's `revisionListItemSchema`/`revisionDetailSchema` field for field --
// collaboration slice 4a's durable revision history and read-only historical preview.
// `previewMetadata` stays `z.unknown()` here too, matching the server's own schema: it is a
// display convenience this app never branches its own correctness on.
const revisionListItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['named', 'idle_session', 'structural_change', 'export']),
  label: z.string().nullable(),
  authoredBy: z.string().nullable(),
  createdAt: z.string(),
  previewMetadata: z.unknown(),
});
const revisionDetailSchema = revisionListItemSchema.extend({
  screenplayId: z.string().uuid(),
  screenplay: screenplaySchema,
});
const createRevisionResponseSchema = revisionListItemSchema.extend({ created: z.boolean() });

// Collaboration slice 4b's screenplay-aware diff. Mirrors apps/api/src/app.ts's own
// `revisionDiffResponseSchema` and its constituent schemas field for field, down to reusing the
// same `screenplayBlockSchema`/`titlePageSchema` for `before`/`after` payloads -- the identical
// "one real definition of this shape" reasoning the server-side schema comment gives.
const identifiedDiffStatusSchema = z.enum(['added', 'removed', 'matched']);
const screenplayBlockDiffEntrySchema = z.object({
  id: z.string().uuid(),
  status: identifiedDiffStatusSchema,
  moved: z.boolean(),
  changed: z.boolean(),
  elementTypeChanged: z.boolean(),
  textChanged: z.boolean(),
  beforeIndex: z.number().optional(),
  afterIndex: z.number().optional(),
  before: screenplayBlockSchema.optional(),
  after: screenplayBlockSchema.optional(),
});
const screenplaySceneDiffEntrySchema = z.object({
  id: z.string(),
  area: z.enum(['scene', 'preamble']),
  status: identifiedDiffStatusSchema,
  moved: z.boolean(),
  beforeIndex: z.number().optional(),
  afterIndex: z.number().optional(),
  beforeHeadingText: z.string().optional(),
  afterHeadingText: z.string().optional(),
  beforeSceneNumber: z.string().optional(),
  afterSceneNumber: z.string().optional(),
  headingTextChanged: z.boolean(),
  blocks: z.array(screenplayBlockDiffEntrySchema),
});
const titlePageDiffEntrySchema = z.object({
  id: z.string().uuid(),
  status: identifiedDiffStatusSchema,
  moved: z.boolean(),
  changed: z.boolean(),
  beforeIndex: z.number().optional(),
  afterIndex: z.number().optional(),
  before: titlePageSchema.optional(),
  after: titlePageSchema.optional(),
});
const documentSettingsDiffEntrySchema = z.object({
  field: z.enum([
    'characterIndentIn',
    'parentheticalIndentIn',
    'parentheticalWidthIn',
    'pageNumberStyle',
    'sceneNumbersEnabled',
    'autoMoreContinued',
  ]),
  before: z.union([z.number(), z.string(), z.boolean()]),
  after: z.union([z.number(), z.string(), z.boolean()]),
});
const screenplayDiffSchema = z.object({
  titleChanged: z.boolean(),
  titleBefore: z.string(),
  titleAfter: z.string(),
  documentSettingsChanges: z.array(documentSettingsDiffEntrySchema),
  titlePages: z.array(titlePageDiffEntrySchema),
  blocks: z.array(screenplayBlockDiffEntrySchema),
  scenes: z.array(screenplaySceneDiffEntrySchema),
  isEmpty: z.boolean(),
});
const revisionDiffSideSchema = z.object({
  id: z.string(),
  kind: z.enum(['named', 'idle_session', 'structural_change', 'export']).nullable(),
  label: z.string().nullable(),
  createdAt: z.string().nullable(),
});
// `olderScreenplay`/`newerScreenplay`: the two whole canonical projections the diff was computed
// from, which the inline diff view renders the document itself out of -- see `RevisionDiffResult`'s
// own comment in `apps/api/src/revisions.ts` for why the diff alone is not enough and why these
// travel with it rather than being fetched separately.
const revisionDiffResponseSchema = z.object({
  screenplayId: z.string().uuid(),
  older: revisionDiffSideSchema,
  newer: revisionDiffSideSchema,
  diff: screenplayDiffSchema,
  olderScreenplay: screenplaySchema,
  newerScreenplay: screenplaySchema,
});
// Mirrors apps/api/src/app.ts's `describeEntitlement` response shape field for field (see that
// function's own comment for why `cooldownEndsAt` is server-derived rather than recomputed here
// from `slotUpdatedAt` plus a client-side copy of the cooldown interval).
const entitlementSchema = z.object({
  tier: z.enum(['paid', 'restricted']),
  editableScreenplayId: z.string().nullable(),
  candidateScreenplayIds: z.array(z.string()),
  slotUpdatedAt: z.string().nullable(),
  cooldownEndsAt: z.string().nullable(),
});
// Mirrors apps/api/src/app.ts's `switchEditableScreenplayResponseSchema` field for field.
const switchEditableScreenplayResponseSchema = z.object({
  screenplayId: z.string(),
  updatedAt: z.string(),
});
// Mirrors apps/api/src/app.ts's `connectionTokenResponseSchema` field for field. Backs
// `App.tsx`'s `HocuspocusProvider` construction (collabConfig.ts's own doc comment, and
// progress/collaboration-plan.md's connection-tokens slice): the short-lived, collab-scoped
// token that replaced forwarding the Better Auth session cookie to `apps/collab`, which no
// browser can do once `app` and `collab` are on two different hosts.
const connectionTokenResponseSchema = z.object({ token: z.string(), expiresAt: z.string() });
const billingSessionResponseSchema = z.object({ url: z.string() });
// Not a zod schema: nothing here ever validates an incoming `plan` value at runtime (the caller
// is always this app's own UI, already constrained by this same TypeScript union), so a schema
// would exist only to be `z.infer`'d from -- a plain type says the same thing more directly.
export type BillingPlan = 'monthly' | 'annual';
// Mirrors apps/api/src/app.ts's `describeBillingSubscription` response shape field for field --
// backs the Manage Subscription page (routes/billing.subscription.tsx). Deliberately a separate
// schema/call from `entitlementSchema`/`api.entitlement` above: that endpoint answers "what can
// this actor do" (tier, the editable slot); this one answers "what does this actor's Stripe
// subscription actually look like" (plan, status, dates) -- see that route's own server-side
// comment for the full reasoning. `subscription: null` means never subscribed; a lapsed or
// canceled account still returns a non-null `subscription` carrying its last-known state.
const billingSubscriptionSchema = z.object({
  subscription: z
    .object({
      plan: z.enum(['monthly', 'annual', 'unknown']),
      status: z.enum([
        'incomplete',
        'incomplete_expired',
        'trialing',
        'active',
        'past_due',
        'canceled',
        'unpaid',
        'paused',
      ]),
      currentPeriodEnd: z.string(),
      cancelAtPeriodEnd: z.boolean(),
      canceledAt: z.string().nullable(),
    })
    .nullable(),
});
// Mirrors apps/api/src/app.ts's `GET /api/billing/plans` response shape -- real Stripe amounts
// for the pricing cards (routes/billing.subscription.tsx), so the annual saving shown there is
// derived from actual configured prices rather than a hardcoded percentage. `amount` is the
// smallest unit of `currency` (cents for USD), matching Stripe's own `unit_amount` exactly.
const planPriceSchema = z.object({
  amount: z.number(),
  currency: z.string(),
  interval: z.string().nullable(),
});
const billingPlansSchema = z.object({ monthly: planPriceSchema, annual: planPriceSchema });

// Rendered anywhere an authentication mutation fails for a reason that isn't one of
// `authErrorMessages`' specific codes -- a network failure, a 5xx, or a code this map doesn't
// recognize. Exported (rather than kept file-local, as it was before this slice added the new
// entry screens below) so `forgot-password.tsx` and `reset-password.tsx` can render the exact
// same fallback sign-in.tsx always has, instead of a second copy of the same sentence drifting
// out of sync with it.
export const GENERIC_AUTH_ERROR_MESSAGE =
  'We could not complete that request. Check your details and try again.';

const authErrorMessages = {
  INVALID_EMAIL: 'Enter a valid email address.',
  INVALID_EMAIL_OR_PASSWORD: 'Invalid email or password.',
  INVALID_PASSWORD: 'Enter a valid password.',
  PASSWORD_TOO_SHORT: PASSWORD_REQUIREMENTS_MESSAGE,
  PASSWORD_TOO_LONG: PASSWORD_REQUIREMENTS_MESSAGE,
  USER_ALREADY_EXISTS: 'An account already exists for this email address.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'An account already exists for this email address.',
  // Reachable only from `resetPassword` below: the token in a password-reset link has already
  // been used, was never valid, or its one-hour expiry (auth.ts) has passed.
  INVALID_TOKEN: 'This link is invalid or has expired. Request a new one.',
  // Reachable from `signIn` once `requireEmailVerification` (auth.ts) is on: the account exists
  // and the password is correct, but the account has not verified its email. `sendOnSignIn`
  // (also auth.ts) means this same rejected attempt already triggered a fresh verification email,
  // so the message can honestly tell the visitor to look for one.
  EMAIL_NOT_VERIFIED: 'Verify your email before signing in.',
} as const;

export type AuthValidationErrorCode = keyof typeof authErrorMessages;

const authErrorResponseSchema = z.object({ code: z.string() });

async function authenticationJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await request(path, init);
  if (!response.ok) throw await authenticationError(response);
  return schema.parse(await response.json());
}

async function authenticationError(response: Response): Promise<ApiError> {
  try {
    const parsed = authErrorResponseSchema.safeParse(await response.json());
    if (parsed.success && isAuthValidationErrorCode(parsed.data.code)) {
      return new AuthApiError(response.status, parsed.data.code);
    }
  } catch {
    // Error responses may be empty or non-JSON. They retain the generic API error.
  }
  return new ApiError(response.status);
}

function isAuthValidationErrorCode(value: string): value is AuthValidationErrorCode {
  return Object.hasOwn(authErrorMessages, value);
}

export class AuthApiError extends ApiError {
  readonly safeMessage: string;

  constructor(
    status: number,
    readonly code: AuthValidationErrorCode,
  ) {
    super(status);
    this.safeMessage = authErrorMessages[code];
  }
}

/**
 * Thrown by `createScreenplay` specifically, in place of the bare `ApiError` every other `json`
 * call throws on a non-OK response. app.ts's `{error: string}` bodies are already meant to be
 * shown, and this one in particular is worth keeping: the 402 a free account hits at the
 * one-screenplay limit carries `EntitlementLimitError`'s own message (apps/api/src/entitlements.ts),
 * written to explain the limit and point at the upgrade path -- `ApiError`'s bare
 * `Request failed (402)` would throw that away. routes/projects/$projectId/index.tsx reads
 * `serverMessage` directly into its upgrade prompt rather than writing a second copy of the same
 * sentence.
 */
export class MessageApiError extends ApiError {
  constructor(
    status: number,
    readonly serverMessage: string,
  ) {
    super(status);
  }
}

async function jsonWithServerMessage<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await request(path, init);
  if (!response.ok) {
    let message: string | undefined;
    try {
      const body: unknown = await response.json();
      if (
        body &&
        typeof body === 'object' &&
        'error' in body &&
        typeof (body as { error: unknown }).error === 'string'
      ) {
        message = (body as { error: string }).error;
      }
    } catch {
      // Error responses may be empty or non-JSON; fall through to the generic message below.
    }
    throw new MessageApiError(response.status, message ?? `Request failed (${response.status})`);
  }
  return schema.parse(await response.json());
}

/**
 * Better Auth's client (authClient.ts) resolves to `{data, error}` rather than throwing --
 * `@better-fetch/fetch`'s default, unchanged here. `error`, when present, spreads the parsed JSON
 * error body (Better Auth's own `{code, message}` shape, the same one every hand-rolled request
 * in this file already expects) together with `status`/`statusText` (confirmed against the
 * installed `@better-fetch/fetch` source). Normalizing that into the same `AuthApiError`/`ApiError`
 * pair `authenticationJson` throws means every consumer, regardless of which of the two request
 * paths it used, can check `instanceof AuthApiError` the one way.
 */
function unwrapAuthClientResult<T>(result: {
  data: T | null;
  error: { code?: unknown; status: number } | null;
}): T {
  if (!result.error) return result.data as T;
  const code = typeof result.error.code === 'string' ? result.error.code : undefined;
  throw code && isAuthValidationErrorCode(code)
    ? new AuthApiError(result.error.status, code)
    : new ApiError(result.error.status);
}

/**
 * An absolute URL on the origin the visitor is actually looking at, for the pages emailed links
 * land on.
 *
 * These were relative paths, and Better Auth resolves a relative `callbackURL`/`redirectTo`
 * against `BETTER_AUTH_URL` -- the API's own origin. In production that is the same origin that
 * serves the client, so a relative path happens to work. In development it is not: the API is on
 * :3001 and Vite serves the app on :5173, so a verification link redirected the browser to
 * `http://localhost:3001/verify-email`, where Fastify has no such route and answered 404. The
 * emailed link was therefore unusable for anyone running the app locally -- found by the owner
 * doing exactly that, and invisible to every test, because the browser suites run against the
 * production build where both origins coincide.
 *
 * `window.location.origin` is the right source: it is by definition where the visitor's app is
 * served from, in either environment. Better Auth validates these against its own trusted-origin
 * list (`createAuth`'s `trustedOrigins`, which includes `CLIENT_ORIGIN`), so an absolute URL here
 * is checked rather than blindly followed.
 */
function appUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export const api = {
  session,
  // Typed the same way `signUp` below is (`{token}`, not `z.unknown()`) so `sign-in.tsx` can read
  // `.token` off either mutation's result without a runtime type guard. Sign-in's own `token` is
  // never actually `null` in practice -- an unverified account is rejected before that response
  // is ever built (`EMAIL_NOT_VERIFIED`, auth.ts) -- but sharing one schema keeps both call sites
  // honest about the same real response shape instead of one of them being asserted away.
  signIn: (email: string, password: string) =>
    authenticationJson('/api/auth/sign-in/email', authTokenResponseSchema, {
      body: JSON.stringify({ email, password }),
      method: 'POST',
    }),
  // `callbackURL` is where the verification link (auth.ts's `sendVerificationEmail`) redirects
  // the browser after the server has already verified the token -- see verify-email.tsx, the
  // landing page that link targets. Without this, Better Auth's own default (`encodeURIComponent
  // ('/')`, installed `sign-up.mjs`) would land the visitor back at the app root instead of a
  // page that actually says the email was confirmed.
  signUp: (name: string, email: string, password: string) =>
    authenticationJson('/api/auth/sign-up/email', authTokenResponseSchema, {
      body: JSON.stringify({ callbackURL: appUrl('/verify-email'), email, name, password }),
      method: 'POST',
    }),
  signOut: () => json('/api/auth/sign-out', z.unknown(), { method: 'POST' }),
  // Better Auth's own anti-enumeration design (installed `api/routes/password.mjs`): this always
  // answers the same generic success regardless of whether `email` is registered, so the caller
  // cannot and must not branch on the result to reveal that -- see forgot-password.tsx, which
  // renders one message unconditionally. `redirectTo` is where the emailed link sends the browser
  // once the server has validated the token (with `?token=...` appended); reset-password.tsx is
  // the page that reads it from there.
  requestPasswordReset: (email: string) =>
    authClient()
      .requestPasswordReset({ email, redirectTo: appUrl('/reset-password') })
      .then(unwrapAuthClientResult),
  resetPassword: (newPassword: string, token: string) =>
    authClient().resetPassword({ newPassword, token }).then(unwrapAuthClientResult),
  // Requires no session, by design: an unverified account cannot sign in, so the visitor asking
  // for a fresh link has no session to authenticate with (confirmed against the installed
  // `api/routes/email-verification.mjs`, whose body is just `{ email }`). Better Auth applies its
  // own 3-per-60-seconds limit to this path specifically, which is what keeps an unauthenticated
  // send endpoint from becoming a way to post mail to an arbitrary address.
  //
  // `callbackURL` matches sign-up's, so a link from here lands on the same confirmation page.
  sendVerificationEmail: (email: string) =>
    authClient()
      .sendVerificationEmail({ callbackURL: appUrl('/verify-email'), email })
      .then(unwrapAuthClientResult),
  projects: () => json('/api/projects', z.array(projectSchema)),
  createProject: (title: string) =>
    json('/api/projects', projectSchema.pick({ id: true, title: true }), {
      body: JSON.stringify({ title }),
      method: 'POST',
    }),
  screenplays: (projectId: string) =>
    json(`/api/projects/${projectId}/screenplays`, z.array(screenplaySummarySchema)),
  // `jsonWithServerMessage`, not the plain `json` helper every other call here uses: this is the
  // one write a free account can hit the one-screenplay limit on, and the 402 it gets back
  // carries a real, specific explanation (`EntitlementLimitError`'s message) that the free-tier
  // limit prompt (routes/projects/$projectId/index.tsx) shows the writer directly.
  createScreenplay: (projectId: string, title: string, screenplay: Screenplay) =>
    jsonWithServerMessage(
      `/api/projects/${projectId}/screenplays`,
      z.object({ id: z.string().uuid() }),
      {
        body: JSON.stringify({ screenplay, title }),
        method: 'POST',
      },
    ),
  screenplay: (id: string) => json(`/api/screenplays/${id}`, screenplayResponseSchema),
  // The whole-document `PUT /api/screenplays/:id` this app used to autosave through is deleted
  // (collaboration slice 1: the canonical screenplay is a projection of the Yjs document
  // `apps/collab` maintains, not a thing this client `PUT`s -- see
  // `progress/collaboration-slice-1.md`). A screenplay's body now persists by virtue of the
  // editor being bound to that Yjs document (`App.tsx`'s `createScreenplayEditorInit`); there is
  // no explicit save call to make, and so no `api.saveScreenplay` here anymore.
  deleteProject: (id: string) =>
    json(`/api/projects/${id}`, deleteResponseSchema, { method: 'DELETE' }),
  restoreProject: (id: string) =>
    json(`/api/projects/${id}/restore`, renameResponseSchema, { method: 'POST' }),
  deleteScreenplay: (id: string) =>
    json(`/api/screenplays/${id}`, deleteResponseSchema, { method: 'DELETE' }),
  restoreScreenplay: (id: string) =>
    json(`/api/screenplays/${id}/restore`, renameResponseSchema, { method: 'POST' }),
  deletedItems: () => json('/api/deleted', deletedResponseSchema),
  entitlement: () => json('/api/entitlement', entitlementSchema),
  // `jsonWithServerMessage`, matching `createScreenplay` above: a refusal here carries a real
  // explanation worth showing verbatim -- 404 for "not a candidate" (app.ts deliberately does not
  // distinguish that from "does not exist", the same information-hiding convention the rest of
  // this API already uses) and 409 for the switch-slot cooldown. App.tsx's read-only banner reads
  // `.serverMessage` directly into its own inline error, the same way the free-tier limit prompt
  // already does with this helper's other caller.
  switchEditableScreenplay: (screenplayId: string) =>
    jsonWithServerMessage(
      '/api/entitlement/editable-screenplay',
      switchEditableScreenplayResponseSchema,
      { body: JSON.stringify({ screenplayId }), method: 'PUT' },
    ),
  // Mints a short-lived, collab-scoped connection token (see `connectionTokenResponseSchema`'s
  // own comment). Called from `App.tsx`'s `HocuspocusProvider` construction as an async `token`
  // function, not a bare string -- `@hocuspocus/provider`'s own `getToken()` calls that function
  // fresh on every reconnect (`sendToken()`, on every `onOpen`), which is what lets an expired
  // token recover with a fresh one automatically rather than a page reload.
  connectionToken: () =>
    json('/api/collab/connection-token', connectionTokenResponseSchema, { method: 'POST' }),
  // Redirects the browser to the returned url (Stripe-hosted Checkout or Customer Portal) --
  // callers never inspect these beyond `.url`; see externalRedirect.ts, the one place that
  // navigation actually happens.
  // Collaboration slice 4a. Any project member -- reviewer included, matching plan.md's "a lapsed
  // account keeps every screenplay readable and exportable" -- may list and read revisions; the
  // server enforces this, not this client.
  listRevisions: (screenplayId: string) =>
    json(`/api/screenplays/${screenplayId}/revisions`, z.array(revisionListItemSchema)),
  // Historical preview's one read: a single immutable revision's own canonical screenplay, never
  // the live document. See routes/projects/$projectId.screenplays.$screenplayId.revisions.$revisionId.tsx.
  revision: (screenplayId: string, revisionId: string) =>
    json(`/api/screenplays/${screenplayId}/revisions/${revisionId}`, revisionDetailSchema),
  // Collaboration slice 4b's screenplay-aware diff. With `against` omitted, compares against the
  // screenplay's current live content -- the default the diff view itself uses, and the exact
  // comparison a future restore-preview (plan.md's restore flow, step 1) will need. With `against`
  // supplied, compares two stored revisions directly.
  revisionDiff: (screenplayId: string, revisionId: string, against?: string) =>
    json(
      `/api/screenplays/${screenplayId}/revisions/${revisionId}/diff${
        against ? `?against=${against}` : ''
      }`,
      revisionDiffResponseSchema,
    ),
  // `jsonWithServerMessage`, matching `switchEditableScreenplay`/`createScreenplay` above: a
  // refusal here (403, not owner/editor) carries the server's own explanation, shown inline by the
  // caller rather than a bare "Request failed (403)".
  createNamedRevision: (screenplayId: string, label: string) =>
    jsonWithServerMessage(
      `/api/screenplays/${screenplayId}/revisions`,
      createRevisionResponseSchema,
      { body: JSON.stringify({ kind: 'named', label }), method: 'POST' },
    ),
  // Fired best-effort alongside an FDX/DOCX/PDF download (App.tsx's `runExport`) -- never blocks
  // or fails the download itself; the plain `json` helper is enough since the caller only ever
  // logs a failure here, it never shows one to the writer.
  createExportRevision: (screenplayId: string, format: 'docx' | 'fdx' | 'pdf') =>
    json(`/api/screenplays/${screenplayId}/revisions`, createRevisionResponseSchema, {
      body: JSON.stringify({ kind: 'export', format }),
      method: 'POST',
    }),
  createCheckoutSession: (plan: BillingPlan) =>
    json('/api/billing/checkout-session', billingSessionResponseSchema, {
      body: JSON.stringify({ plan }),
      method: 'POST',
    }),
  createPortalSession: () =>
    json('/api/billing/portal-session', billingSessionResponseSchema, { method: 'POST' }),
  billingSubscription: () => json('/api/billing/subscription', billingSubscriptionSchema),
  billingPlans: () => json('/api/billing/plans', billingPlansSchema),
};

export type Project = z.infer<typeof projectSchema>;
export type ScreenplaySummary = z.infer<typeof screenplaySummarySchema>;
export type Entitlement = z.infer<typeof entitlementSchema>;
export type BillingSubscription = z.infer<typeof billingSubscriptionSchema>['subscription'];
export type BillingPlans = z.infer<typeof billingPlansSchema>;
export type PlanPrice = z.infer<typeof planPriceSchema>;
export type { SessionUser };
export type DeletedProject = z.infer<typeof deletedProjectSchema>;
export type DeletedScreenplay = z.infer<typeof deletedScreenplaySchema>;
export type PersistedScreenplay = {
  id: string;
  projectId: string;
  screenplay: Screenplay;
  title: string;
};
export type RevisionListItem = z.infer<typeof revisionListItemSchema>;
export type RevisionDetail = z.infer<typeof revisionDetailSchema>;
export type ScreenplayDiff = z.infer<typeof screenplayDiffSchema>;
export type ScreenplayBlockDiffEntry = z.infer<typeof screenplayBlockDiffEntrySchema>;
export type ScreenplaySceneDiffEntry = z.infer<typeof screenplaySceneDiffEntrySchema>;
export type RevisionDiffSide = z.infer<typeof revisionDiffSideSchema>;
export type RevisionDiffResult = z.infer<typeof revisionDiffResponseSchema>;

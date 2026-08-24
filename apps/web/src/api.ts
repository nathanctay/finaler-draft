import { screenplaySchema, type Screenplay } from '@finaler-draft/screenplay';
import { PASSWORD_REQUIREMENTS_MESSAGE } from '@finaler-draft/config';
import { z } from 'zod';
import { authClient } from './authClient.js';

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
  version: z.number().int().positive(),
});
const screenplayResponseSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  screenplay: screenplaySchema,
  title: z.string(),
  version: z.number().int().positive(),
});
const sessionUserSchema = z.object({
  email: z.string(),
  id: z.string(),
  name: z.string(),
});
const sessionResponseSchema = z.object({ user: sessionUserSchema }).nullable();
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

async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = init?.body
    ? { 'content-type': 'application/json', ...(init.headers ?? {}) }
    : init?.headers;
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    ...(headers ? { headers } : {}),
  });
  return response;
}

async function json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  if (!response.ok) throw new ApiError(response.status);
  return schema.parse(await response.json());
}

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

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status})`);
  }
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
 * `GET /api/auth/get-session` returns HTTP 200 with a body of literally `null` when
 * signed out, not an error. Resolve that to `null` rather than throwing; still reject
 * a non-OK status and a body that is neither `null` nor a valid session.
 */
async function session(): Promise<SessionUser | null> {
  const response = await request('/api/auth/get-session');
  if (!response.ok) throw new ApiError(response.status);
  const body = sessionResponseSchema.parse(await response.json());
  return body?.user ?? null;
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
  createScreenplay: (projectId: string, title: string, screenplay: Screenplay) =>
    json(
      `/api/projects/${projectId}/screenplays`,
      z.object({ id: z.string().uuid(), version: z.number() }),
      {
        body: JSON.stringify({ screenplay, title }),
        method: 'POST',
      },
    ),
  screenplay: (id: string) => json(`/api/screenplays/${id}`, screenplayResponseSchema),
  // `keepalive` lets the browser complete this request even if the page that started it is gone
  // by the time the response would arrive, at the cost of a 64 KB total request-body cap (Fetch
  // spec) -- used only by App.tsx's `pagehide` flush, the one exit that genuinely might be a page
  // teardown; its unmount and `visibilitychange` flushes pass `false` deliberately, since neither
  // is the page going away and a real screenplay routinely exceeds that cap
  // (progress/save-conflict-recovery.md). Never used on the ordinary debounced path. `fetch`'s
  // `keepalive` is what `RequestInit` calls it; `request()` passes it through unchanged, same as
  // every other field on `init`.
  saveScreenplay: (
    id: string,
    expectedVersion: number,
    screenplay: Screenplay,
    options?: { keepalive?: boolean },
  ) =>
    json(`/api/screenplays/${id}`, z.object({ version: z.number().int().positive() }), {
      body: JSON.stringify({ expectedVersion, screenplay }),
      keepalive: options?.keepalive ?? false,
      method: 'PUT',
    }),
  deleteProject: (id: string) =>
    json(`/api/projects/${id}`, deleteResponseSchema, { method: 'DELETE' }),
  restoreProject: (id: string) =>
    json(`/api/projects/${id}/restore`, renameResponseSchema, { method: 'POST' }),
  deleteScreenplay: (id: string) =>
    json(`/api/screenplays/${id}`, deleteResponseSchema, { method: 'DELETE' }),
  restoreScreenplay: (id: string) =>
    json(`/api/screenplays/${id}/restore`, renameResponseSchema, { method: 'POST' }),
  deletedItems: () => json('/api/deleted', deletedResponseSchema),
};

export type Project = z.infer<typeof projectSchema>;
export type ScreenplaySummary = z.infer<typeof screenplaySummarySchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
export type DeletedProject = z.infer<typeof deletedProjectSchema>;
export type DeletedScreenplay = z.infer<typeof deletedScreenplaySchema>;
export type PersistedScreenplay = {
  id: string;
  projectId: string;
  screenplay: Screenplay;
  title: string;
  version: number;
};

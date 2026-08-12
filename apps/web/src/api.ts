import { screenplaySchema, type Screenplay } from '@finaler-draft/screenplay';
import { PASSWORD_REQUIREMENTS_MESSAGE } from '@finaler-draft/config';
import { z } from 'zod';

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

const authErrorMessages = {
  INVALID_EMAIL: 'Enter a valid email address.',
  INVALID_EMAIL_OR_PASSWORD: 'Invalid email or password.',
  INVALID_PASSWORD: 'Enter a valid password.',
  PASSWORD_TOO_SHORT: PASSWORD_REQUIREMENTS_MESSAGE,
  PASSWORD_TOO_LONG: PASSWORD_REQUIREMENTS_MESSAGE,
  USER_ALREADY_EXISTS: 'An account already exists for this email address.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'An account already exists for this email address.',
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

export const api = {
  session,
  signIn: (email: string, password: string) =>
    authenticationJson('/api/auth/sign-in/email', z.unknown(), {
      body: JSON.stringify({ email, password }),
      method: 'POST',
    }),
  signUp: (name: string, email: string, password: string) =>
    authenticationJson('/api/auth/sign-up/email', z.unknown(), {
      body: JSON.stringify({ email, name, password }),
      method: 'POST',
    }),
  signOut: () => json('/api/auth/sign-out', z.unknown(), { method: 'POST' }),
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
  saveScreenplay: (id: string, expectedVersion: number, screenplay: Screenplay) =>
    json(`/api/screenplays/${id}`, z.object({ version: z.number().int().positive() }), {
      body: JSON.stringify({ expectedVersion, screenplay }),
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

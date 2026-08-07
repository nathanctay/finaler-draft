import { screenplaySchema, type Screenplay } from '@finaler-draft/screenplay';
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
  PASSWORD_TOO_SHORT: 'Password must be at least 12 characters.',
  PASSWORD_TOO_LONG: 'Password is too long.',
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

export const api = {
  session: () => json('/api/auth/get-session', z.object({ user: z.object({ id: z.string() }) })),
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
};

export type Project = z.infer<typeof projectSchema>;
export type ScreenplaySummary = z.infer<typeof screenplaySummarySchema>;
export type PersistedScreenplay = {
  id: string;
  projectId: string;
  screenplay: Screenplay;
  title: string;
  version: number;
};

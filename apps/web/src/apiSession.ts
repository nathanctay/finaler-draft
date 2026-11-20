import { z } from 'zod';

/**
 * The primitives and schemas the bootstrap path needs, kept apart from api.ts on purpose.
 *
 * `session.ts`'s `guardSessionUser` runs inside every route's `beforeLoad`, and a route guard
 * executes before any component renders -- so TanStack Router's automatic code splitting cannot
 * defer it into a lazy chunk the way it defers a route's `component`. ESM evaluates a module's
 * whole top level on any import, so if the guard reached into api.ts for `api.session`, it would
 * drag in every other schema declared there too, including `screenplayResponseSchema`'s
 * `screenplaySchema` -- the entire canonical `@finaler-draft/screenplay` schema tree -- into the
 * entry chunk, even though nothing at bootstrap validates a screenplay.
 *
 * This module holds exactly what `session()` needs to run standalone: the shared `fetch`
 * wrapper, the generic JSON-plus-schema helper, `ApiError`, and the session response schema.
 * api.ts imports these same bindings rather than redeclaring them, so `api.session` (used by
 * tests and any other consumer that already imports the full api.ts) and `session()` here stay
 * the exact same function -- this is a move, not a fork.
 */

export async function request(path: string, init?: RequestInit): Promise<Response> {
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

export async function json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  if (!response.ok) throw new ApiError(response.status);
  return schema.parse(await response.json());
}

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status})`);
  }
}

// `createdAt`/`emailVerified` -- the Account info tab's "Member since"/"Email status" rows
// (`routes/account/index.tsx`, `progress/manage-account-page.md`). Both are already present on
// every real `GET /api/auth/get-session` response (Better Auth returns them on `user` by
// default); this is a client-side schema widening only -- no server change, confirmed against
// the installed Better Auth source. `createdAt` stays a plain ISO string, matching
// `billingPresentation.ts`'s own `formatDate`, which every other date already on this page
// (`currentPeriodEnd`, `canceledAt`) is passed through the identical way.
const sessionUserSchema = z.object({
  createdAt: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  id: z.string(),
  name: z.string(),
});
const sessionResponseSchema = z.object({ user: sessionUserSchema }).nullable();

export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * `GET /api/auth/get-session` returns HTTP 200 with a body of literally `null` when
 * signed out, not an error. Resolve that to `null` rather than throwing; still reject
 * a non-OK status and a body that is neither `null` nor a valid session.
 */
export async function session(): Promise<SessionUser | null> {
  const response = await request('/api/auth/get-session');
  if (!response.ok) throw new ApiError(response.status);
  const body = sessionResponseSchema.parse(await response.json());
  return body?.user ?? null;
}

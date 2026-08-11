/**
 * Server-only environment parsing, split out of `@finaler-draft/config` so the browser bundle
 * has no import path to the shape of the server's environment.
 *
 * This is a separate package rather than a module inside `apps/api` (e.g. `apps/api/src/
 * environment.ts`) even though `apps/api` is currently its only consumer. A same-package module
 * would be equally safe against `apps/web` today — `apps/web` cannot import from `apps/api`
 * either — but the isolation would be incidental rather than intentional, and `plan.md` already
 * schedules a second server-side consumer inside this phase: deterministic PDF export is a
 * required Phase 1 capability, and the export worker will likely need its own Dockerfile,
 * meaning its own deployable process with its own environment to parse. A package expresses that
 * "more than one server process needs this" is the actual shape of the problem, not a guess about
 * the future; a module would need to be promoted to a package later anyway, at which point
 * whichever process didn't get updated first would silently keep duplicating this logic instead.
 */
import { z } from 'zod';

const serverEnvironment = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url().optional(),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  CLIENT_ORIGIN: z.string().url().optional(),
});

export type ServerEnvironment = z.infer<typeof serverEnvironment>;

export function parseServerEnvironment(
  input: Record<string, string | undefined>,
): ServerEnvironment {
  return serverEnvironment.parse(input);
}

export function requirePersistenceEnvironment(environment: ServerEnvironment) {
  const persistence = z
    .object({
      DATABASE_URL: z.string().url(),
      BETTER_AUTH_SECRET: z.string().min(32),
      BETTER_AUTH_URL: z.string().url(),
      CLIENT_ORIGIN: z.string().url().optional(),
    })
    .parse(environment);
  if (
    environment.NODE_ENV === 'production' &&
    new URL(persistence.BETTER_AUTH_URL).protocol !== 'https:'
  ) {
    throw new Error('BETTER_AUTH_URL must use HTTPS in production.');
  }
  return persistence;
}

export function findPersistenceEnvironment(environment: ServerEnvironment) {
  const values = [
    environment.DATABASE_URL,
    environment.BETTER_AUTH_SECRET,
    environment.BETTER_AUTH_URL,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  return requirePersistenceEnvironment(environment);
}

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

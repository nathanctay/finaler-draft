import { z } from 'zod';

const serverEnvironment = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});

export type ServerEnvironment = z.infer<typeof serverEnvironment>;

export function parseServerEnvironment(
  input: Record<string, string | undefined>,
): ServerEnvironment {
  return serverEnvironment.parse(input);
}

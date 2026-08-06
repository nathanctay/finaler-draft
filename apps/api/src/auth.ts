import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { createDatabase, schema } from '@finaler-draft/database';

export interface AuthEnvironment {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  CLIENT_ORIGIN?: string | undefined;
  DATABASE_URL: string;
}

export function createAuth(environment: AuthEnvironment) {
  const { database, pool } = createDatabase(environment.DATABASE_URL);
  const auth = betterAuth({
    database: drizzleAdapter(database, { provider: 'pg', schema }),
    baseURL: environment.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins: [
      environment.BETTER_AUTH_URL,
      ...(environment.CLIENT_ORIGIN ? [environment.CLIENT_ORIGIN] : []),
    ],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: false,
    },
  });

  return { auth, pool, database };
}

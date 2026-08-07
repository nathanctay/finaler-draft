import { describe, expect, it } from 'vitest';
import {
  findPersistenceEnvironment,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENTS_MESSAGE,
  parseServerEnvironment,
  requirePersistenceEnvironment,
} from './index.js';

describe('parseServerEnvironment', () => {
  it('publishes the shared password policy for auth clients and the server', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(PASSWORD_REQUIREMENTS_MESSAGE).toBe('Password must be 12–128 characters.');
  });

  it('uses safe development defaults', () => {
    expect(parseServerEnvironment({})).toEqual({ NODE_ENV: 'development', PORT: 3001 });
  });

  it('rejects ports outside the TCP range', () => {
    expect(() => parseServerEnvironment({ PORT: '70000' })).toThrow(/65535/);
  });

  it('keeps persistence optional for health and static-server environments', () => {
    const environment = parseServerEnvironment({});
    expect(findPersistenceEnvironment(environment)).toBeUndefined();
    expect(() => requirePersistenceEnvironment(environment)).toThrow(/DATABASE_URL/);
  });

  it('requires complete persistence configuration and enforces production HTTPS', () => {
    const partial = parseServerEnvironment({ DATABASE_URL: 'postgresql://localhost/finaler' });
    expect(() => findPersistenceEnvironment(partial)).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      requirePersistenceEnvironment(
        parseServerEnvironment({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://localhost/finaler',
          BETTER_AUTH_SECRET: 'x'.repeat(32),
          BETTER_AUTH_URL: 'http://app.example.test',
        }),
      ),
    ).toThrow(/HTTPS/);
  });

  it('returns complete secure persistence configuration', () => {
    const environment = parseServerEnvironment({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://localhost/finaler',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'https://app.example.test',
      CLIENT_ORIGIN: 'https://writer.example.test',
    });
    expect(findPersistenceEnvironment(environment)).toEqual({
      DATABASE_URL: 'postgresql://localhost/finaler',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'https://app.example.test',
      CLIENT_ORIGIN: 'https://writer.example.test',
    });
  });

  it('permits loopback HTTP only outside the production environment', () => {
    expect(
      requirePersistenceEnvironment(
        parseServerEnvironment({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://localhost/finaler',
          BETTER_AUTH_SECRET: 'x'.repeat(32),
          BETTER_AUTH_URL: 'http://127.0.0.1:4174',
        }),
      ),
    ).toMatchObject({ BETTER_AUTH_URL: 'http://127.0.0.1:4174' });
  });
});

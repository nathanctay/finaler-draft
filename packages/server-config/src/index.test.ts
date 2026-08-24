import { describe, expect, it } from 'vitest';
import {
  DEFAULT_API_RATE_LIMIT_MAX,
  DEFAULT_API_RATE_LIMIT_WINDOW_MS,
  findPersistenceEnvironment,
  parseServerEnvironment,
  requirePersistenceEnvironment,
} from './index.js';

describe('parseServerEnvironment', () => {
  it('uses safe development defaults', () => {
    expect(parseServerEnvironment({})).toEqual({
      NODE_ENV: 'development',
      PORT: 3001,
      API_RATE_LIMIT_MAX: DEFAULT_API_RATE_LIMIT_MAX,
      API_RATE_LIMIT_WINDOW_MS: DEFAULT_API_RATE_LIMIT_WINDOW_MS,
    });
  });

  it('rejects ports outside the TCP range', () => {
    expect(() => parseServerEnvironment({ PORT: '70000' })).toThrow(/65535/);
  });

  it('rejects a non-positive global rate limit configuration', () => {
    expect(() => parseServerEnvironment({ API_RATE_LIMIT_MAX: '0' })).toThrow();
    expect(() => parseServerEnvironment({ API_RATE_LIMIT_WINDOW_MS: '-1' })).toThrow();
  });

  it('honors an explicit global rate limit override', () => {
    expect(
      parseServerEnvironment({ API_RATE_LIMIT_MAX: '50', API_RATE_LIMIT_WINDOW_MS: '5000' }),
    ).toMatchObject({ API_RATE_LIMIT_MAX: 50, API_RATE_LIMIT_WINDOW_MS: 5000 });
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
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM_ADDRESS: 'noreply@example.test',
    });
    expect(findPersistenceEnvironment(environment)).toEqual({
      DATABASE_URL: 'postgresql://localhost/finaler',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'https://app.example.test',
      CLIENT_ORIGIN: 'https://writer.example.test',
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM_ADDRESS: 'noreply@example.test',
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

  it('does not require Resend configuration outside production', () => {
    expect(
      requirePersistenceEnvironment(
        parseServerEnvironment({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://localhost/finaler',
          BETTER_AUTH_SECRET: 'x'.repeat(32),
          BETTER_AUTH_URL: 'http://127.0.0.1:4174',
        }),
      ),
    ).not.toHaveProperty('RESEND_API_KEY');
  });

  it('refuses to start in production without a Resend API key and from address, even with a valid HTTPS URL', () => {
    expect(() =>
      requirePersistenceEnvironment(
        parseServerEnvironment({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://localhost/finaler',
          BETTER_AUTH_SECRET: 'x'.repeat(32),
          BETTER_AUTH_URL: 'https://app.example.test',
        }),
      ),
    ).toThrow(/RESEND_API_KEY/);
  });

  it('refuses to start in production with a Resend API key but no from address', () => {
    expect(() =>
      requirePersistenceEnvironment(
        parseServerEnvironment({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://localhost/finaler',
          BETTER_AUTH_SECRET: 'x'.repeat(32),
          BETTER_AUTH_URL: 'https://app.example.test',
          RESEND_API_KEY: 're_test_key',
        }),
      ),
    ).toThrow(/MAIL_FROM_ADDRESS/);
  });

  it('starts in production once both Resend fields are present, alongside HTTPS', () => {
    expect(
      requirePersistenceEnvironment(
        parseServerEnvironment({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://localhost/finaler',
          BETTER_AUTH_SECRET: 'x'.repeat(32),
          BETTER_AUTH_URL: 'https://app.example.test',
          RESEND_API_KEY: 're_test_key',
          MAIL_FROM_ADDRESS: 'noreply@example.test',
        }),
      ),
    ).toMatchObject({ RESEND_API_KEY: 're_test_key', MAIL_FROM_ADDRESS: 'noreply@example.test' });
  });
});

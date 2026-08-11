import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENTS_MESSAGE,
} from './index.js';

describe('password policy', () => {
  it('publishes the shared password policy for auth clients and the server', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(PASSWORD_REQUIREMENTS_MESSAGE).toBe('Password must be 12–128 characters.');
  });
});

/**
 * Shared policy the browser legitimately needs. Server-only environment parsing lives in
 * `@finaler-draft/server-config` instead, so the browser bundle has no import path to the shape
 * of the server's environment, even by accident.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_REQUIREMENTS_MESSAGE = `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`;

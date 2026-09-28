import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { CONNECTION_TOKEN_TTL_MS, mintConnectionToken, verifyConnectionToken } from './index.js';

const secret = 'a'.repeat(32);
const otherSecret = 'b'.repeat(32);
const now = new Date('2026-09-25T12:00:00Z');

describe('mintConnectionToken / verifyConnectionToken', () => {
  it('verifies a freshly minted token back to the actor it was minted for', async () => {
    const token = await mintConnectionToken(secret, 'actor-a', now);
    const result = await verifyConnectionToken(secret, token, now);
    expect(result).toEqual({ outcome: 'valid', actorId: 'actor-a' });
  });

  it('never confuses two tokens minted for two different actors, even minted at the same instant', async () => {
    const tokenA = await mintConnectionToken(secret, 'actor-a', now);
    const tokenB = await mintConnectionToken(secret, 'actor-b', now);
    await expect(verifyConnectionToken(secret, tokenA, now)).resolves.toEqual({
      outcome: 'valid',
      actorId: 'actor-a',
    });
    await expect(verifyConnectionToken(secret, tokenB, now)).resolves.toEqual({
      outcome: 'valid',
      actorId: 'actor-b',
    });
  });

  it('accepts a token right up to the instant before it expires', async () => {
    const token = await mintConnectionToken(secret, 'actor-a', now);
    const justBeforeExpiry = new Date(now.getTime() + CONNECTION_TOKEN_TTL_MS - 1);
    await expect(verifyConnectionToken(secret, token, justBeforeExpiry)).resolves.toEqual({
      outcome: 'valid',
      actorId: 'actor-a',
    });
  });

  // The property risk #1 in the brief names directly: an expired token must land in its own
  // bucket, distinct from every other rejection, so `authenticate.ts` can classify it as
  // transient (retry with a fresh token) rather than a permanent denial.
  it('reports an expired token as its own distinct outcome, not folded into "invalid"', async () => {
    const token = await mintConnectionToken(secret, 'actor-a', now);
    const afterExpiry = new Date(now.getTime() + CONNECTION_TOKEN_TTL_MS + 1);
    await expect(verifyConnectionToken(secret, token, afterExpiry)).resolves.toEqual({
      outcome: 'expired',
    });
  });

  it('rejects a token signed with a different secret as invalid, never as expired', async () => {
    const token = await mintConnectionToken(otherSecret, 'actor-a', now);
    await expect(verifyConnectionToken(secret, token, now)).resolves.toEqual({
      outcome: 'invalid',
    });
  });

  it('rejects a malformed token', async () => {
    await expect(verifyConnectionToken(secret, 'not-a-real-jwt-at-all', now)).resolves.toEqual({
      outcome: 'invalid',
    });
  });

  it('rejects an absent token -- the exact empty string @hocuspocus/server reads when the client configured none', async () => {
    await expect(verifyConnectionToken(secret, '', now)).resolves.toEqual({ outcome: 'invalid' });
  });

  // A real, correctly-signed JWT -- signed with the exact right secret -- that simply is not a
  // connection token. Proves this module checks *what* it signed, not only *that* it was this
  // module's own secret that did the signing; without this check any other JWT this codebase ever
  // signs with the same secret (there are none today, but this must not depend on that staying
  // true) would be silently accepted here too.
  it('rejects a correctly-signed token that carries no "purpose" claim at all', async () => {
    const foreignToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('actor-a')
      .setIssuedAt(now)
      .setExpirationTime(new Date(now.getTime() + CONNECTION_TOKEN_TTL_MS))
      .sign(new TextEncoder().encode(secret));
    await expect(verifyConnectionToken(secret, foreignToken, now)).resolves.toEqual({
      outcome: 'invalid',
    });
  });

  it('rejects a correctly-signed, correctly-purposed token with no subject', async () => {
    const noSubject = await new SignJWT({ purpose: 'collab-connect' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(new Date(now.getTime() + CONNECTION_TOKEN_TTL_MS))
      .sign(new TextEncoder().encode(secret));
    await expect(verifyConnectionToken(secret, noSubject, now)).resolves.toEqual({
      outcome: 'invalid',
    });
  });
});

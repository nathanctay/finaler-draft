import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('PRODUCT_NAME / TAGLINE', () => {
  it('are exactly the owner-specified literals', async () => {
    const { PRODUCT_NAME, TAGLINE } = await import('./site.config.js');
    expect(PRODUCT_NAME).toBe('Finaler Draft');
    expect(TAGLINE).toBe('Made by filmmakers, for filmmakers.');
  });
});

describe('APP_ORIGIN', () => {
  it('falls back to the web app local dev origin when PUBLIC_APP_ORIGIN is unset', async () => {
    vi.stubEnv('PUBLIC_APP_ORIGIN', '');
    const { APP_ORIGIN } = await import('./site.config.js');
    expect(APP_ORIGIN).toBe('http://localhost:5173');
  });

  it('uses PUBLIC_APP_ORIGIN when set, normalized to a bare origin', async () => {
    vi.stubEnv('PUBLIC_APP_ORIGIN', 'https://app.example.com/');
    const { APP_ORIGIN } = await import('./site.config.js');
    expect(APP_ORIGIN).toBe('https://app.example.com');
  });

  it('throws for a malformed PUBLIC_APP_ORIGIN rather than silently falling back', async () => {
    vi.stubEnv('PUBLIC_APP_ORIGIN', 'not a url');
    await expect(import('./site.config.js')).rejects.toThrow(/not a valid URL/);
  });

  it('throws when PUBLIC_APP_ORIGIN carries a path, query, or hash', async () => {
    vi.stubEnv('PUBLIC_APP_ORIGIN', 'https://app.example.com/dashboard');
    await expect(import('./site.config.js')).rejects.toThrow(/no path, query, or hash/);
  });
});

describe('SITE_URL', () => {
  it('falls back to the local Astro dev origin when PUBLIC_SITE_URL is unset', async () => {
    vi.stubEnv('PUBLIC_SITE_URL', '');
    const { SITE_URL } = await import('./site.config.js');
    expect(SITE_URL).toBe('http://localhost:4321');
  });

  it('uses PUBLIC_SITE_URL when set, normalized to a bare origin', async () => {
    vi.stubEnv('PUBLIC_SITE_URL', 'https://example.com/');
    const { SITE_URL } = await import('./site.config.js');
    expect(SITE_URL).toBe('https://example.com');
  });
});

describe('APP_LINK_LABEL', () => {
  it('is a single neutral label, never implying a signed-in or signed-out state', async () => {
    const { APP_LINK_LABEL } = await import('./site.config.js');
    expect(APP_LINK_LABEL).toBe('Open app');
    expect(APP_LINK_LABEL).not.toMatch(/sign in/i);
    expect(APP_LINK_LABEL).not.toMatch(/dashboard/i);
  });
});

describe('PRICE_MONTHLY / PRICE_ANNUAL', () => {
  it('match the owner-specified figures, exclusive of tax', async () => {
    const { PRICE_MONTHLY, PRICE_ANNUAL } = await import('./site.config.js');
    expect(PRICE_MONTHLY).toEqual({ amount: 500, currency: 'usd', interval: 'month' });
    expect(PRICE_ANNUAL).toEqual({ amount: 5000, currency: 'usd', interval: 'year' });
  });
});

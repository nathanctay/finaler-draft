/**
 * Single source of the landing page's identity and environment-driven values.
 *
 * The product's final name and domain are not settled yet (plan.md's billing section still calls
 * the price points and even the name provisional). Everything that would need to change on a
 * rename or a domain purchase is defined here and nowhere else: `PRODUCT_NAME` is the one
 * literal, and every URL is read from an environment variable set per Railway service, with
 * local-dev fallbacks so `astro dev` / `astro build` work without a `.env` file.
 */

/** The provisional product name. The owner has not settled the final name -- see plan.md. */
export const PRODUCT_NAME = 'Finaler Draft';

export const TAGLINE = 'Made by filmmakers, for filmmakers.';

function readOrigin(envValue: string | undefined, fallback: string, varName: string): string {
  const trimmed = envValue?.trim();
  if (!trimmed) return fallback;
  // This module only ever runs at build time (static output, no server) -- failing loudly here
  // means a malformed origin never reaches a published page; it fails the build instead.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${varName} is not a valid URL: "${trimmed}"`);
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`${varName} must be an origin with no path, query, or hash: "${trimmed}"`);
  }
  return parsed.origin;
}

function readBoolean(envValue: string | undefined, fallback: boolean, varName: string): boolean {
  const trimmed = envValue?.trim().toLowerCase();
  if (!trimmed) return fallback;
  if (trimmed === 'true' || trimmed === '1') return true;
  if (trimmed === 'false' || trimmed === '0') return false;
  throw new Error(`${varName} must be "true", "false", "1", or "0" if set: got "${trimmed}"`);
}

/**
 * The origin of the deployed app (the `app.` subdomain), e.g. "https://app.example.com". Every
 * link to the app on this site points here and nowhere else -- the landing page makes no API call
 * of its own, which is what keeps it out of Better Auth's CSRF origin allowlist entirely (see
 * `BETTER_AUTH_URL` / `CLIENT_ORIGIN` in the api app).
 *
 * Note for anyone tempted to shortcut this later: the apex and `app.` subdomains are different
 * *origins* even once both are deployed on the same registrable domain. A cookie scoped to
 * `.example.com` would be readable from both, but a `fetch` from this static site to the app's
 * API would still need CORS -- same registrable domain does not mean same-origin, and does not
 * make a credentialed request free. See `APP_LINK_LABEL` below for why this site does neither.
 */
export const APP_ORIGIN = readOrigin(
  import.meta.env.PUBLIC_APP_ORIGIN,
  'http://localhost:5173',
  'PUBLIC_APP_ORIGIN',
);

/**
 * Whether the app at `APP_ORIGIN` is actually live. The owner intends to deploy this site before
 * the app exists, specifically to have a URL to give Stripe -- so there is a real, expected window
 * where `APP_ORIGIN` resolves to nothing. Defaults to `false` deliberately: an unset
 * `PUBLIC_APP_IS_LIVE` must never be read as "live," because that is exactly the state this site
 * ships in first. Every template that would otherwise link to `APP_ORIGIN` must check this first
 * and either omit the link or say plainly that the app isn't live yet -- never render a link that
 * goes nowhere. Flipping this to `true` (with `PUBLIC_APP_ORIGIN` pointing at the real deployment)
 * is the entire cutover: no template changes, no new build.
 */
export const APP_IS_LIVE = readBoolean(
  import.meta.env.PUBLIC_APP_IS_LIVE,
  false,
  'PUBLIC_APP_IS_LIVE',
);

/**
 * The single label every link to the app uses, on the header, the hero, and the pricing card
 * alike, whenever `APP_IS_LIVE` is true. The owner asked for "Dashboard" when signed in and "Sign
 * in" otherwise; doing that from a static site would mean either a credentialed cross-origin
 * request to the API or a non-sensitive session-hint cookie read client-side, and the owner chose
 * neither -- see the note on `APP_ORIGIN` above. One neutral label sidesteps the question
 * entirely: the app itself already routes a visitor to sign-in or to their dashboard depending on
 * session state, so this label is never wrong and this site never needs to know which one applies.
 */
export const APP_LINK_LABEL = 'Open app';

/** This site's own canonical origin, used for `<link rel="canonical">` and OpenGraph URLs. */
export const SITE_URL = readOrigin(
  import.meta.env.PUBLIC_SITE_URL,
  'http://localhost:4321',
  'PUBLIC_SITE_URL',
);

export interface Price {
  /** Smallest currency unit (cents for USD), matching Stripe's own convention. */
  amount: number;
  currency: 'usd';
  interval: 'month' | 'year';
}

// The owner's example figures (plan.md, "Open commercial decisions"): $5/month or $50/year,
// exclusive of tax -- Stripe Tax adds the applicable amount at checkout (plan.md, "Tax"). These
// are not yet live Stripe Price objects; they are what this page is instructed to display.
export const PRICE_MONTHLY: Price = { amount: 500, currency: 'usd', interval: 'month' };
export const PRICE_ANNUAL: Price = { amount: 5000, currency: 'usd', interval: 'year' };

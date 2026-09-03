/**
 * Navigates the whole browser tab to an external URL -- used only for the two Stripe-hosted
 * redirects this slice adds: Checkout (upgradeDialog.tsx) and the Customer Portal (the account
 * menu's "Manage billing", routes/projects/index.tsx). Kept as its own tiny module rather than
 * assigning `window.location.href` inline at each call site, the same pattern docxDownload.ts and
 * fdxDownload.ts already use for a browser side effect this codebase's tests need to intercept:
 * jsdom (this project's test environment) does not implement real navigation, so every test that
 * exercises a redirect mocks this module directly instead of asserting on `window.location`.
 */
export function redirectToExternalUrl(url: string): void {
  window.location.href = url;
}

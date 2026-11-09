/**
 * The build identifier the Help menu's "Send feedback" attaches to every report
 * (`feedbackDialog.tsx`, sent as `context.appVersion` -- `apps/api/src/feedback.ts`'s
 * `feedbackContextInput` requires a non-empty string and rejects anything longer than
 * `FEEDBACK_APP_VERSION_MAX_LENGTH`, a bound a 40-character SHA or the 3-character `'dev'`
 * fallback both clear with enormous headroom).
 *
 * `__APP_VERSION__` is a Vite `define` (`vite.config.ts`'s `resolveAppVersion`), substituted at
 * build time with the git commit SHA checked out when the bundle was built, or `'dev'` when one
 * could not be read -- see that function's own comment for why the SHA, and for why nothing about
 * reading it may fail the build. This module is the one place that identifier is read back out,
 * so every caller gets the exact same string rather than each reaching for the bare global
 * independently.
 */
export const APP_VERSION: string = __APP_VERSION__;

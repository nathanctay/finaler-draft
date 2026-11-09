import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The value `build-version.txt` ships with, and the answer when nothing better is available.
 *
 * Kept as a real sentinel rather than an empty string so that a build which could not identify
 * itself says so honestly in a feedback report, instead of sending a blank the server's
 * `feedbackContextInput` would reject outright (`appVersion` requires a non-empty string).
 */
export const UNKNOWN_BUILD_VERSION = 'dev';

export interface BuildVersionSources {
  /** `process.env` at build time. */
  readonly env: Record<string, string | undefined>;
  /** Reads `build-version.txt`; throws when it does not exist. */
  readonly readVersionFile: () => string;
  /** `git rev-parse HEAD` in the checkout; throws when git or `.git` is unavailable. */
  readonly readGitSha: () => string;
}

/**
 * Resolves the identity baked into the bundle as `__APP_VERSION__`, which Help > Send feedback
 * attaches to every report so a report maps back to the code that produced it.
 *
 * **Why this is not simply `git rev-parse HEAD`**, which is what it was first written as: Railway
 * builds from an uploaded *snapshot*, not a git clone -- its own deploy log reads "fetched
 * snapshot" then "unpacking archive" -- so the build container has no `.git` directory and no git
 * binary to run against it. The git call therefore failed on every production build and the
 * fallback took over, which is exactly what it was designed to do: the build never broke. But it
 * meant the deployed bundle carried `appVersion: "dev"`, verified by fetching the live chunk from
 * production, so every report would have identified itself as an unidentifiable build. The
 * mechanism worked perfectly and the feature it existed for did not.
 *
 * Order, most authoritative first:
 *
 *  1. `APP_VERSION` in the environment -- an explicit override, and the seam a test can drive.
 *  2. `build-version.txt`, a **tracked** file whose committed contents are always the sentinel.
 *     The deploy workflow overwrites it with the commit SHA immediately before `railway up`, so
 *     the real value travels to Railway as part of the source itself. Tracked deliberately rather
 *     than generated-and-gitignored: Railway's CLI docs promise only that `up` "compresses and
 *     uploads the current directory" without specifying how it treats ignored files, and a
 *     mechanism that silently degrades to the sentinel if that behaviour ever changed is the exact
 *     failure being fixed here. A tracked file is part of the source by definition.
 *  3. `git rev-parse HEAD` -- the right answer for a developer's own `pnpm build`, where git is
 *     present and the file still holds its sentinel.
 *  4. The sentinel.
 *
 * Every source is tried in a way that cannot fail the build. A build must never break over a
 * feedback report's own metadata.
 */
export function resolveBuildVersion(sources: BuildVersionSources): string {
  const fromEnv = sources.env.APP_VERSION?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const fromFile = sources.readVersionFile().trim();
    if (fromFile && fromFile !== UNKNOWN_BUILD_VERSION) {
      return fromFile;
    }
  } catch {
    // No file, or unreadable: fall through to git.
  }

  try {
    const fromGit = sources.readGitSha().trim();
    if (fromGit) {
      return fromGit;
    }
  } catch {
    // No git binary, no `.git`, or a shallow clone with no HEAD: fall through to the sentinel.
  }

  return UNKNOWN_BUILD_VERSION;
}

/** The production wiring of {@link resolveBuildVersion}, used by `vite.config.ts`. */
export function resolveBuildVersionFromDisk(directory: string): string {
  return resolveBuildVersion({
    env: process.env,
    readGitSha: () =>
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: directory,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString(),
    readVersionFile: () => readFileSync(`${directory}/build-version.txt`, 'utf8'),
  });
}

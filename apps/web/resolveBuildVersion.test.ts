import { describe, expect, it } from 'vitest';
import {
  resolveBuildVersion,
  UNKNOWN_BUILD_VERSION,
  type BuildVersionSources,
} from './resolveBuildVersion.js';

const SHA = '1111111111111111111111111111111111111111';
const OTHER_SHA = '2222222222222222222222222222222222222222';

function sources(overrides: Partial<BuildVersionSources> = {}): BuildVersionSources {
  return {
    env: {},
    readGitSha: () => {
      throw new Error('no git');
    },
    readVersionFile: () => {
      throw new Error('no file');
    },
    ...overrides,
  };
}

describe('resolveBuildVersion', () => {
  it('prefers APP_VERSION from the environment over every other source', () => {
    expect(
      resolveBuildVersion(
        sources({
          env: { APP_VERSION: SHA },
          readGitSha: () => OTHER_SHA,
          readVersionFile: () => OTHER_SHA,
        }),
      ),
    ).toBe(SHA);
  });

  /*
   * The production path: Railway's build container has no `.git`, so git throws and the tracked
   * file -- overwritten by the deploy workflow immediately before `railway up` -- is what carries
   * the real SHA into the bundle. This is the case that was broken, and it is the reason the file
   * exists at all.
   */
  it('uses the tracked version file when git is unavailable, which is the Railway build', () => {
    expect(resolveBuildVersion(sources({ readVersionFile: () => `${SHA}\n` }))).toBe(SHA);
  });

  it('ignores the version file while it still holds its committed sentinel, and asks git instead', () => {
    expect(
      resolveBuildVersion(
        sources({ readGitSha: () => SHA, readVersionFile: () => `${UNKNOWN_BUILD_VERSION}\n` }),
      ),
    ).toBe(SHA);
  });

  it('falls back to git for a developer build, where the file is absent or unchanged', () => {
    expect(resolveBuildVersion(sources({ readGitSha: () => `${SHA}\n` }))).toBe(SHA);
  });

  /*
   * Every one of these must degrade rather than throw. A build must never fail over a feedback
   * report's own metadata -- that was true of the original implementation and is the one property
   * worth keeping from it.
   */
  it.each([
    ['nothing available at all', sources()],
    ['an empty APP_VERSION', sources({ env: { APP_VERSION: '   ' } })],
    ['an empty version file and no git', sources({ readVersionFile: () => '\n' })],
    ['empty git output', sources({ readGitSha: () => '\n' })],
  ])('returns the sentinel for %s, never throwing', (_label, given) => {
    expect(resolveBuildVersion(given)).toBe(UNKNOWN_BUILD_VERSION);
  });

  /*
   * Proves the sentinel is not simply what this function always returns -- without this, every
   * assertion above could pass against an implementation that ignored its inputs entirely.
   */
  it('does resolve a real value when one is available, so the sentinel cases are not vacuous', () => {
    expect(resolveBuildVersion(sources({ env: { APP_VERSION: SHA } }))).not.toBe(
      UNKNOWN_BUILD_VERSION,
    );
  });
});

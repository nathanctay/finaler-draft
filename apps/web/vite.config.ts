import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The Help menu's "Send feedback" needs a non-empty `appVersion` to send with every report
 * (`apps/api/src/feedback.ts`'s `feedbackContextInput`), and nothing in this app had one:
 * `apps/web/package.json` is pinned at `"0.0.0"` and was never bumped, so it carries no real
 * per-build identity. The git commit SHA does: it is unique per build, already exists for free,
 * and -- unlike a package version a human has to remember to bump -- it is exactly what maps a
 * report back to the code that produced it, which is the whole point of attaching this
 * automatically rather than asking the writer to describe their build.
 *
 * Read here, at config-evaluation time, and inlined everywhere it is referenced
 * (`appVersion.ts`'s `__APP_VERSION__`) via Vite's `define` -- the identical mechanism
 * `collabConfig.ts`'s own top comment explains for `import.meta.env`, chosen over an environment
 * variable for the same reason: this is a build-time identity, not a per-deployment setting, and
 * `define` is a textual substitution resolved once, here, rather than a value every running
 * process would otherwise have to agree on reading the same way.
 *
 * Deliberately tolerant of every way this can go wrong in a build environment that is not a
 * developer's own checkout: no `git` binary on `PATH`, a shallow clone with no `HEAD` object, a
 * build running from an extracted tarball with no `.git` directory at all. None of those are
 * reasons to fail the build over a feedback report's own metadata -- `'dev'` is a value the server
 * accepts (`feedbackContextInput`'s `appVersion` only requires a non-empty string) and is honest
 * about what it is: a build this function could not identify. A dirty working tree is not handled
 * specially and does not need to be: `git rev-parse HEAD` reports the commit checked out
 * regardless of uncommitted changes on top of it, which remains the most useful answer this
 * function can give without shelling out a second, slower `git status` on every single build.
 */
function resolveAppVersion(): string {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: import.meta.dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return sha.length > 0 ? sha : 'dev';
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion()),
  },
  plugins: [
    // Colocated tests live beside their route modules, so the generator must not treat
    // them as routes. Automatic code splitting moves each route's component into a lazy
    // chunk, which leaves `Route.options.component` unrenderable under test; it stays on
    // for real builds and off under Vitest so tests exercise the component directly.
    tanstackRouter({
      autoCodeSplitting: !process.env.VITEST,
      routeFileIgnorePattern: '\\.(test|spec)\\.[jt]sx?$',
      target: 'react',
    }),
    react(),
  ],
  server: { proxy: { '/api': 'http://localhost:3001' } },
  build: {
    // Consumed by scripts/check-bundle-budget.mjs to map each built chunk back to the source
    // file that produced it -- filenames are content-hashed, so classifying "entry" vs. "lazy
    // editor chunk" by name is not reliable; the manifest is.
    manifest: true,
  },
  test: {
    environment: 'jsdom',
    fileParallelism: false,
    exclude: [...configDefaults.exclude, 'e2e/**'],
    setupFiles: './src/test/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      thresholds: { perFile: true, lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});

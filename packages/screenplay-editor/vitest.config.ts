import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude],
    // See src/test/setup.ts's own doc comment: a jsdom gap `presence.test.ts`'s
    // `editor.commands.focus('end')` call is the first test in this package to reach, copied
    // (not shared) from `apps/web/src/test/setup.ts`, which found and fixed the identical gap
    // first.
    setupFiles: './src/test/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      // `src/test/**` alongside the existing test-file exclusion: a jsdom polyfill, not this
      // package's own logic, and its two `if (!...)` branches are only ever exercised the one way
      // jsdom 26.1.0 actually behaves (never implemented), so real branch coverage of "jsdom
      // already provides this" is not obtainable here without faking a jsdom version this package
      // does not otherwise depend on.
      exclude: ['src/**/*.test.ts', 'src/test/**'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});

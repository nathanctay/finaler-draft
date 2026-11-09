import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { configDefaults, defineConfig } from 'vitest/config';
import { resolveBuildVersionFromDisk } from './resolveBuildVersion.js';

export default defineConfig({
  define: {
    /*
     * The identity Help > Send feedback attaches to every report. Resolved by
     * `resolveBuildVersion.ts`, which documents why this is not a bare `git rev-parse`: Railway
     * builds an uploaded snapshot with no `.git`, so git alone silently yielded `"dev"` in every
     * production bundle -- confirmed by fetching the live chunk.
     */
    __APP_VERSION__: JSON.stringify(resolveBuildVersionFromDisk(import.meta.dirname)),
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

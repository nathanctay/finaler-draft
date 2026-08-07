import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
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

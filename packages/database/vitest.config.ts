import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'scripts/environment.mjs',
        'src/revisions.ts',
        // The screenplay-invitations slice's shared membership resolution -- the one definition of
        // "what role does this actor hold on this screenplay", which every authorization path in
        // both services depends on. Covered by `membership.test.ts` with no database.
        'src/membership.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/authenticate.ts',
        'src/database.ts',
        'src/presence.ts',
        'src/updateLog.ts',
        'src/quarantine.ts',
        'src/revisions.ts',
        // Collaboration slice 5's restore listener and document-superseding logic, both unit-tested
        // against stubs in `restoreNotifications.test.ts` with no database and no sockets.
        'src/restoreNotifications.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});

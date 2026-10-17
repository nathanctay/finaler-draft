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
        // The screenplay-invitations slice's membership-change listener and the connection-closing
        // logic it drives, unit-tested against stubs in `membershipNotifications.test.ts` with no
        // database and no sockets -- the same way `restoreNotifications.ts` above is.
        'src/membershipNotifications.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/app.ts',
        'src/auth.ts',
        'src/projects.ts',
        'src/revisions.ts',
        // Collaboration slice 5's policy layer (authorization, entitlement, confirmation) --
        // `restore.test.ts` covers it against a mocked `@finaler-draft/database`, the same way
        // `revisions.test.ts` covers `revisions.ts`.
        'src/restore.ts',
        // The screenplay-invitations slice: the invitations/membership store and the notification
        // email it sends. `sharing.test.ts` covers the store against a fake pool the same way
        // `projects.test.ts` covers `projects.ts`; `invitationMail.test.ts` covers the message.
        'src/sharing.ts',
        'src/invitationMail.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});

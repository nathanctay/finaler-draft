import type { MigrationCheckResult } from './migrationCheck.js';

/**
 * The exact command a developer runs to fix a pending migration -- quoted here once, so the
 * message and this module's own tests stay in sync with each other by construction rather than by
 * two people remembering to update both.
 */
export const MIGRATE_COMMAND = 'pnpm --filter @finaler-draft/database db:migrate';

/**
 * Formats `checkMigrations`'s result into the message a developer actually sees. This is the
 * deliverable this whole check exists for: each incident in the project's history that led to
 * building it was expensive not because the underlying problem was hard, but because nothing said
 * what was wrong in a form that could be acted on in the time it takes to read it. Every branch
 * below says what is wrong and, where there is one, the exact command to fix it -- in a form that
 * can be pasted, not paraphrased.
 */
export function formatMigrationCheckMessage(result: MigrationCheckResult): string {
  if (result.ok) return 'Database schema is up to date.';

  switch (result.reason) {
    case 'behind':
      return [
        'Database schema is behind this checkout.',
        '',
        `Pending migration${result.pending.length === 1 ? '' : 's'}:`,
        ...result.pending.map((tag) => `  - ${tag}`),
        '',
        'Run:',
        '',
        `  ${MIGRATE_COMMAND}`,
        '',
        'then restart `pnpm dev`.',
      ].join('\n');

    case 'ahead':
      return [
        "Database schema is ahead of this checkout's migration journal.",
        '',
        `The database has applied ${result.extraAppliedCount} more migration` +
          `${result.extraAppliedCount === 1 ? '' : 's'} than this checkout's journal on disk lists.`,
        'This usually means DATABASE_URL points at a database migrated from a different branch or',
        'commit than the one you are on, or at the wrong database entirely.',
        '',
        'Check which branch/commit last migrated it, or confirm DATABASE_URL is pointing where you',
        'expect.',
      ].join('\n');

    case 'diverged':
      return [
        "Database schema has diverged from this checkout's migration journal.",
        '',
        `Migration ${result.journalTag} does not match the database's own record of it (same`,
        'position, different content). This is not an ordinary pending migration -- do not run',
        'db:migrate without investigating first.',
        '',
        'This can happen if an already-applied migration file was edited after the fact, or if',
        'migrations were reordered or squashed. Compare',
        `packages/database/drizzle/${result.journalTag}.sql against what is recorded in`,
        'drizzle.__drizzle_migrations before proceeding.',
      ].join('\n');

    case 'unreachable':
      return [
        'Cannot reach the database.',
        '',
        `DATABASE_URL points at a database this process could not connect to: ${result.detail}`,
        '',
        'This is not a migration problem -- start Postgres (or fix DATABASE_URL) and try again.',
      ].join('\n');

    case 'queryFailed':
      return [
        "Could not determine the database's migration state.",
        '',
        result.detail,
        '',
        'This is not clearly a missing migration or an unreachable database -- investigate the',
        'error above directly.',
      ].join('\n');
  }
}

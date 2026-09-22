import { describe, expect, it } from 'vitest';
import { formatMigrationCheckMessage, MIGRATE_COMMAND } from './migrationCheckMessage.js';

describe('formatMigrationCheckMessage', () => {
  it('confirms an up-to-date database briefly', () => {
    expect(formatMigrationCheckMessage({ ok: true })).toBe('Database schema is up to date.');
  });

  it('names every pending migration and the exact command to fix it', () => {
    const message = formatMigrationCheckMessage({
      ok: false,
      reason: 'behind',
      pending: ['0006_remove_screenplay_version_add_document_yjs_state'],
    });

    expect(message).toContain('0006_remove_screenplay_version_add_document_yjs_state');
    expect(message).toContain(MIGRATE_COMMAND);
    // The paste target is the bare command, not a sentence containing it -- assert it appears on
    // its own line, which is what a developer actually copies.
    expect(message.split('\n')).toContain(`  ${MIGRATE_COMMAND}`);
  });

  it('lists more than one pending migration in journal order', () => {
    const message = formatMigrationCheckMessage({
      ok: false,
      reason: 'behind',
      pending: ['0005_whole_toxin', '0006_remove_screenplay_version_add_document_yjs_state'],
    });

    const lines = message.split('\n');
    expect(lines.indexOf('  - 0005_whole_toxin')).toBeLessThan(
      lines.indexOf('  - 0006_remove_screenplay_version_add_document_yjs_state'),
    );
  });

  it('never mentions db:migrate for an unreachable database, and never leaks DATABASE_URL', () => {
    const message = formatMigrationCheckMessage({
      ok: false,
      reason: 'unreachable',
      detail: 'connect ECONNREFUSED 127.0.0.1:5432',
    });

    expect(message).not.toContain(MIGRATE_COMMAND);
    expect(message.toLowerCase()).not.toContain('postgresql://');
    expect(message).toContain('ECONNREFUSED');
  });

  it('never mentions db:migrate for a query failure unrelated to schema state', () => {
    const message = formatMigrationCheckMessage({
      ok: false,
      reason: 'queryFailed',
      detail: 'password authentication failed for user "postgres"',
    });

    expect(message).not.toContain(MIGRATE_COMMAND);
    expect(message).toContain('password authentication failed');
  });

  it('names the diverged migration and points at the file to compare, without suggesting db:migrate', () => {
    const message = formatMigrationCheckMessage({
      ok: false,
      reason: 'diverged',
      atIndex: 1,
      journalTag: '0003_backfill_email_verified',
    });

    expect(message).toContain('0003_backfill_email_verified');
    expect(message).toContain('packages/database/drizzle/0003_backfill_email_verified.sql');
    expect(message).not.toContain(MIGRATE_COMMAND);
  });

  it('explains an ahead database without suggesting db:migrate', () => {
    const message = formatMigrationCheckMessage({
      ok: false,
      reason: 'ahead',
      extraAppliedCount: 2,
    });

    expect(message).toContain('2 more migrations');
    expect(message).not.toContain(MIGRATE_COMMAND);
  });
});

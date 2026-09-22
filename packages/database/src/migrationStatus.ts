/**
 * Pure comparison between the migrations this checkout's journal declares
 * (`packages/database/drizzle/meta/_journal.json`, plus the content of each numbered `.sql` file
 * it lists) and the migrations a database has actually recorded as applied
 * (`drizzle.__drizzle_migrations`, the bookkeeping table drizzle-orm's own migrator writes to --
 * see `migrationCheck.ts` for how each side is actually read).
 *
 * Deliberately no I/O here -- no filesystem, no database -- so this is unit-testable on its own,
 * and reading this file alone tells you exactly what "behind" means without also having to reason
 * about a live database or a JSON file's layout. If this stops being true (some future change
 * needs a database handle to decide the comparison), that is a sign the change belongs in
 * `migrationCheck.ts` instead, not here.
 */

export interface JournalMigration {
  readonly tag: string;
  readonly hash: string;
}

export interface AppliedMigration {
  readonly hash: string;
}

export type MigrationComparison =
  | { readonly kind: 'upToDate' }
  | { readonly kind: 'behind'; readonly pending: readonly string[] }
  | { readonly kind: 'ahead'; readonly extraAppliedCount: number }
  | { readonly kind: 'diverged'; readonly atIndex: number; readonly journalTag: string };

/**
 * A plain length comparison ("7 migrations on disk, 6 applied") is the obvious first idea, and
 * the easiest to fool: it says nothing about whether the applied migrations are the *same*
 * migrations, in the *same* order, as the journal's own. Two concrete ways that bites:
 *
 *  - An already-applied migration file gets edited after the fact (a typo fix, a "cleanup" of old
 *    SQL). The count on both sides is unchanged, so a count comparison reports "current" while
 *    the database's actual applied history no longer matches what's on disk.
 *  - Migrations get squashed or renumbered (combining two old files into one, or reordering).
 *    The on-disk count can shift in a way that coincidentally still equals the applied count,
 *    again reporting "current" for a database that was never migrated with this exact history.
 *
 * This compares by content hash instead -- the identical sha256-of-raw-file-contents drizzle-orm's
 * own migrator computes for each migration it applies and stores in `__drizzle_migrations.hash`
 * (`readJournalMigrations` in `migrationCheck.ts` reproduces that same computation) -- position by
 * position, for as much of the two lists as overlap. Only once every overlapping entry matches
 * byte-for-byte does the remaining length difference decide `upToDate` / `behind` / `ahead`. A
 * mismatch inside the overlap is reported as `diverged` rather than folded into `behind` or
 * `ahead`: it means the database's applied history and this checkout's journal disagree about
 * something that already happened, which a pending-migration count could never distinguish from
 * an ordinary "just run db:migrate" case -- and blindly running migrations against a diverged
 * history is exactly the kind of silent, unreviewed schema change this check exists to prevent.
 */
export function compareMigrationState(
  journal: readonly JournalMigration[],
  applied: readonly AppliedMigration[],
): MigrationComparison {
  const overlap = Math.min(journal.length, applied.length);
  for (const [index, journalEntry] of journal.entries()) {
    if (index >= overlap) break;
    const appliedEntry = applied[index];
    if (!appliedEntry || appliedEntry.hash !== journalEntry.hash) {
      return { kind: 'diverged', atIndex: index, journalTag: journalEntry.tag };
    }
  }
  if (journal.length === applied.length) return { kind: 'upToDate' };
  if (journal.length > applied.length) {
    return { kind: 'behind', pending: journal.slice(applied.length).map((entry) => entry.tag) };
  }
  return { kind: 'ahead', extraAppliedCount: applied.length - journal.length };
}

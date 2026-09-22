import { describe, expect, it } from 'vitest';
import {
  compareMigrationState,
  type AppliedMigration,
  type JournalMigration,
} from './migrationStatus.js';

const journalOf = (...entries: Array<[tag: string, hash: string]>): JournalMigration[] =>
  entries.map(([tag, hash]) => ({ tag, hash }));

const appliedOf = (...hashes: string[]): AppliedMigration[] => hashes.map((hash) => ({ hash }));

describe('compareMigrationState', () => {
  it('reports upToDate when the applied history exactly matches the journal', () => {
    const journal = journalOf(['0000_a', 'hash-a'], ['0001_b', 'hash-b']);
    const applied = appliedOf('hash-a', 'hash-b');

    expect(compareMigrationState(journal, applied)).toEqual({ kind: 'upToDate' });
  });

  it('reports upToDate when neither side has any migrations', () => {
    expect(compareMigrationState([], [])).toEqual({ kind: 'upToDate' });
  });

  it('reports behind, naming every migration on disk that has not been applied', () => {
    const journal = journalOf(['0000_a', 'hash-a'], ['0001_b', 'hash-b'], ['0002_c', 'hash-c']);
    const applied = appliedOf('hash-a');

    expect(compareMigrationState(journal, applied)).toEqual({
      kind: 'behind',
      pending: ['0001_b', '0002_c'],
    });
  });

  it('reports behind by exactly one migration -- the real-world case this check exists for', () => {
    const journal = journalOf(['0000_a', 'hash-a'], ['0001_b', 'hash-b']);
    const applied = appliedOf('hash-a');

    expect(compareMigrationState(journal, applied)).toEqual({
      kind: 'behind',
      pending: ['0001_b'],
    });
  });

  it('reports ahead when the database has more applied migrations than the journal lists', () => {
    const journal = journalOf(['0000_a', 'hash-a']);
    const applied = appliedOf('hash-a', 'hash-b', 'hash-c');

    expect(compareMigrationState(journal, applied)).toEqual({
      kind: 'ahead',
      extraAppliedCount: 2,
    });
  });

  it('reports diverged when an overlapping entry does not match by content hash', () => {
    const journal = journalOf(['0000_a', 'hash-a'], ['0001_b', 'hash-b-edited']);
    const applied = appliedOf('hash-a', 'hash-b-original');

    expect(compareMigrationState(journal, applied)).toEqual({
      kind: 'diverged',
      atIndex: 1,
      journalTag: '0001_b',
    });
  });

  it('reports diverged at the first mismatching index, not fooled by equal counts', () => {
    // Same length on both sides -- a plain count comparison would call this "upToDate". Content
    // still differs at index 0, which is exactly the case a count comparison cannot catch.
    const journal = journalOf(['0000_a', 'hash-a'], ['0001_b', 'hash-b']);
    const applied = appliedOf('hash-a-different', 'hash-b');

    expect(compareMigrationState(journal, applied)).toEqual({
      kind: 'diverged',
      atIndex: 0,
      journalTag: '0000_a',
    });
  });

  it('reports diverged rather than ahead when a mismatch precedes extra applied rows', () => {
    const journal = journalOf(['0000_a', 'hash-a']);
    const applied = appliedOf('hash-a-different', 'hash-extra');

    expect(compareMigrationState(journal, applied)).toEqual({
      kind: 'diverged',
      atIndex: 0,
      journalTag: '0000_a',
    });
  });
});

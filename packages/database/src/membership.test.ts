import { describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_CHANGED_NOTIFY_CHANNEL,
  parseMembershipChangedNotification,
  roleCanEdit,
  roleIsOwner,
  ROLE_PRECEDENCE_SQL,
  screenplayRoleLateral,
} from './membership.js';

/**
 * `screenplayRoleLateral` produces SQL text, so what can be asserted here is its *shape* -- that it
 * reads both membership tables, that it ranks them by the written-out precedence rather than by
 * either Postgres enum's declaration order, and that it interpolates only the alias and placeholder
 * it was given. What the SQL actually resolves to against real rows is proven where it has to be:
 * `apps/api/src/sharing.integration.test.ts` (every REST path, both kinds of membership) and
 * `apps/collab/src/collaboration.integration.test.ts` (the socket), both against a real migrated
 * database. These tests exist to catch the fragment being changed in a way those suites would not
 * obviously attribute to this file.
 */
describe('screenplayRoleLateral', () => {
  it('resolves a role from both membership tables, not just project membership', () => {
    const sql = screenplayRoleLateral('$2');
    expect(sql).toContain('from project_members pm');
    expect(sql).toContain('from screenplay_members sm');
    expect(sql).toContain('union all');
  });

  it('correlates project membership on the project and screenplay membership on the screenplay', () => {
    // The single most important detail of the fragment: a screenplay-scoped row must be matched on
    // `sm.screenplay_id = s.id`, never on the project. Matching it on the project would make a
    // screenplay-scoped member a member of every sibling screenplay -- the exact privilege gap the
    // separate-table modelling choice exists to prevent.
    const sql = screenplayRoleLateral('$2');
    expect(sql).toContain('pm.project_id = s.project_id');
    expect(sql).toContain('sm.screenplay_id = s.id');
    expect(sql).not.toContain('sm.project_id');
  });

  it('filters both branches by the actor placeholder it was given, and nothing else', () => {
    const sql = screenplayRoleLateral('$7');
    expect(sql).toContain('pm.user_id = $7');
    expect(sql).toContain('sm.user_id = $7');
    // Two occurrences and no more: a branch that forgot its actor predicate would resolve a role
    // for whoever happened to be a member, which is not a narrower bug than the one above.
    expect(sql.match(/\$7/g)).toHaveLength(2);
  });

  it('honours a caller-supplied screenplay alias on both correlations', () => {
    const sql = screenplayRoleLateral('$1', 'sp');
    expect(sql).toContain('pm.project_id = sp.project_id');
    expect(sql).toContain('sm.screenplay_id = sp.id');
    expect(sql).not.toContain(' s.project_id');
  });

  it('ranks by the written-out precedence, and casts both enums to text so the union is possible', () => {
    const sql = screenplayRoleLateral('$2');
    expect(sql).toContain(ROLE_PRECEDENCE_SQL);
    expect(sql).toContain('pm.role::text');
    expect(sql).toContain('sm.role::text');
    expect(sql).toContain('limit 1');
  });

  it('orders owner ahead of editor ahead of reviewer', () => {
    // Asserted on the expression rather than through a database, because this is the one place the
    // precedence is written down -- `alreadyCovers` (apps/api/src/sharing.ts) ranks the same three
    // roles for "they already have this", and the two disagreeing would mean an invitation reported
    // as redundant that would in fact have granted something.
    expect(ROLE_PRECEDENCE_SQL).toBe(
      "case candidates.role when 'owner' then 0 when 'editor' then 1 else 2 end",
    );
  });
});

describe('roleCanEdit', () => {
  it('admits owner and editor, from either membership table', () => {
    expect(roleCanEdit('owner')).toBe(true);
    expect(roleCanEdit('editor')).toBe(true);
  });

  it('refuses a reviewer, and anything that is not a role at all', () => {
    expect(roleCanEdit('reviewer')).toBe(false);
    expect(roleCanEdit(undefined)).toBe(false);
    expect(roleCanEdit(null)).toBe(false);
    expect(roleCanEdit('')).toBe(false);
    expect(roleCanEdit('OWNER')).toBe(false);
  });
});

describe('roleIsOwner', () => {
  it('admits only owner', () => {
    expect(roleIsOwner('owner')).toBe(true);
  });

  it('refuses editor, reviewer, and anything that is not a role at all', () => {
    // Editor is the case that matters most: this is the predicate the owner-only-rename slice
    // introduced specifically to stop an editor from reaching rename/delete/restore, which
    // `roleCanEdit` alone would still admit.
    expect(roleIsOwner('editor')).toBe(false);
    expect(roleIsOwner('reviewer')).toBe(false);
    expect(roleIsOwner(undefined)).toBe(false);
    expect(roleIsOwner(null)).toBe(false);
    expect(roleIsOwner('')).toBe(false);
    expect(roleIsOwner('OWNER')).toBe(false);
  });
});

describe('parseMembershipChangedNotification', () => {
  it('names the channel apps/api notifies on and apps/collab listens to', () => {
    // A constant test, deliberately: the two services agree on this string and nothing else, so a
    // rename on one side without the other is a silent failure in which removals stop reaching live
    // connections. This is the cheapest possible guard against that.
    expect(MEMBERSHIP_CHANGED_NOTIFY_CHANNEL).toBe('membership_changed');
  });

  it('parses a well-formed payload', () => {
    expect(parseMembershipChangedNotification(JSON.stringify({ userId: 'user-1' }))).toEqual({
      userId: 'user-1',
    });
  });

  it('ignores extra fields rather than rejecting the notification', () => {
    expect(
      parseMembershipChangedNotification(JSON.stringify({ userId: 'user-1', extra: true })),
    ).toEqual({ userId: 'user-1' });
  });

  it('returns undefined for anything that is not a membership notification', () => {
    // A notification payload is a string arriving from outside the listening process, so each of
    // these must be a quiet `undefined` rather than a throw -- a listener that threw here would
    // turn a malformed payload into a crash loop that takes the whole collaboration server with it.
    for (const payload of [
      undefined,
      '',
      'not json',
      'null',
      '[]',
      '"user-1"',
      '42',
      JSON.stringify({}),
      JSON.stringify({ userId: '' }),
      JSON.stringify({ userId: 42 }),
      JSON.stringify({ userId: null }),
      JSON.stringify({ user_id: 'user-1' }),
    ]) {
      expect(parseMembershipChangedNotification(payload)).toBeUndefined();
    }
  });
});

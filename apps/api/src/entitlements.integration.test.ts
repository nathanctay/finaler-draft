import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEntitlementEnforcedProjectStore } from './entitlementProjectStore.js';
import { EntitlementLimitError } from './entitlements.js';
import { createPostgresEntitlementStore, type EntitlementStore } from './entitlementStore.js';
import { createPostgresProjectStore, type ProjectStore } from './projects.js';
import { createPostgresSubscriptionStore } from './stripeSubscriptions.js';

// Follows persistence.integration.test.ts's and stripeSubscriptions.integration.test.ts's pattern
// exactly: a fresh, throwaway database per suite run, migrated with the project's own tooling,
// torn down afterward. Skips entirely without TEST_DATABASE_URL, which is expected outside CI/a
// developer who has opted in.
const adminUrl = process.env.TEST_DATABASE_URL;
const executeFile = promisify(execFile);
const databaseName = `finaler_draft_test_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = adminUrl ? databaseUrlFor(adminUrl, databaseName) : undefined;
let admin: Pool | undefined;
let pool: Pool | undefined;
let baseStore: ProjectStore | undefined;
let entitlements: EntitlementStore | undefined;
let store: ProjectStore | undefined;
let databaseCreated = false;
let userSequence = 0;

describe.skipIf(!databaseUrl)('Entitlement enforcement (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl });
    await admin.query(`create database ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await runMigrations();

    pool = new Pool({ connectionString: databaseUrl });
    baseStore = createPostgresProjectStore(pool);
    entitlements = createPostgresEntitlementStore(pool, createPostgresSubscriptionStore(pool));
    store = createEntitlementEnforcedProjectStore(baseStore, entitlements);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [databaseName],
      );
      await admin.query(`drop database if exists ${quoteIdentifier(databaseName)}`);
    }
    await admin?.end();
  });

  it('migrates the editable_slots table with the expected shape', async () => {
    const columns = await pool!.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'editable_slots'",
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['user_id', 'screenplay_id', 'updated_at']),
    );
    const foreignKeys = await pool!.query<{ constraint_name: string }>(
      `select constraint_name from information_schema.table_constraints
        where table_name = 'editable_slots' and constraint_type = 'FOREIGN KEY'`,
    );
    expect(foreignKeys.rows.length).toBe(2);
  });

  it('free tier: creates a first screenplay and automatically claims it as the editable slot', async () => {
    const owner = await createUser();
    const project = await baseStore!.createProject(owner, 'Solo project');

    const created = await store!.createScreenplay(owner, project.id, {
      title: 'First script',
      screenplay: screenplayFixture,
    });

    const snapshot = await entitlements!.getSnapshot(owner, new Date());
    expect(snapshot.subscriptionStatus).toBeUndefined();
    expect(snapshot.candidateScreenplayIds).toEqual([created.id]);
    expect(snapshot.slot).toMatchObject({ screenplayId: created.id });
  });

  it('free tier: a second screenplay cannot be created once the slot is occupied', async () => {
    const owner = await createUser();
    const project = await baseStore!.createProject(owner, 'Project A');
    await store!.createScreenplay(owner, project.id, {
      title: 'First script',
      screenplay: screenplayFixture,
    });
    const secondProject = await baseStore!.createProject(owner, 'Project B');

    await expect(
      store!.createScreenplay(owner, secondProject.id, {
        title: 'Second script',
        screenplay: screenplayFixture,
      }),
    ).rejects.toBeInstanceOf(EntitlementLimitError);

    const screenplaysInSecondProject = await baseStore!.listScreenplays(owner, secondProject.id);
    expect(screenplaysInSecondProject).toEqual([]);
  });

  it('free tier: a screenplay outside the slot cannot be edited, but stays readable', async () => {
    const owner = await createUser();
    const collaborator = await createUser();
    const project = await baseStore!.createProject(owner, 'Shared project');
    const ownScreenplay = await store!.createScreenplay(owner, project.id, {
      title: "Collaborator's own script",
      screenplay: screenplayFixture,
    });
    // The collaborator already holds their own screenplay, occupying their slot.
    await store!.createScreenplay(
      collaborator,
      (await baseStore!.createProject(collaborator, 'Collaborator project')).id,
      { title: 'Collaborator script', screenplay: screenplayFixture },
    );
    // Sharing `ownScreenplay`'s project with the collaborator as an editor -- collaboration is not
    // a paid feature, but it still occupies the single slot, and this is beyond it.
    await pool!.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'editor')",
      [project.id, collaborator],
    );

    const loaded = await store!.getScreenplay(collaborator, ownScreenplay.id);
    expect(loaded).not.toBe('missing');

    const denied = await store!.updateScreenplay(collaborator, ownScreenplay.id, {
      expectedVersion: 1,
      screenplay: (loaded as { screenplay: typeof screenplayFixture }).screenplay,
    });
    expect(denied).toBe('forbidden');
  });

  it('lapsed with several screenplays and no choice made: cannot edit or create anything', async () => {
    const owner = await createUser();
    await markLapsed(owner);
    const project = await baseStore!.createProject(owner, 'Legacy project');
    // Created directly through the base store, standing in for screenplays this account made
    // while it was still paying (an active subscription lifts the create-screenplay gate
    // entirely -- see the paid-tier test below -- so this shortcut reaches the same end state a
    // real lapse would, without re-deriving that already-covered path here).
    const first = await baseStore!.createScreenplay(owner, project.id, {
      title: 'Legacy script one',
      screenplay: screenplayFixture,
    });
    const second = await baseStore!.createScreenplay(owner, project.id, {
      title: 'Legacy script two',
      screenplay: screenplayFixture,
    });

    const firstLoaded = await store!.getScreenplay(owner, first.id);
    const deniedFirst = await store!.updateScreenplay(owner, first.id, {
      expectedVersion: 1,
      screenplay: (firstLoaded as { screenplay: typeof screenplayFixture }).screenplay,
    });
    expect(deniedFirst).toBe('forbidden');

    const secondLoaded = await store!.getScreenplay(owner, second.id);
    const deniedSecond = await store!.updateScreenplay(owner, second.id, {
      expectedVersion: 1,
      screenplay: (secondLoaded as { screenplay: typeof screenplayFixture }).screenplay,
    });
    expect(deniedSecond).toBe('forbidden');

    await expect(
      store!.createScreenplay(owner, project.id, {
        title: 'Third script',
        screenplay: screenplayFixture,
      }),
    ).rejects.toBeInstanceOf(EntitlementLimitError);
  });

  it('lapsed after choosing: the chosen screenplay is editable, the other is not', async () => {
    const owner = await createUser();
    await markLapsed(owner);
    const project = await baseStore!.createProject(owner, 'Legacy project 2');
    const first = await baseStore!.createScreenplay(owner, project.id, {
      title: 'Keep this one',
      screenplay: screenplayFixture,
    });
    const second = await baseStore!.createScreenplay(owner, project.id, {
      title: 'Not this one',
      screenplay: screenplayFixture,
    });

    const choice = await entitlements!.switchEditableScreenplay(owner, first.id, new Date());
    expect(choice.outcome).toBe('applied');

    const firstLoaded = await store!.getScreenplay(owner, first.id);
    const allowed = await store!.updateScreenplay(owner, first.id, {
      expectedVersion: 1,
      screenplay: (firstLoaded as { screenplay: typeof screenplayFixture }).screenplay,
    });
    expect(allowed).toEqual({ version: 2 });

    const secondLoaded = await store!.getScreenplay(owner, second.id);
    const denied = await store!.updateScreenplay(owner, second.id, {
      expectedVersion: 1,
      screenplay: (secondLoaded as { screenplay: typeof screenplayFixture }).screenplay,
    });
    expect(denied).toBe('forbidden');
  });

  it('switching the slot is refused inside the cooldown window and allowed once it elapses', async () => {
    const owner = await createUser();
    await markLapsed(owner);
    const project = await baseStore!.createProject(owner, 'Legacy project 3');
    const first = await baseStore!.createScreenplay(owner, project.id, {
      title: 'First choice',
      screenplay: screenplayFixture,
    });
    const second = await baseStore!.createScreenplay(owner, project.id, {
      title: 'Second choice',
      screenplay: screenplayFixture,
    });
    const establishedAt = new Date('2026-01-01T00:00:00Z');
    const established = await entitlements!.switchEditableScreenplay(
      owner,
      first.id,
      establishedAt,
    );
    expect(established.outcome).toBe('applied');

    const tooSoon = await entitlements!.switchEditableScreenplay(
      owner,
      second.id,
      new Date(establishedAt.getTime() + 1000),
    );
    expect(tooSoon.outcome).toBe('cooldown');

    const later = await entitlements!.switchEditableScreenplay(
      owner,
      second.id,
      new Date(establishedAt.getTime() + 24 * 60 * 60 * 1000 + 1),
    );
    expect(later.outcome).toBe('applied');
  });

  it('switching to a screenplay outside the candidate set is refused, not found rather than an error', async () => {
    const owner = await createUser();
    const other = await createUser();
    const ownProject = await baseStore!.createProject(owner, 'Own project');
    await store!.createScreenplay(owner, ownProject.id, {
      title: "Owner's script",
      screenplay: screenplayFixture,
    });
    const otherProject = await baseStore!.createProject(other, 'Other project');
    const otherScreenplay = await store!.createScreenplay(other, otherProject.id, {
      title: "Someone else's script",
      screenplay: screenplayFixture,
    });

    const result = await entitlements!.switchEditableScreenplay(
      owner,
      otherScreenplay.id,
      new Date(),
    );
    expect(result.outcome).toBe('not-a-candidate');
  });

  it('an active subscription lifts every restriction: unlimited creation and editing, no slot needed', async () => {
    const owner = await createUser();
    await markActive(owner);
    const project = await baseStore!.createProject(owner, 'Studio project');

    const first = await store!.createScreenplay(owner, project.id, {
      title: 'Script one',
      screenplay: screenplayFixture,
    });
    const second = await store!.createScreenplay(owner, project.id, {
      title: 'Script two',
      screenplay: screenplayFixture,
    });

    const firstLoaded = await store!.getScreenplay(owner, first.id);
    const secondLoaded = await store!.getScreenplay(owner, second.id);
    await expect(
      store!.updateScreenplay(owner, first.id, {
        expectedVersion: 1,
        screenplay: (firstLoaded as { screenplay: typeof screenplayFixture }).screenplay,
      }),
    ).resolves.toEqual({ version: 2 });
    await expect(
      store!.updateScreenplay(owner, second.id, {
        expectedVersion: 1,
        screenplay: (secondLoaded as { screenplay: typeof screenplayFixture }).screenplay,
      }),
    ).resolves.toEqual({ version: 2 });

    const snapshot = await entitlements!.getSnapshot(owner, new Date());
    expect(snapshot.slot).toBeNull();
  });
});

async function createUser(): Promise<string> {
  userSequence += 1;
  const id = `user-${userSequence}-${randomUUID()}`;
  await pool!.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [id, `Writer ${userSequence}`, `writer-${userSequence}-${randomUUID()}@example.test`],
  );
  return id;
}

async function markLapsed(userId: string): Promise<void> {
  await pool!.query(
    `insert into subscriptions (
       user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
       status, current_period_end, cancel_at_period_end, canceled_at,
       last_event_created_at, updated_at
     ) values ($1, $2, $3, 'price_monthly', 'canceled', now(), false, now(), now(), now())`,
    [userId, `cus_${randomUUID()}`, `sub_${randomUUID()}`],
  );
}

async function markActive(userId: string): Promise<void> {
  await pool!.query(
    `insert into subscriptions (
       user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
       status, current_period_end, cancel_at_period_end, canceled_at,
       last_event_created_at, updated_at
     ) values ($1, $2, $3, 'price_monthly', 'active', now() + interval '30 days', false, null, now(), now())`,
    [userId, `cus_${randomUUID()}`, `sub_${randomUUID()}`],
  );
}

function databaseUrlFor(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function runMigrations() {
  await executeFile('pnpm', ['--filter', '@finaler-draft/database', 'db:migrate'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

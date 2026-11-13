import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertRevisionIfChanged } from './revisions.js';
import { currentEpoch, restoreRevisionAsCurrent } from './restore.js';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';

/**
 * plan.md's restore completion criteria, proven against a real, migrated Postgres rather than a fake
 * pool: "authorized, confirmed, atomic, idempotent, fully auditable, hash-identical to the selected
 * revision, and does not destroy old history or offline work." Authorization and confirmation are
 * resolved above this layer (`apps/api/src/restore.ts` and its own suites); the five properties that
 * only a real transaction can demonstrate are the ones here -- atomicity under a rollback,
 * idempotency under a replayed request id, hash identity with the source revision, the epoch cutover
 * itself, and old history surviving it.
 *
 * Driving `restoreRevisionAsCurrent` directly rather than through HTTP is deliberate: every property
 * below is a property of its single transaction, and an HTTP layer in front of it would only add a
 * second thing that could fail without making any of these claims more true.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;

let admin: Pool | undefined;
let pool: Pool | undefined;
let databaseCreated = false;

const derive = () => ({
  renderedText: 'RENDERED',
  previewMetadata: { sceneCount: 1, blockCount: 2 },
});

function screenplayAt(title: string) {
  return {
    schemaVersion: 1,
    id: '00000000-0000-4000-8000-000000000001',
    title,
    titlePages: [],
    blocks: [{ id: '00000000-0000-4000-8000-0000000000b1', type: 'action', text: title }],
  };
}

async function seedScreenplay(): Promise<string> {
  const projectId = randomUUID();
  const screenplayId = randomUUID();
  await pool!.query('insert into projects (id, title) values ($1, $2)', [projectId, 'P']);
  const json = JSON.stringify(screenplayAt('LIVE'));
  await pool!.query(
    `insert into screenplays (id, project_id, title, canonical_screenplay, canonical_hash)
       values ($1, $2, $3, $4::jsonb, $5)`,
    [screenplayId, projectId, 'S', json, createHash('sha256').update(json).digest('hex')],
  );
  return screenplayId;
}

async function addRevision(screenplayId: string, title: string, kind: 'named' | 'idle_session') {
  const json = JSON.stringify(screenplayAt(title));
  return await insertRevisionIfChanged(pool!, {
    screenplayId,
    sourceEpoch: 0,
    kind,
    label: kind === 'named' ? title : null,
    authoredBy: null,
    canonicalScreenplayJson: json,
    canonicalHash: createHash('sha256').update(json).digest('hex'),
    renderedText: title,
    previewMetadata: null,
  });
}

async function liveRow(screenplayId: string) {
  const result = await pool!.query<{
    canonicalHash: string;
    currentEpoch: number;
    canonicalScreenplay: { title: string };
  }>(
    `select canonical_hash as "canonicalHash", current_epoch as "currentEpoch",
            canonical_screenplay as "canonicalScreenplay"
       from screenplays where id = $1`,
    [screenplayId],
  );
  return result.rows[0]!;
}

/** Polls `check` until it is true or the budget runs out, returning what it last saw. Used instead
 * of a fixed sleep so a test asserts on an observed condition rather than on elapsed time. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe.skipIf(!databaseUrl)('restoreRevisionAsCurrent against a real database', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);
    pool = createIntegrationPool({ connectionString: databaseUrl! });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) await dropIntegrationTestDatabase(admin, planned!.databaseName);
    await admin?.end();
  });

  it('cuts the epoch over and leaves the live screenplay hash-identical to the source revision', async () => {
    const screenplayId = await seedScreenplay();
    const source = await addRevision(screenplayId, 'THE EARLIER DRAFT', 'named');
    expect(await currentEpoch(pool!, screenplayId)).toBe(0);

    const result = await restoreRevisionAsCurrent(pool!, {
      screenplayId,
      sourceRevisionId: source.id,
      actorId: null as unknown as string,
      restoreRequestId: randomUUID(),
      expectedEpoch: 0,
      derive,
    });

    expect(result.outcome).toBe('restored');
    if (result.outcome !== 'restored') return;
    expect(result.created).toBe(true);
    expect(result.previousEpoch).toBe(0);
    expect(result.epoch).toBe(1);

    const live = await liveRow(screenplayId);
    // plan.md: "hash-identical to the selected revision". Compared, not argued from the fact that
    // one column was copied into another -- a future change to how the live hash is computed would
    // break this silently otherwise.
    expect(live.canonicalHash).toBe(source.canonicalHash);
    expect(result.canonicalHash).toBe(source.canonicalHash);
    expect(live.canonicalScreenplay.title).toBe('THE EARLIER DRAFT');
    expect(live.currentEpoch).toBe(1);
    expect(await currentEpoch(pool!, screenplayId)).toBe(1);
  });

  it('is atomic: a crash after every statement but before commit leaves the old epoch live and writes nothing', async () => {
    const screenplayId = await seedScreenplay();
    const source = await addRevision(screenplayId, 'NEVER APPLIED', 'named');
    const before = await liveRow(screenplayId);
    const revisionsBefore = await pool!.query(
      'select count(*)::int as n from document_revisions where screenplay_id = $1',
      [screenplayId],
    );

    await expect(
      restoreRevisionAsCurrent(pool!, {
        screenplayId,
        sourceRevisionId: source.id,
        actorId: null as unknown as string,
        restoreRequestId: randomUUID(),
        expectedEpoch: 0,
        derive,
        // Stands in for the process dying at the last possible instant -- see this parameter's own
        // comment. Every statement has run; nothing has been committed.
        __testOnlyBeforeCommit: async () => {
          throw new Error('simulated crash before commit');
        },
      }),
    ).rejects.toThrow('simulated crash before commit');

    const after = await liveRow(screenplayId);
    expect(after.currentEpoch).toBe(0);
    expect(after.canonicalHash).toBe(before.canonicalHash);
    expect(after.canonicalScreenplay.title).toBe('LIVE');
    const revisionsAfter = await pool!.query(
      'select count(*)::int as n from document_revisions where screenplay_id = $1',
      [screenplayId],
    );
    // No `restore` revision, no `pre_restore` revision: the whole thing rolled back, not part of it.
    expect(revisionsAfter.rows[0]).toEqual(revisionsBefore.rows[0]);
  });

  it('is idempotent: replaying one restore request id changes nothing and reports the same restore', async () => {
    const screenplayId = await seedScreenplay();
    const source = await addRevision(screenplayId, 'RESTORE ME ONCE', 'named');
    const restoreRequestId = randomUUID();
    const common = {
      screenplayId,
      sourceRevisionId: source.id,
      actorId: null as unknown as string,
      restoreRequestId,
      expectedEpoch: 0,
      derive,
    };

    const first = await restoreRevisionAsCurrent(pool!, common);
    expect(first.outcome).toBe('restored');
    if (first.outcome !== 'restored') return;
    expect(first.created).toBe(true);

    // The retried or double-submitted confirmation. `expectedEpoch` is deliberately still 0 -- the
    // epoch the client believed when it first confirmed -- because that is what a genuine retry of
    // the same request carries. A replay must be recognised by its request id before the epoch
    // check can mistake it for a conflict.
    const replay = await restoreRevisionAsCurrent(pool!, common);
    expect(replay.outcome).toBe('restored');
    if (replay.outcome !== 'restored') return;
    expect(replay.created).toBe(false);
    expect(replay.epoch).toBe(first.epoch);
    expect(replay.restoreRevisionId).toBe(first.restoreRevisionId);

    const live = await liveRow(screenplayId);
    expect(live.currentEpoch).toBe(1);
    const restores = await pool!.query<{ n: number }>(
      `select count(*)::int as n from document_revisions
        where screenplay_id = $1 and kind = 'restore'`,
      [screenplayId],
    );
    // One epoch, one restore revision -- the property the partial unique index on
    // `restore_request_id` exists to guarantee.
    expect(restores.rows[0]!.n).toBe(1);
  });

  it('refuses a confirmation about an epoch that is no longer current -- two writers racing a restore', async () => {
    const screenplayId = await seedScreenplay();
    const first = await addRevision(screenplayId, 'FIRST TARGET', 'named');
    const second = await addRevision(screenplayId, 'SECOND TARGET', 'idle_session');

    const won = await restoreRevisionAsCurrent(pool!, {
      screenplayId,
      sourceRevisionId: first.id,
      actorId: null as unknown as string,
      restoreRequestId: randomUUID(),
      expectedEpoch: 0,
      derive,
    });
    expect(won.outcome).toBe('restored');

    // The second writer confirmed against epoch 0, which the first restore has since retired. Their
    // confirmation was about a document state that no longer exists, so it must not silently become
    // a second cutover.
    const lost = await restoreRevisionAsCurrent(pool!, {
      screenplayId,
      sourceRevisionId: second.id,
      actorId: null as unknown as string,
      restoreRequestId: randomUUID(),
      expectedEpoch: 0,
      derive,
    });
    expect(lost.outcome).toBe('epoch-conflict');
    if (lost.outcome !== 'epoch-conflict') return;
    expect(lost.currentEpoch).toBe(1);

    const live = await liveRow(screenplayId);
    expect(live.currentEpoch).toBe(1);
    expect(live.canonicalScreenplay.title).toBe('FIRST TARGET');
  });

  it('destroys no old history: every pre-restore revision is still readable at its own epoch, and the cutover is auditable', async () => {
    const screenplayId = await seedScreenplay();
    const oldest = await addRevision(screenplayId, 'OLDEST', 'named');
    const middle = await addRevision(screenplayId, 'MIDDLE', 'idle_session');

    const result = await restoreRevisionAsCurrent(pool!, {
      screenplayId,
      sourceRevisionId: oldest.id,
      actorId: null as unknown as string,
      restoreRequestId: randomUUID(),
      expectedEpoch: 0,
      derive,
    });
    expect(result.outcome).toBe('restored');
    if (result.outcome !== 'restored') return;

    // plan.md: "does not destroy old history". Both pre-restore revisions are still present, still
    // at the epoch they were written against, and still carrying their own content.
    const kept = await pool!.query<{ id: string; sourceEpoch: number }>(
      `select id, source_epoch as "sourceEpoch" from document_revisions
        where id = any($1::uuid[]) order by created_at asc`,
      [[oldest.id, middle.id]],
    );
    expect(kept.rowCount).toBe(2);
    expect(kept.rows.every((row) => row.sourceEpoch === 0)).toBe(true);

    // plan.md: "fully auditable" -- the restore revision links both to what it restored and to the
    // head it displaced, so the cutover can be reconstructed after the fact from the row alone.
    const audit = await pool!.query<{
      kind: string;
      sourceRevisionId: string | null;
      previousEpoch: number | null;
      previousHeadRevisionId: string | null;
    }>(
      `select kind, source_revision_id as "sourceRevisionId",
              previous_epoch as "previousEpoch",
              previous_head_revision_id as "previousHeadRevisionId"
         from document_revisions where id = $1`,
      [result.restoreRevisionId],
    );
    const row = audit.rows[0]!;
    expect(row.kind).toBe('restore');
    expect(row.sourceRevisionId).toBe(oldest.id);
    expect(row.previousEpoch).toBe(0);
    expect(row.previousHeadRevisionId).toBe(result.previousHeadRevisionId);
  });

  it('reports a missing screenplay and a revision belonging to another screenplay rather than restoring either', async () => {
    const screenplayId = await seedScreenplay();
    const other = await seedScreenplay();
    const foreign = await addRevision(other, 'NOT YOURS', 'named');

    expect(
      await restoreRevisionAsCurrent(pool!, {
        screenplayId: randomUUID(),
        sourceRevisionId: foreign.id,
        actorId: null as unknown as string,
        restoreRequestId: randomUUID(),
        expectedEpoch: 0,
        derive,
      }),
    ).toEqual({ outcome: 'screenplay-missing' });

    // A revision id is never trusted to resolve across screenplays.
    expect(
      await restoreRevisionAsCurrent(pool!, {
        screenplayId,
        sourceRevisionId: foreign.id,
        actorId: null as unknown as string,
        restoreRequestId: randomUUID(),
        expectedEpoch: 0,
        derive,
      }),
    ).toEqual({ outcome: 'revision-missing' });

    expect((await liveRow(screenplayId)).currentEpoch).toBe(0);
  });

  /*
   * The lock-ordering deadlock, driven against the real `restoreRevisionAsCurrent` rather than a
   * hand-rolled imitation of it.
   *
   * `restoreRevisionAsCurrent` and `insertRevisionIfChanged` both write `document_revisions` and
   * both take the same `REVISION_LOCK_NAMESPACE` advisory lock, so they are correctly serialized
   * against each other. The defect was the *order* each acquired its two locks. Restore used to
   * read the live `screenplays` row `for update` first and take the advisory lock second, while a
   * revision writer takes the advisory lock first and then inserts -- and that insert is not
   * lock-free, because `document_revisions.screenplay_id` references `screenplays.id`, so Postgres
   * takes a `KEY SHARE` lock on the parent row for the foreign-key check. `for update` conflicts
   * with `KEY SHARE`, so each path held one of the pair and waited for the other.
   *
   * The sequence below forces exactly that interleaving:
   *
   *   1. a revision writer takes the advisory lock and holds it
   *   2. a restore starts, and is made to wait for that lock -- confirmed by polling `pg_locks`
   *      for its ungranted request, not by sleeping and hoping
   *   3. the revision writer inserts, which needs `KEY SHARE` on the live screenplay row
   *
   * With the old ordering step 2 left restore holding `for update` on that row, so step 3 closed a
   * cycle and Postgres killed one side with SQLSTATE 40P01. With the advisory lock taken first,
   * restore holds nothing while it waits, the insert proceeds, and the restore completes once the
   * writer commits.
   */
  it('does not deadlock when a revision insert holds the revision lock a restore is waiting for', async () => {
    const screenplayId = await seedScreenplay();
    const source = await addRevision(screenplayId, 'A PRIOR DRAFT', 'named');

    const writer = await pool!.connect();
    try {
      // 1. The revision writer takes the advisory lock and keeps it.
      await writer.query('begin');
      await writer.query('select pg_advisory_xact_lock(hashtext($1), $2)', [screenplayId, -1]);

      // 2. The real restore starts and blocks on that lock. Not awaited yet: it cannot finish
      //    until the writer commits.
      const restoring = restoreRevisionAsCurrent(pool!, {
        screenplayId,
        sourceRevisionId: source.id,
        actorId: null as unknown as string,
        restoreRequestId: randomUUID(),
        expectedEpoch: 0,
        derive,
      });

      // Wait until restore is genuinely blocked on the advisory lock rather than merely started --
      // an ungranted `advisory` entry in `pg_locks` is the observable fact, so this cannot pass by
      // racing ahead of the restore.
      const blocked = await waitFor(async () => {
        const waiting = await pool!.query<{ count: number }>(
          `select count(*)::int as count from pg_locks
            where locktype = 'advisory' and not granted`,
        );
        return (waiting.rows[0]?.count ?? 0) > 0;
      });
      expect(blocked).toBe(true);

      // 3. The insert that used to close the cycle. It must succeed: with the corrected ordering,
      //    the waiting restore holds no lock on the screenplay row for this to collide with.
      await writer.query(
        `insert into document_revisions
           (screenplay_id, source_epoch, kind, label, authored_by, canonical_screenplay,
            canonical_hash, rendered_text, preview_metadata)
         values ($1, 0, 'idle_session', null, null, $2::jsonb, $3, $4, null)`,
        [
          screenplayId,
          JSON.stringify(screenplayAt('RACER')),
          // A real 64-char sha256. `canonical_hash` is `varchar(64)`, so a hand-built string with
          // a suffix overflows it and the insert fails on a type error *before* Postgres reaches
          // the foreign-key check -- which silently made an earlier version of this test prove
          // nothing at all.
          createHash('sha256')
            .update(JSON.stringify(screenplayAt('RACER')))
            .digest('hex'),
          'R',
        ],
      );
      await writer.query('commit');

      // ...and the restore then completes normally, rather than having been killed as a deadlock
      // victim. `restoreRevisionAsCurrent` converts a failure into a throw, so awaiting it here is
      // itself the assertion that no 40P01 occurred.
      const result = await restoring;
      expect(result.outcome).toBe('restored');
    } finally {
      await writer.query('rollback').catch(() => undefined);
      writer.release();
    }
  }, 30_000);
});

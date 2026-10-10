import { createHash, randomUUID } from 'node:crypto';
import { screenplayFixture } from '@finaler-draft/screenplay/fixtures';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresEntitlementStore, type EntitlementStore } from './entitlementStore.js';
import { createPostgresRestoreStore, type RestoreStore } from './restore.js';
import { createPostgresRevisionStore, type RevisionStore } from './revisions.js';
import { createPostgresSubscriptionStore } from './stripeSubscriptions.js';
import {
  createIntegrationDatabase,
  createIntegrationPool,
  dropIntegrationTestDatabase,
  planIntegrationTestDatabase,
  runIntegrationMigrations,
} from './integrationTestDatabase.js';

/**
 * Collaboration slice 5's policy layer against a real, migrated Postgres -- the half
 * `restore.test.ts` deliberately mocks away, and the half
 * `packages/database/src/restore.integration.test.ts` deliberately leaves to its caller:
 *
 *  - **Authorization** (plan.md: "authorized"), resolved by the real membership SQL rather than a
 *    fake pool returning a role. This is the suite that would fail if a reviewer could restore.
 *  - **Entitlement**, through the real `createPostgresEntitlementStore` and its real three queries.
 *  - **The `pre_restore` capture**, which needs a live projection that genuinely differs from the
 *    latest revision -- arranged here rather than hoped for.
 *  - **Stale-epoch rejection on the HTTP path**, end to end: store in, `'stale-epoch'` out, epoch
 *    unmoved.
 *  - **Export fidelity after restoration** (plan.md's required test list): what an export revision
 *    captured after a restore says about the document it was made from.
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const planned = adminUrl ? planIntegrationTestDatabase(adminUrl) : undefined;
const databaseUrl = planned?.databaseUrl;

let admin: Pool | undefined;
let pool: Pool | undefined;
let entitlements: EntitlementStore | undefined;
let store: RestoreStore | undefined;
let revisions: RevisionStore | undefined;
let databaseCreated = false;
let userSequence = 0;

describe.skipIf(!databaseUrl)('restore-as-current policy (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = createIntegrationPool({ connectionString: adminUrl });
    await createIntegrationDatabase(admin, planned!.databaseName);
    databaseCreated = true;
    await runIntegrationMigrations(databaseUrl!);
    pool = createIntegrationPool({ connectionString: databaseUrl });
    entitlements = createPostgresEntitlementStore(pool, createPostgresSubscriptionStore(pool));
    store = createPostgresRestoreStore(pool, entitlements);
    revisions = createPostgresRevisionStore(pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin && databaseCreated) {
      await dropIntegrationTestDatabase(admin, planned!.databaseName);
    }
    await admin?.end();
  });

  const request = () => ({ expectedEpoch: 0, restoreRequestId: randomUUID() });

  it.each(['owner', 'editor'] as const)(
    'lets a paid %s restore a revision, leaving the live screenplay hash-identical to it',
    async (role) => {
      const owner = await createUser();
      const { projectId, screenplayId } = await createProjectAndScreenplay(owner);
      const actor = role === 'owner' ? owner : await createUser();
      if (role === 'editor') await addMember(projectId, actor, 'editor');
      await payFor(actor);
      const source = await addRevision(screenplayId, 'THE DRAFT TO BRING BACK');

      const result = await store!.restoreRevision(actor, screenplayId, source.id, request());
      if (typeof result === 'string') throw new Error(`Unexpected result: ${result}`);
      expect(result.created).toBe(true);
      expect(result.epoch).toBe(1);
      expect(result.previousEpoch).toBe(0);

      const live = await liveRow(screenplayId);
      expect(live.currentEpoch).toBe(1);
      expect(live.canonicalHash).toBe(source.canonicalHash);
      expect(live.canonicalScreenplay.title).toBe('THE DRAFT TO BRING BACK');
      // Recorded as the acting writer, not as an automatic revision -- a restore is always somebody's
      // deliberate decision.
      const authored = await pool!.query<{ authoredBy: string | null }>(
        'select authored_by as "authoredBy" from document_revisions where id = $1',
        [result.restoreRevisionId],
      );
      expect(authored.rows[0]?.authoredBy).toBe(actor);
    },
  );

  /**
   * The case this slice must not get wrong: a reviewer can read every revision in history and open
   * any of them in the preview, so "may see it" must never be mistaken for "may make it current".
   * 403 rather than 404, because they are a member and pretending otherwise would be a worse answer
   * -- and, critically, the epoch has not moved.
   */
  it('refuses a reviewer, and a non-member, without moving the epoch', async () => {
    const owner = await createUser();
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner);
    const reviewer = await createUser();
    await addMember(projectId, reviewer, 'reviewer');
    await payFor(reviewer);
    const stranger = await createUser();
    await payFor(stranger);
    const source = await addRevision(screenplayId, 'NOT FOR A REVIEWER TO RESTORE');

    expect(await store!.restoreRevision(reviewer, screenplayId, source.id, request())).toBe(
      'forbidden',
    );
    expect(await store!.restoreRevision(stranger, screenplayId, source.id, request())).toBe(
      'missing',
    );
    const live = await liveRow(screenplayId);
    expect(live.currentEpoch).toBe(0);
    expect(live.canonicalScreenplay.title).toBe('Test Screenplay');
  });

  it('refuses an owner whose project was soft-deleted, the same as a non-member', async () => {
    const owner = await createUser();
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner);
    await payFor(owner);
    const source = await addRevision(screenplayId, 'IN A DELETED PROJECT');
    await pool!.query('update projects set deleted_at = now() where id = $1', [projectId]);

    expect(await store!.restoreRevision(owner, screenplayId, source.id, request())).toBe('missing');
    expect((await liveRow(screenplayId)).currentEpoch).toBe(0);
  });

  /**
   * The entitlement gate, through the real three queries rather than a supplied snapshot: a
   * restricted-tier editor whose one editable slot names a *different* screenplay cannot restore this
   * one. Without this, restore would be a way to write a screenplay the collaboration server would
   * refuse every keystroke for.
   */
  it('refuses a restricted-tier editor whose editable slot is another screenplay, and allows them once it is this one', async () => {
    const owner = await createUser();
    const { projectId, screenplayId } = await createProjectAndScreenplay(owner);
    const editor = await createUser();
    await addMember(projectId, editor, 'editor');
    // A second candidate of their own, and a slot naming it -- `checkEntitlement`'s `'not-in-slot'`
    // case for a restore of `screenplayId`. No `subscriptions` row anywhere: absent means restricted.
    const { screenplayId: ownScreenplayId } = await createProjectAndScreenplay(editor);
    await pool!.query(
      'insert into editable_slots (user_id, screenplay_id, updated_at) values ($1, $2, now())',
      [editor, ownScreenplayId],
    );
    const source = await addRevision(screenplayId, 'OUTSIDE THE SLOT');

    expect(await store!.restoreRevision(editor, screenplayId, source.id, request())).toBe(
      'entitlement-required',
    );
    expect((await liveRow(screenplayId)).currentEpoch).toBe(0);

    // Moving the slot to this screenplay is the only thing that changes, and it is enough.
    await pool!.query('update editable_slots set screenplay_id = $2 where user_id = $1', [
      editor,
      screenplayId,
    ]);
    const allowed = await store!.restoreRevision(editor, screenplayId, source.id, request());
    if (typeof allowed === 'string') throw new Error(`Unexpected result: ${allowed}`);
    expect(allowed.epoch).toBe(1);
  });

  /**
   * plan.md step 3's "records a `restore` revision linked to both the prior head and source
   * revision". When the live projection has moved on since the last revision -- the ordinary case
   * for a screenplay that has been edited since its last milestone -- the content that was live at
   * the instant of the cutover is captured as its own `pre_restore` revision, so it survives as a
   * first-class revision rather than only as a retired epoch's Yjs log.
   */
  it('captures what was live as a pre_restore revision when the latest revision no longer matches it', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);
    await payFor(owner);
    const source = await addRevision(screenplayId, 'THE TARGET');
    // The live projection moves on past that revision -- what `apps/collab`'s debounced save does
    // after any real editing.
    await setLiveScreenplay(screenplayId, 'WHAT WAS LIVE AT THE CUTOVER');

    const result = await store!.restoreRevision(owner, screenplayId, source.id, request());
    if (typeof result === 'string') throw new Error(`Unexpected result: ${result}`);

    const priorHead = await pool!.query<{
      kind: string;
      sourceEpoch: number;
      renderedText: string;
      canonicalScreenplay: { title: string };
      previewMetadata: { blockCount?: number } | null;
    }>(
      `select kind, source_epoch as "sourceEpoch", rendered_text as "renderedText",
              canonical_screenplay as "canonicalScreenplay", preview_metadata as "previewMetadata"
         from document_revisions where id = $1`,
      [result.previousHeadRevisionId],
    );
    const row = priorHead.rows[0]!;
    expect(row.kind).toBe('pre_restore');
    // Attributed to the epoch it belonged to -- the one being retired, not the new one.
    expect(row.sourceEpoch).toBe(0);
    expect(row.canonicalScreenplay.title).toBe('WHAT WAS LIVE AT THE CUTOVER');
    // The two columns `packages/database` cannot compute for itself, supplied by this layer's
    // `derive` callback and really present on the row.
    expect(row.renderedText).toContain('WHAT WAS LIVE AT THE CUTOVER');
    expect(row.previewMetadata?.blockCount).toBeGreaterThan(0);
    // And the restore itself still installed the *source* revision, not the capture.
    expect((await liveRow(screenplayId)).canonicalScreenplay.title).toBe('THE TARGET');
  });

  /**
   * Stale-epoch rejection on the HTTP path, through this layer rather than at the transaction's own
   * boundary: a second confirmation carrying the epoch the first restore retired is refused, and the
   * screenplay does not move again. The 409 this maps to is `apps/api/src/app.ts`'s concern and is
   * asserted in `revisionRoutes.test.ts`.
   */
  it('rejects a confirmation naming an epoch a restore has already retired, leaving the first restore intact', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);
    await payFor(owner);
    const first = await addRevision(screenplayId, 'FIRST WINNER');
    const second = await addRevision(screenplayId, 'SECOND LOSER');

    const won = await store!.restoreRevision(owner, screenplayId, first.id, request());
    if (typeof won === 'string') throw new Error(`Unexpected result: ${won}`);

    expect(await store!.restoreRevision(owner, screenplayId, second.id, request())).toBe(
      'stale-epoch',
    );
    const live = await liveRow(screenplayId);
    expect(live.currentEpoch).toBe(1);
    expect(live.canonicalScreenplay.title).toBe('FIRST WINNER');

    // Naming the real current epoch is what makes the second restore legitimate.
    const retried = await store!.restoreRevision(owner, screenplayId, second.id, {
      expectedEpoch: 1,
      restoreRequestId: randomUUID(),
    });
    if (typeof retried === 'string') throw new Error(`Unexpected result: ${retried}`);
    expect(retried.epoch).toBe(2);
  });

  /** The retried or double-submitted confirmation, through the whole policy layer rather than the
   * transaction alone: the same request id reaches the same answer, and no second cutover. */
  it('is idempotent through the policy layer: a replayed request id returns the first restore, not a second', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);
    await payFor(owner);
    const source = await addRevision(screenplayId, 'RESTORE ME ONCE ONLY');
    const input = request();

    const first = await store!.restoreRevision(owner, screenplayId, source.id, input);
    const replay = await store!.restoreRevision(owner, screenplayId, source.id, input);
    if (typeof first === 'string' || typeof replay === 'string') throw new Error('Unexpected.');
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.restoreRevisionId).toBe(first.restoreRevisionId);
    expect(replay.epoch).toBe(first.epoch);
    expect((await liveRow(screenplayId)).currentEpoch).toBe(1);
  });

  /**
   * A revision whose canonical projection cannot be parsed must not become the live document, and
   * the refusal has to happen before the epoch moves -- finding out afterwards would mean a cutover
   * to a screenplay nobody can open.
   */
  it('refuses a revision whose stored canonical projection no longer parses, leaving the epoch where it was', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);
    await payFor(owner);
    const broken = await pool!.query<{ id: string }>(
      `insert into document_revisions
         (screenplay_id, source_epoch, kind, label, authored_by, canonical_screenplay,
          canonical_hash, rendered_text)
       values ($1, 0, 'named', 'Corrupt', null, '{"schemaVersion":1}'::jsonb, $2, 'x')
       returning id`,
      [screenplayId, 'f'.repeat(64)],
    );

    expect(await store!.restoreRevision(owner, screenplayId, broken.rows[0]!.id, request())).toBe(
      'unreadable-revision',
    );
    expect((await liveRow(screenplayId)).currentEpoch).toBe(0);
  });

  /**
   * plan.md's "export fidelity after restoration". Exports in this product are derived from a
   * hash-identified snapshot (plan.md's exports row: "Derive downloads from a hash-identified
   * screenplay snapshot"), and the record of one is an `export` revision. Two things must hold after
   * a restoration, and both are asserted here:
   *
   *  - An export made at the restored epoch is recorded against exactly the restored content: the
   *    same `canonical_hash` as the revision that was restored, and the restored projection itself.
   *    Asserted on the row's content rather than on whether `insertRevisionIfChanged` happened to
   *    dedupe onto the `restore` row: that transaction writes `restore` and `pre_restore` with the
   *    identical `created_at`, so which of the two counts as "latest" is decided by their random
   *    ids, and reusing-versus-creating is therefore not a property worth pinning. What the content
   *    identity above proves is the one that matters -- the export record cannot name a snapshot
   *    other than the restored one.
   *  - An export confirmed against the epoch the restore retired is refused, not silently recorded
   *    under the new one. A writer whose tab predates the cutover must not be able to file an export
   *    record claiming content they never saw.
   */
  it('export fidelity after restoration: an export at the new epoch is recorded against the restored hash, and one at the retired epoch is refused', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);
    await payFor(owner);
    const source = await addRevision(screenplayId, 'THE RESTORED SNAPSHOT');
    await setLiveScreenplay(screenplayId, 'PRE-RESTORE LIVE CONTENT');

    const restored = await store!.restoreRevision(owner, screenplayId, source.id, request());
    if (typeof restored === 'string') throw new Error(`Unexpected result: ${restored}`);

    const staleExport = await revisions!.createRevision(owner, screenplayId, {
      epoch: restored.previousEpoch,
      kind: 'export',
      format: 'pdf',
    });
    expect(staleExport).toBe('stale-epoch');

    const freshExport = await revisions!.createRevision(owner, screenplayId, {
      epoch: restored.epoch,
      kind: 'export',
      format: 'pdf',
    });
    if (typeof freshExport === 'string') throw new Error(`Unexpected result: ${freshExport}`);
    const exported = await pool!.query<{
      canonicalHash: string;
      sourceEpoch: number;
      canonicalScreenplay: { title: string };
    }>(
      `select canonical_hash as "canonicalHash", source_epoch as "sourceEpoch",
              canonical_screenplay as "canonicalScreenplay"
         from document_revisions where id = $1`,
      [freshExport.id],
    );
    const row = exported.rows[0]!;
    expect(row.canonicalHash).toBe(source.canonicalHash);
    expect(row.canonicalScreenplay.title).toBe('THE RESTORED SNAPSHOT');
    expect(row.sourceEpoch).toBe(restored.epoch);
    // Never the content the restore replaced -- the failure this test exists to catch is an export
    // record that names the pre-restore document a writer's stale tab was still showing.
    expect(row.canonicalScreenplay.title).not.toBe('PRE-RESTORE LIVE CONTENT');
  });

  /**
   * plan.md's "does not destroy old history", at this layer: after the restore, every revision that
   * existed before it is still listable, still carrying its own content -- including the one that was
   * restored and the capture of what it displaced.
   */
  it('leaves the whole pre-restore history listable afterwards, with the restore and its capture alongside', async () => {
    const owner = await createUser();
    const { screenplayId } = await createProjectAndScreenplay(owner);
    await payFor(owner);
    const oldest = await addRevision(screenplayId, 'OLDEST MILESTONE');
    const newer = await addRevision(screenplayId, 'NEWER MILESTONE');
    await setLiveScreenplay(screenplayId, 'LIVE AT THE CUTOVER');

    const restored = await store!.restoreRevision(owner, screenplayId, oldest.id, request());
    if (typeof restored === 'string') throw new Error(`Unexpected result: ${restored}`);

    const listed = await revisions!.listRevisions(owner, screenplayId);
    if (listed === 'missing') throw new Error('Unexpected result: missing');
    const ids = listed.map((item) => item.id);
    expect(ids).toContain(oldest.id);
    expect(ids).toContain(newer.id);
    expect(ids).toContain(restored.restoreRevisionId);
    expect(ids).toContain(restored.previousHeadRevisionId);
    expect(listed.map((item) => item.kind)).toContain('restore');
    expect(listed.map((item) => item.kind)).toContain('pre_restore');

    // And the restored revision is still readable as itself, unchanged by having been restored.
    const reread = await revisions!.getRevision(owner, screenplayId, oldest.id);
    if (reread === 'missing') throw new Error('Unexpected result: missing');
    expect(reread.screenplay.title).toBe('OLDEST MILESTONE');
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

/** A real `subscriptions` row, so `checkEntitlement` resolves `{allowed: true}` unconditionally and
 * the test is about authorization rather than billing. The restricted-tier case deliberately omits
 * this -- absent means restricted (`packages/entitlements`). */
async function payFor(userId: string): Promise<void> {
  await pool!.query(
    `insert into subscriptions
       (user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status,
        current_period_end, last_event_created_at)
     values ($1, $2, $3, 'price_test', 'active', now() + interval '30 days', now())`,
    [userId, `cus_${randomUUID()}`, `sub_${randomUUID()}`],
  );
}

async function addMember(
  projectId: string,
  userId: string,
  role: 'owner' | 'editor' | 'reviewer',
): Promise<void> {
  await pool!.query('insert into project_members (project_id, user_id, role) values ($1, $2, $3)', [
    projectId,
    userId,
    role,
  ]);
}

/**
 * The fixture, retitled *and* carrying `title` as the text of a leading action block. The block
 * matters: `screenplayToPlainText` renders the body and the title *page*, never the screenplay's
 * `title` field, so a projection distinguished only by that field would be indistinguishable in the
 * `rendered_text` column this suite asserts on.
 */
function screenplayTitled(screenplayId: string, title: string) {
  return {
    ...screenplayFixture,
    id: screenplayId,
    title,
    blocks: [
      { id: randomUUID(), type: 'action' as const, text: title },
      ...screenplayFixture.blocks,
    ],
  };
}

async function createProjectAndScreenplay(
  ownerUserId: string,
): Promise<{ projectId: string; screenplayId: string }> {
  const projectId = randomUUID();
  const screenplayId = randomUUID();
  const screenplay = screenplayTitled(screenplayId, 'Test Screenplay');
  const canonicalJson = JSON.stringify(screenplay);
  await pool!.query('insert into projects (id, title) values ($1, $2)', [
    projectId,
    'Test Project',
  ]);
  await pool!.query(
    "insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')",
    [projectId, ownerUserId],
  );
  await pool!.query(
    `insert into screenplays (id, project_id, title, canonical_screenplay, canonical_hash)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [
      screenplayId,
      projectId,
      'Test Screenplay',
      canonicalJson,
      createHash('sha256').update(canonicalJson).digest('hex'),
    ],
  );
  return { projectId, screenplayId };
}

/** A revision of `screenplayId` whose canonical projection is the fixture retitled, so each one is
 * distinguishable by title and has its own hash. */
async function addRevision(
  screenplayId: string,
  title: string,
): Promise<{ id: string; canonicalHash: string }> {
  const json = JSON.stringify(screenplayTitled(screenplayId, title));
  const canonicalHash = createHash('sha256').update(json).digest('hex');
  const result = await pool!.query<{ id: string }>(
    `insert into document_revisions
       (screenplay_id, source_epoch, kind, label, authored_by, canonical_screenplay,
        canonical_hash, rendered_text, preview_metadata)
     values ($1, 0, 'named', $2, null, $3::jsonb, $4, $5, null)
     returning id`,
    [screenplayId, title, json, canonicalHash, title],
  );
  return { id: result.rows[0]!.id, canonicalHash };
}

/** Moves the *live* projection on, the way `apps/collab`'s debounced save does after real editing --
 * which is what makes the `pre_restore` capture branch reachable. */
async function setLiveScreenplay(screenplayId: string, title: string): Promise<void> {
  const json = JSON.stringify(screenplayTitled(screenplayId, title));
  await pool!.query(
    `update screenplays
        set canonical_screenplay = $2::jsonb, canonical_hash = $3, updated_at = now()
      where id = $1`,
    [screenplayId, json, createHash('sha256').update(json).digest('hex')],
  );
}

async function liveRow(screenplayId: string): Promise<{
  currentEpoch: number;
  canonicalHash: string;
  canonicalScreenplay: { title: string };
}> {
  const result = await pool!.query<{
    currentEpoch: number;
    canonicalHash: string;
    canonicalScreenplay: { title: string };
  }>(
    `select current_epoch as "currentEpoch", canonical_hash as "canonicalHash",
            canonical_screenplay as "canonicalScreenplay"
       from screenplays where id = $1`,
    [screenplayId],
  );
  return result.rows[0]!;
}

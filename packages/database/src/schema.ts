import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// `node-postgres` (the `pg` driver every app here uses) reads/writes a `bytea` column as a
// Node `Buffer` with no configuration -- `customType` only needs to name the Postgres type
// itself; no `toDriver`/`fromDriver` mapping is needed on top of that default behaviour.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const user = pgTable(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull(),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex('user_email_unique').on(table.email)],
);

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [uniqueIndex('session_token_unique').on(table.token)],
);

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const projectRole = pgEnum('project_role', ['owner', 'editor', 'reviewer']);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: projectRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('project_member_unique').on(table.projectId, table.userId),
    uniqueIndex('project_single_owner_unique')
      .on(table.projectId)
      .where(sql`${table.role} = 'owner'`),
    index('project_members_user_id_index').on(table.userId),
  ],
);

export const screenplays = pgTable(
  'screenplays',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 200 }).notNull(),
    // `canonicalScreenplay`/`canonicalHash` are no longer a client-supplied write target
    // (collaboration slice 1: apps/collab's Hocuspocus server is the only writer, on a debounced
    // `onStoreDocument`, projecting the live Yjs document -- see `documentYjsState` below). The
    // `version` column and the whole-document `PUT`/409-conflict machinery it protected are
    // deleted along with it: optimistic concurrency has no meaning once there is exactly one
    // writer of record and every editor sees the same converging Yjs state instead of racing a
    // version number. plan.md's "Collaboration, history, and restoration" anticipates this
    // deletion explicitly.
    canonicalScreenplay: jsonb('canonical_screenplay').notNull(),
    canonicalHash: varchar('canonical_hash', { length: 64 }).notNull(),
    // Collaboration slice 5 (restore-as-current, plan.md's "Restore as current"): *the* stored
    // current epoch for this screenplay's collaboration document, and the only place it is stored.
    // Before this slice there was none at all -- `document_yjs_updates`/`document_yjs_checkpoints`/
    // `document_yjs_quarantined_updates`/`document_revisions` each carried an `epoch` column written
    // with a hard-coded `0`, with nothing anywhere saying which epoch was *current* (see
    // `documentYjsUpdates.epoch`'s own comment, which anticipated exactly this slice).
    //
    // **Why on `screenplays` rather than its own table.** A screenplay *is* the collaboration
    // document in this schema (the same reasoning every `screenplay_id` foreign key above already
    // records), so this is a column of the document, not a relationship to one. Concretely: every
    // reader needs it in a query it was already running -- `apps/collab`'s `createFetch`/
    // `createStore` already select from `screenplays` by id, `authenticate.ts`'s role lookup
    // already joins it, `apps/api`'s `getScreenplay` already reads the row -- so a column here
    // costs zero extra round trips, while a separate `document_epochs` table would need a row
    // created for every screenplay that already exists, a join or second query on every one of
    // those paths, and a decision about what a *missing* row means. It also puts the epoch under
    // the same row lock (`select ... for update`) the restore transaction already needs to hold on
    // this row to install the restored canonical projection atomically with the increment, instead
    // of needing two locks in a fixed order to avoid deadlocking.
    //
    // `default 0` is what keeps the migration safe against existing rows: every screenplay that
    // already exists becomes "currently at epoch 0," which is exactly the epoch slices 3 and 4a
    // wrote all of their rows under -- so no existing update, checkpoint, quarantined update or
    // revision is orphaned by this column appearing. Monotonic and never decremented; a restore is
    // always `current_epoch + 1`, never a reuse of a retired number, so a stale client's epoch can
    // always be classified as "older than current" rather than ambiguous.
    currentEpoch: integer('current_epoch').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('screenplays_project_id_index').on(table.projectId)],
);

// Collaboration slice 3 (durable append-only update log). Replaces slice 1's
// `document_yjs_state` -- one row per screenplay holding only the latest merged snapshot -- with
// two tables: an append-only log of every authenticated Yjs update (this table) and a
// periodically-compacted merged snapshot (`documentYjsCheckpoints`, below). See that table's own
// comment for why `document_yjs_state` does not survive alongside them as a third source of
// truth.
//
// **Naming.** plan.md's own schema sketch names this column `document_id`; this codebase's
// existing table (the now-removed `document_yjs_state`) called the identical foreign key
// `screenplay_id`, because there is no `documents` table in this schema -- a screenplay *is* the
// collaboration document. Kept as `screenplay_id` here for the same reason: matching a sketch
// written before this table existed, over the name every sibling column and every query in
// `apps/collab` already uses, would be adopting drift for its own sake.
//
// **`epoch`.** Not yet varied by anything in this slice -- every row is written with the default
// `0`, and nothing here ever reads a document's "current epoch" from anywhere else, because no
// such concept exists yet. Introduced now anyway, deliberately, because slice 5 (restore-as-
// current, plan.md's "Restore as current") is specifically an *epoch cutover*: a restore creates
// a fresh collaboration document, increments the epoch, and makes clients reconnect into a new
// one while rejecting writes to the old one. Adding `epoch` after that slice needs it would mean
// widening the primary key of a table that, by then, holds every update ever made to every
// screenplay -- a rewrite of the largest table in the schema, under load, instead of a
// zero-downtime `ALTER TABLE ... ADD COLUMN ... DEFAULT 0`. A column nothing varies yet is a far
// smaller cost than that rewrite.
export const documentYjsUpdates = pgTable(
  'document_yjs_updates',
  {
    // A single globally-increasing identity column, not a counter reset to 1 per
    // (screenplayId, epoch). Every ordering and cutoff comparison this slice needs --
    // "give me every update after this checkpoint," "what is the latest update for this
    // document" -- only requires *monotonic order*, not a dense per-document sequence starting at
    // 1. A global identity column gets that ordering for free from Postgres's own
    // `GENERATED ALWAYS AS IDENTITY`, which is safe under concurrent inserts with no
    // application-level locking, counter table, or retry-on-conflict loop -- unlike a per-document
    // counter, which would need one of those three to stay correct when two updates for the same
    // document are appended concurrently (see `updateLog.ts`'s own comment on why this matters for
    // the compaction invariant specifically).
    sequence: bigint('sequence', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    screenplayId: uuid('screenplay_id')
      .notNull()
      .references(() => screenplays.id, { onDelete: 'cascade' }),
    epoch: integer('epoch').notNull().default(0),
    update: bytea('update').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    // Nullable: a future server-internal write (e.g. a migration backfill, or slice 5's own
    // restore-seeding) has no human actor to attribute, and `onDelete: 'set null'` -- not
    // `'cascade'` -- means a deleted user's past updates stay in the log with their authorship
    // merely un-attributed, rather than the update rows themselves (and the document history they
    // represent) disappearing along with the account that made them.
    authenticatedActorId: text('authenticated_actor_id').references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('document_yjs_updates_screenplay_epoch_index').on(table.screenplayId, table.epoch),
  ],
);

// The compacted counterpart to `documentYjsUpdates` above, and the direct replacement for slice
// 1's `document_yjs_state`. Deliberately append-only itself (a new row per compaction, never an
// `update` to an existing one) rather than one upserted row per screenplay: `updateLog.ts`'s
// `createCheckpoint` reconstruction logic only ever needs the *latest* checkpoint for a
// (screenplayId, epoch) pair (highest `throughSequence`), so keeping the history costs one small
// row per compaction and buys a diagnosable trail of exactly what was compacted and when, which an
// upserted single row would destroy on every write.
//
// **What happened to `document_yjs_state`.** It does not survive alongside these two tables --
// keeping it would mean three overlapping stores of the same information (the raw log, a
// checkpoint, and a third "latest snapshot" row updated on every debounced save), with no
// reader that would ever need the third once the first two exist, and a real risk of the third
// drifting from what the log+checkpoint pair would reconstruct after a crash mid-write. This
// table *is* the fast path `document_yjs_state` used to be: `updateLog.ts`'s `fetchDocumentState`
// reads the latest checkpoint, decodes it, and applies only the (usually zero, at most a handful)
// updates logged after it -- not a full replay of the document's entire history on every load.
export const documentYjsCheckpoints = pgTable(
  'document_yjs_checkpoints',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    screenplayId: uuid('screenplay_id')
      .notNull()
      .references(() => screenplays.id, { onDelete: 'cascade' }),
    epoch: integer('epoch').notNull().default(0),
    // The highest `documentYjsUpdates.sequence` this checkpoint's `mergedUpdate` already reflects
    // -- reconstruction replays only updates with `sequence > throughSequence`, and compaction
    // (`updateLog.ts`'s `createCheckpoint`) deletes only rows with `sequence <= throughSequence`,
    // both for the identical (screenplayId, epoch) pair. This is the one column the sharp
    // invariant ("compaction must never lose an update a checkpoint has not yet absorbed") is
    // actually about: it is set, inside the same transaction that deletes the absorbed rows, to
    // exactly the sequence a Postgres advisory lock (held for the duration of that transaction)
    // guarantees no concurrent append could have raced past -- see `updateLog.ts`.
    throughSequence: bigint('through_sequence', { mode: 'number' }).notNull(),
    // Nullable, and expected to be null only for the one bootstrap checkpoint this slice's
    // migration writes from each pre-existing `document_yjs_state` row (there is no way to
    // recompute a Yjs state vector from raw SQL during that migration). Every checkpoint this
    // application creates going forward (`updateLog.ts`'s `createCheckpoint`) always computes and
    // stores a real one. Nothing in this slice's reconstruction path reads it -- `mergedUpdate`
    // alone is sufficient to rebuild the document -- so a null value here is inert, not a
    // correctness gap; it exists for a later slice that wants to diff a client's state vector
    // against a checkpoint without decoding the full `mergedUpdate` first.
    stateVector: bytea('state_vector'),
    mergedUpdate: bytea('merged_update').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('document_yjs_checkpoints_screenplay_epoch_index').on(table.screenplayId, table.epoch),
  ],
);

// Slice 3's quarantine: updates from a connection `apps/collab/src/authenticate.ts` resolved as
// `readOnly` (a reviewer, or an owner/editor account whose subscription has lapsed and this
// screenplay is not their one editable slot) are *accepted*, not rejected outright -- a writer's
// real keystrokes, made honestly while offline, must never simply vanish -- but never merged into
// the live document, because accepting silently would make going offline a way to keep editing
// without the entitlement that would otherwise gate it. This table is where "accepted" lives:
// `apps/collab`'s `beforeHandleMessage` hook persists here, instead of discarding, exactly the
// update bytes Hocuspocus's own low-level `readOnly` check (confirmed by reading the installed
// `@hocuspocus/server` source -- see `progress/collaboration-slice-1.md`'s "write-rejection
// mechanism") would otherwise drop with no trace at all.
//
// Scope for this slice is detection and retention only -- the resubscribe-and-merge interface
// (reading these rows back and offering them to a writer who regains entitlement) is explicitly
// deferred, so there is no "resolved"/"merged" state column yet: every row here is, for now,
// simply retained. Deleting a screenplay cascades away its quarantined updates along with
// everything else scoped to it, the same as `documentYjsUpdates` and `documentYjsCheckpoints`.
export const documentYjsQuarantinedUpdates = pgTable(
  'document_yjs_quarantined_updates',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    screenplayId: uuid('screenplay_id')
      .notNull()
      .references(() => screenplays.id, { onDelete: 'cascade' }),
    epoch: integer('epoch').notNull().default(0),
    update: bytea('update').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    authenticatedActorId: text('authenticated_actor_id').references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('document_yjs_quarantined_updates_screenplay_epoch_index').on(
      table.screenplayId,
      table.epoch,
    ),
  ],
);

// Collaboration slice 4a: durable, immutable revisions (plan.md's "Collaboration, history, and
// restoration" -> "Durable storage" and "Separate concepts"). A revision is a point-in-time copy
// of the canonical projection, written once and never updated -- the opposite of
// `document_yjs_updates`/`document_yjs_checkpoints` above, which exist purely to reconstruct the
// *live* document, and of `screenplays.canonical_screenplay`, which is the live, continuously
// overwritten projection those tables feed. `apps/collab/src/revisions.ts` and
// `apps/api/src/revisions.ts` are the only writers.
//
// **Naming.** Same reasoning as `documentYjsUpdates` above, and the same conclusion: plan.md's own
// schema sketch names the foreign key `document_id`; this codebase has no `documents` table, so it
// stays `screenplay_id`, matching every sibling table.
//
// **What this table is not.** plan.md's "Separate concepts" is explicit that revision history,
// Track Changes, and production revision sets "must never share one implementation or user
// interface state." This table carries no per-block author attribution (that is Track Changes) and
// models a revision as a single immutable snapshot, never a set of proposed changes (that is also
// Track Changes). There is no "accept/reject" state anywhere here.
//
// Collaboration slice 5 adds two kinds, both written only by the restore transaction
// (`packages/database/src/restore.ts`):
//
//  - `restore`: the audit record of one epoch cutover. Its `canonicalScreenplay`/`canonicalHash`
//    are copied verbatim from the revision being restored, which is what makes "hash-identical to
//    the selected revision" a copied value rather than a recomputed one, and it carries the two
//    links plan.md's step 3 requires ("a `restore` revision linked to both the prior head and
//    source revision") plus the epoch it retired.
//  - `pre_restore`: the content that was live immediately *before* the cutover, captured in the
//    same transaction so that "does not destroy old history" does not depend on anyone being able
//    to replay the retired epoch's Yjs log. Written only when the live projection had actually
//    moved on from the screenplay's latest existing revision; when it had not, that existing
//    revision already *is* the prior head and is linked directly instead of copied.
export const revisionKind = pgEnum('revision_kind', [
  'named',
  'idle_session',
  'structural_change',
  'export',
  'restore',
  'pre_restore',
]);

export const documentRevisions = pgTable(
  'document_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    screenplayId: uuid('screenplay_id')
      .notNull()
      .references(() => screenplays.id, { onDelete: 'cascade' }),
    // Carried for the same forward-looking reason `documentYjsUpdates.epoch` was introduced ahead
    // of need: slice 5 (restore-as-current) is an epoch cutover, and a revision written under one
    // epoch must stay attributable to that epoch even after a restore moves the document on to the
    // next one. Fixed at `DEFAULT_EPOCH` (0) by every writer today, identically to the two tables
    // above.
    sourceEpoch: integer('source_epoch').notNull().default(0),
    kind: revisionKind('kind').notNull(),
    // Null for every automatic kind (`idle_session`, `structural_change`, `export`) -- there is no
    // writer-authored label for those, and inventing one (e.g. a timestamp string) would just be
    // `createdAt` restated as text. Required, non-empty, application-enforced for `named`.
    label: text('label'),
    // Nullable for the identical reason `documentYjsUpdates.authenticatedActorId` is: an automatic
    // revision has no single human author (an idle-session revision reflects whoever edited during
    // that session, not one actor performing this specific write), and `onDelete: 'set null'` keeps
    // a deleted user's past revisions in history with authorship merely un-attributed, rather than
    // the revision itself disappearing along with the account that (partly) produced it.
    authoredBy: text('authored_by').references(() => user.id, { onDelete: 'set null' }),
    // The full canonical projection at the moment this revision was captured -- deliberately a
    // second, independent copy of the same shape `screenplays.canonical_screenplay` holds, not a
    // foreign key or a diff against it: `screenplays.canonical_screenplay` is mutable and will have
    // moved on by the time anything reads this row. A revision is immutable specifically because it
    // owns its own copy.
    canonicalScreenplay: jsonb('canonical_screenplay').notNull(),
    // Deliberately the *canonical* hash (sha256 of the serialized `canonicalScreenplay`, identical
    // algorithm to `screenplays.canonical_hash`), never a hash of anything pagination produces.
    // `(MORE)`/`CONT'D` are derived at render time and never written into `canonicalScreenplay` (see
    // that column's own comment on `screenplays` and plan.md's "the canonical model already forbids
    // persisting renderer output"), so this hash is stable under repagination by construction, not
    // by a special case here -- see `revisions.test.ts`'s `hash stability under layout` suite for
    // the proof. This is also the column every automatic-revision writer dedupes on: a new
    // automatic revision is never inserted when this would equal the screenplay's latest existing
    // revision's own hash (`insertRevisionIfChanged`, `revisions.ts`) -- the direct fix for
    // plan.md's stated trap, "If pagination mutates the document, the hash changes when nobody
    // edited anything, and revision history fills with automatic commits."
    canonicalHash: varchar('canonical_hash', { length: 64 }).notNull(),
    // Plain-text rendering of the same snapshot (`@finaler-draft/screenplay`'s
    // `screenplayToPlainText`), stored once at write time rather than recomputed on every read --
    // this is what a future screenplay-aware diff (slice 4b, explicitly out of this slice's scope)
    // and full-text search over history would read, and what makes a revision's content legible
    // without re-parsing `canonicalScreenplay` first.
    renderedText: text('rendered_text').notNull(),
    // A small, denormalized summary (`{ sceneCount, blockCount }` today) computed once at write
    // time so a revision list can render without deserializing and re-deriving from the full
    // `canonicalScreenplay` blob for every row. Nullable because it is a display convenience, not a
    // correctness-bearing field -- nothing in restoration or export-fidelity ever depends on it.
    previewMetadata: jsonb('preview_metadata'),
    // The three audit columns of a `restore` revision (slice 5), null for every other kind.
    //
    // `sourceRevisionId` is the revision whose content this restore installed as current;
    // `previousHeadRevisionId` is the revision holding what was live immediately before it (either a
    // `pre_restore` row this same transaction wrote, or the already-current latest revision when the
    // live projection had not moved on from it). Together they are plan.md's "linked to both the
    // prior head and source revision," and they make a restore readable in both directions: what it
    // brought back, and what it replaced.
    //
    // Self-referencing, and `onDelete: 'set null'` rather than `'cascade'`: nothing in this product
    // deletes a revision row (there is no code path, and deletion of a screenplay cascades the whole
    // table together), but if one ever were removed, the correct outcome is an audit link that
    // degrades to "unknown" -- never a cascade that deletes the restore record itself, or the
    // history on either side of it.
    sourceRevisionId: uuid('source_revision_id').references(
      (): AnyPgColumn => documentRevisions.id,
      {
        onDelete: 'set null',
      },
    ),
    previousHeadRevisionId: uuid('previous_head_revision_id').references(
      (): AnyPgColumn => documentRevisions.id,
      { onDelete: 'set null' },
    ),
    // The epoch this restore retired -- `sourceEpoch` on a `restore` row is the *new* epoch (the one
    // whose starting content this row describes), so the pair records the cutover itself rather than
    // just one side of it. Null for every other kind, which belong to exactly one epoch.
    previousEpoch: integer('previous_epoch'),
    // The idempotency key, supplied by the client that confirmed the restore and unique across the
    // whole table (partial unique index below). This is the mechanism behind plan.md's "idempotent":
    // a retried or double-submitted confirmation carries the identical key, finds this row, and
    // returns it without incrementing the epoch or writing a second `restore` revision. A
    // *pre-check* alone could not provide that -- two app instances can run it simultaneously -- so
    // the unique index is the actual guarantee and the pre-check is only what turns the common case
    // into a clean reused result instead of a constraint violation.
    restoreRequestId: uuid('restore_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Partial: only `restore` rows carry a request id at all, and `null` values would otherwise be
    // permitted in unlimited number by a plain unique index anyway -- stating the predicate makes
    // the index itself small (one entry per restore ever performed, not one per revision) and the
    // intent explicit.
    uniqueIndex('document_revisions_restore_request_id_unique')
      .on(table.restoreRequestId)
      .where(sql`${table.restoreRequestId} is not null`),
    // `createdAt` (not `id`) is the ordering column every reader wants ("history, newest first";
    // "the revision immediately before this one") -- `id` is a random `uuid`, not a sequence, so it
    // carries no chronological meaning to index on.
    index('document_revisions_screenplay_id_index').on(table.screenplayId, table.createdAt),
  ],
);

// Stripe's own Subscription.Status enum (esm/resources/Subscriptions.d.ts in the installed
// `stripe` package, API version 2026-07-29.dahlia), reproduced here rather than imported: this
// package has no dependency on the Stripe SDK, and a database enum is schema, not a client
// binding. If Stripe ever adds a new status this column would reject it until this migration is
// extended -- an explicit failure at write time, not a silently truncated/miscategorized value.
export const subscriptionStatus = pgEnum('subscription_status', [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);

// A queryable cache of Stripe subscription state, keyed to the Better Auth user (plan.md,
// "Subscription and billing architecture": "Persist a subscriptions projection in PostgreSQL
// keyed to the Better Auth user ... Stripe remains the source of truth; this table is a
// queryable cache that the webhook keeps current"). One row per user reflects the flat
// per-user pricing model plan.md proposes as the simpler starting point (no per-seat billing).
//
// `lastEventCreatedAt` is the out-of-order delivery guard: Stripe does not guarantee webhook
// delivery order, only that each event's own `created` timestamp reflects generation order.
// Every write compares the incoming event's `created` against this column and is discarded,
// not applied, when it is not strictly newer -- see stripeSubscriptions.ts's
// `recordSubscriptionEvent`/`recordInvoiceEvent` for the upsert that enforces this.
export const subscriptions = pgTable(
  'subscriptions',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    stripePriceId: text('stripe_price_id').notNull(),
    status: subscriptionStatus('status').notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    lastEventCreatedAt: timestamp('last_event_created_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('subscriptions_stripe_customer_id_unique').on(table.stripeCustomerId),
    uniqueIndex('subscriptions_stripe_subscription_id_unique').on(table.stripeSubscriptionId),
  ],
);

// Dedupe ledger for Stripe webhook delivery (plan.md: "Events are duplicated and arrive out of
// order. Persist event.id and reject events already processed"). Keyed on Stripe's own event id,
// which is globally unique per event and stable across retries/redeliveries of the same event.
export const stripeProcessedEvents = pgTable('stripe_processed_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
});

// The single-editable-slot record for the free/lapsed entitlement tier (plan.md's "The free
// tier" and "What happens when a subscription lapses"): which screenplay currently occupies a
// restricted account's one editable slot, and when that choice was last made. The timestamp is
// not incidental -- apps/api/src/entitlements.ts's switch-slot cooldown (switching the slot is
// rate-limited to once per 24 hours, never a quota of switches) cannot be enforced without it,
// so this column exists regardless of whether a UI to change the slot has shipped yet.
//
// One row per user, and only ever written once a choice actually needs recording. A row is
// absent for every account that has never needed one -- a paid account, or a restricted account
// that has only ever had zero or exactly one editable-role screenplay -- see
// apps/api/src/entitlements.ts's `checkEntitlement` for how an absent row and a single
// unambiguous candidate resolve identically without a row being written for the latter.
export const editableSlots = pgTable('editable_slots', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  screenplayId: uuid('screenplay_id')
    .notNull()
    .references(() => screenplays.id, { onDelete: 'cascade' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

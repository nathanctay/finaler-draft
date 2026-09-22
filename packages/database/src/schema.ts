import {
  boolean,
  customType,
  index,
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('screenplays_project_id_index').on(table.projectId)],
);

// The Hocuspocus Database extension's persistence target (apps/collab): one row per screenplay,
// holding the full merged Yjs state (`Y.encodeStateAsUpdate`) for that document's collaboration
// session. This is slice 1's *snapshot* durability -- progress/collaboration-plan.md is explicit
// that it is not yet the append-only `document_yjs_updates`/`document_yjs_checkpoints` log
// plan.md's schema sketch describes for revision history; that arrives in a later slice. A
// screenplay created before this slice has no row here until its first collaborative edit --
// `apps/collab`'s `fetch` seeds a fresh Yjs document from the existing `canonicalScreenplay` the
// first time a document with no row here is opened, so nothing is lost, and this table gains a
// row from that point on.
export const documentYjsState = pgTable('document_yjs_state', {
  screenplayId: uuid('screenplay_id')
    .primaryKey()
    .references(() => screenplays.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

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

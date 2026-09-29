CREATE TABLE "document_yjs_checkpoints" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "document_yjs_checkpoints_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"screenplay_id" uuid NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"through_sequence" bigint NOT NULL,
	"state_vector" bytea,
	"merged_update" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_yjs_quarantined_updates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "document_yjs_quarantined_updates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"screenplay_id" uuid NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"update" bytea NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authenticated_actor_id" text
);
--> statement-breakpoint
CREATE TABLE "document_yjs_updates" (
	"sequence" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "document_yjs_updates_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"screenplay_id" uuid NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"update" bytea NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authenticated_actor_id" text
);
--> statement-breakpoint
-- Data migration: every pre-existing `document_yjs_state` row becomes exactly one bootstrap
-- checkpoint (epoch 0, through_sequence 0 -- there are no logged updates yet, since the update
-- log did not exist before this migration) rather than being dropped along with that table.
-- `state_vector` is left NULL: recomputing a real Yjs state vector from raw bytes needs the `yjs`
-- library, not plain SQL, and nothing in this slice's reconstruction path reads it (see
-- `document_yjs_checkpoints.state_vector`'s own schema comment). `created_at` is carried forward
-- from the old row's own `updated_at` rather than reset to "now", so a checkpoint created by this
-- migration is dated when that snapshot was actually last written, not when this migration ran.
INSERT INTO "document_yjs_checkpoints" ("screenplay_id", "epoch", "through_sequence", "state_vector", "merged_update", "created_at")
SELECT "screenplay_id", 0, 0, NULL, "state", "updated_at" FROM "document_yjs_state";--> statement-breakpoint
DROP TABLE "document_yjs_state" CASCADE;--> statement-breakpoint
ALTER TABLE "document_yjs_checkpoints" ADD CONSTRAINT "document_yjs_checkpoints_screenplay_id_screenplays_id_fk" FOREIGN KEY ("screenplay_id") REFERENCES "public"."screenplays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_quarantined_updates" ADD CONSTRAINT "document_yjs_quarantined_updates_screenplay_id_screenplays_id_fk" FOREIGN KEY ("screenplay_id") REFERENCES "public"."screenplays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_quarantined_updates" ADD CONSTRAINT "document_yjs_quarantined_updates_authenticated_actor_id_user_id_fk" FOREIGN KEY ("authenticated_actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_screenplay_id_screenplays_id_fk" FOREIGN KEY ("screenplay_id") REFERENCES "public"."screenplays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_authenticated_actor_id_user_id_fk" FOREIGN KEY ("authenticated_actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_yjs_checkpoints_screenplay_epoch_index" ON "document_yjs_checkpoints" USING btree ("screenplay_id","epoch");--> statement-breakpoint
CREATE INDEX "document_yjs_quarantined_updates_screenplay_epoch_index" ON "document_yjs_quarantined_updates" USING btree ("screenplay_id","epoch");--> statement-breakpoint
CREATE INDEX "document_yjs_updates_screenplay_epoch_index" ON "document_yjs_updates" USING btree ("screenplay_id","epoch");
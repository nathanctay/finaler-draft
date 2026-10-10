ALTER TYPE "public"."revision_kind" ADD VALUE 'restore';--> statement-breakpoint
ALTER TYPE "public"."revision_kind" ADD VALUE 'pre_restore';--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "source_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "previous_head_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "previous_epoch" integer;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "restore_request_id" uuid;--> statement-breakpoint
ALTER TABLE "screenplays" ADD COLUMN "current_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_source_revision_id_document_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_previous_head_revision_id_document_revisions_id_fk" FOREIGN KEY ("previous_head_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_restore_request_id_unique" ON "document_revisions" USING btree ("restore_request_id") WHERE "document_revisions"."restore_request_id" is not null;
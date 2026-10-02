CREATE TYPE "public"."revision_kind" AS ENUM('named', 'idle_session', 'structural_change', 'export');--> statement-breakpoint
CREATE TABLE "document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"screenplay_id" uuid NOT NULL,
	"source_epoch" integer DEFAULT 0 NOT NULL,
	"kind" "revision_kind" NOT NULL,
	"label" text,
	"authored_by" text,
	"canonical_screenplay" jsonb NOT NULL,
	"canonical_hash" varchar(64) NOT NULL,
	"rendered_text" text NOT NULL,
	"preview_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_screenplay_id_screenplays_id_fk" FOREIGN KEY ("screenplay_id") REFERENCES "public"."screenplays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_authored_by_user_id_fk" FOREIGN KEY ("authored_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_revisions_screenplay_id_index" ON "document_revisions" USING btree ("screenplay_id","created_at");
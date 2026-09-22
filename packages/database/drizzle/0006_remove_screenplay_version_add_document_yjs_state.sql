CREATE TABLE "document_yjs_state" (
	"screenplay_id" uuid PRIMARY KEY NOT NULL,
	"state" bytea NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_yjs_state" ADD CONSTRAINT "document_yjs_state_screenplay_id_screenplays_id_fk" FOREIGN KEY ("screenplay_id") REFERENCES "public"."screenplays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenplays" DROP COLUMN "version";
ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "user_deleted_at_index" ON "user" USING btree ("deleted_at");
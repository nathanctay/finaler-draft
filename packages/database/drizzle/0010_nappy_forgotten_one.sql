CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."shared_role" AS ENUM('editor', 'reviewer');--> statement-breakpoint
CREATE TABLE "membership_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"screenplay_id" uuid,
	"invited_user_id" text NOT NULL,
	"invited_by_user_id" text,
	"role" "shared_role" NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screenplay_members" (
	"screenplay_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "shared_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_screenplay_id_screenplays_id_fk" FOREIGN KEY ("screenplay_id") REFERENCES "public"."screenplays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_invited_user_id_user_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenplay_members" ADD CONSTRAINT "screenplay_members_screenplay_id_screenplays_id_fk" FOREIGN KEY ("screenplay_id") REFERENCES "public"."screenplays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenplay_members" ADD CONSTRAINT "screenplay_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_invitation_project_scope_unique" ON "membership_invitations" USING btree ("project_id","invited_user_id") WHERE "membership_invitations"."screenplay_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_invitation_screenplay_scope_unique" ON "membership_invitations" USING btree ("screenplay_id","invited_user_id") WHERE "membership_invitations"."screenplay_id" is not null;--> statement-breakpoint
CREATE INDEX "membership_invitations_invited_user_index" ON "membership_invitations" USING btree ("invited_user_id","status");--> statement-breakpoint
CREATE INDEX "membership_invitations_project_index" ON "membership_invitations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "screenplay_member_unique" ON "screenplay_members" USING btree ("screenplay_id","user_id");--> statement-breakpoint
CREATE INDEX "screenplay_members_user_id_index" ON "screenplay_members" USING btree ("user_id");
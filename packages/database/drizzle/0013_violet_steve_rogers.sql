CREATE INDEX "membership_invitations_resolved_updated_at_index" ON "membership_invitations" USING btree ("updated_at") WHERE "membership_invitations"."status" in ('accepted', 'declined');--> statement-breakpoint
CREATE INDEX "session_expires_at_index" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "stripe_processed_events_processed_at_index" ON "stripe_processed_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "verification_expires_at_index" ON "verification" USING btree ("expires_at");
ALTER TABLE "account_settings" ADD COLUMN "sync_started_at" text;--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN "sync_finished_at" text;--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN "sync_summary" text;--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN "sync_error" text;
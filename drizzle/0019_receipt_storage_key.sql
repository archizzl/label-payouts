ALTER TABLE "expense_files" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "expense_files" ADD COLUMN "storage_key" text;
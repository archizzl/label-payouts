ALTER TABLE "fans" ADD COLUMN "email_key" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "buyer_key" text;--> statement-breakpoint
CREATE INDEX "fans_org_key" ON "fans" USING btree ("org_id","email_key");--> statement-breakpoint
CREATE INDEX "sales_org_buyer" ON "sales" USING btree ("org_id","buyer_key");
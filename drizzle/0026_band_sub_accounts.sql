ALTER TABLE "account_links" ADD COLUMN "managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "account_links_band_org" ON "account_links" USING btree ("band_org_id");
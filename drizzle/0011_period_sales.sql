CREATE TABLE "period_sales" (
	"org_id" text NOT NULL,
	"period_id" integer NOT NULL,
	"dedupe_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "period_sales" ADD CONSTRAINT "period_sales_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_sales" ADD CONSTRAINT "period_sales_period_id_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "period_sales_pk" ON "period_sales" USING btree ("period_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "period_sales_org_key" ON "period_sales" USING btree ("org_id","dedupe_key");--> statement-breakpoint
-- Payouts finalized before this existed: they paid the sales in their dates (and band) that no
-- earlier payout had, which is what they cover today.
INSERT INTO "period_sales" ("org_id", "period_id", "dedupe_key")
SELECT DISTINCT ON (s."id") s."org_id", p."id", s."dedupe_key"
FROM "sales" s
JOIN "periods" p ON p."org_id" = s."org_id" AND s."date" BETWEEN p."start_date" AND p."end_date" AND (p."band_id" IS NULL OR p."band_id" = s."band_id")
ORDER BY s."id", p."id"
ON CONFLICT DO NOTHING;

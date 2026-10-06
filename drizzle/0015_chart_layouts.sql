CREATE TABLE "chart_layouts" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"board_id" text NOT NULL,
	"layout" jsonb NOT NULL,
	"updated_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chart_layouts" ADD CONSTRAINT "chart_layouts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_layouts" ADD CONSTRAINT "chart_layouts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chart_layouts_pk" ON "chart_layouts" USING btree ("user_id","org_id","board_id");
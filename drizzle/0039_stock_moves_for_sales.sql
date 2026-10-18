ALTER TABLE "inventory_moves" ADD COLUMN "sale_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_moves" ADD CONSTRAINT "inventory_moves_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_moves_sale" ON "inventory_moves" USING btree ("sale_id");
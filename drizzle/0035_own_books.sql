ALTER TABLE "account_settings" ADD COLUMN "own_books" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "label_person_id" integer;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_label_person_id_people_id_fk" FOREIGN KEY ("label_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "people_label_person" ON "people" USING btree ("label_person_id");
ALTER TABLE `deductions` ADD `person_id` integer REFERENCES people(id);--> statement-breakpoint
ALTER TABLE `deductions` ADD `format_match` text;
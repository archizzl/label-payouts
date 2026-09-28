CREATE TABLE `outside_artists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`contact_person_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`contact_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outside_artists_name_unique` ON `outside_artists` (`name`);--> statement-breakpoint
ALTER TABLE `bands` ADD `is_label` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `outside_artist_id` integer REFERENCES outside_artists(id);
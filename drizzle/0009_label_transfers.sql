CREATE TABLE `label_transfers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`recipient` text NOT NULL,
	`currency` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`band_id` integer,
	`release_id` integer,
	`method` text,
	`reference` text,
	`note` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`band_id`) REFERENCES `bands`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE set null
);

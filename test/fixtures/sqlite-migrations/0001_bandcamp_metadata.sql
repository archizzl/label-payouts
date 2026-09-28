ALTER TABLE `bands` ADD `image_url` text;--> statement-breakpoint
ALTER TABLE `bands` ADD `location` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `bandcamp_id` integer;--> statement-breakpoint
ALTER TABLE `releases` ADD `kind` text DEFAULT 'album' NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `upc` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `art_url` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `about` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `credits` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `packages` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `synced_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `bandcamp_id` integer;--> statement-breakpoint
ALTER TABLE `tracks` ADD `duration_sec` integer;--> statement-breakpoint
ALTER TABLE `tracks` ADD `artist` text;
-- Payouts are no longer stored as drafts: a draft was only ever a saved preview.
DELETE FROM `periods` WHERE `status` = 'draft';--> statement-breakpoint
ALTER TABLE `people` ADD `holds_label_account` integer DEFAULT false NOT NULL;

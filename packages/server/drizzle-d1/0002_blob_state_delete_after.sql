ALTER TABLE `blob_state` ADD `delete_after` text;--> statement-breakpoint
CREATE INDEX `blob_state_delete_after_idx` ON `blob_state` (`delete_after`);

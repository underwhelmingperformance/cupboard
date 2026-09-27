ALTER TABLE `pending_upload` ADD `settle_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_upload` ADD `settle_retry_after` text;--> statement-breakpoint
ALTER TABLE `pending_upload` ADD `last_settle_error` text;--> statement-breakpoint
CREATE INDEX `pending_upload_settle_retry_after_idx` ON `pending_upload` (`settle_retry_after`) WHERE "pending_upload"."verdict" = 'pending' OR "pending_upload"."verdict" = 'committing';

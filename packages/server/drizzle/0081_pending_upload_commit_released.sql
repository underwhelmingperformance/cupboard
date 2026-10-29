ALTER TABLE `pending_upload` ADD `commit_released` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `pending_upload_unreleased_commit_idx` ON `pending_upload` (`cache_id`, json_extract(`metadata_json`, '$.storePathHash'), `nar_hash`) WHERE `verdict` IN ('committing', 'pending') AND `commit_released` = 0;

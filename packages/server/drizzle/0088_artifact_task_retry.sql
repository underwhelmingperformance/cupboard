ALTER TABLE `artifact_task` ADD `next_attempt_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
CREATE INDEX `artifact_task_retry_idx` ON `artifact_task` (`job_id`,`state`,`next_attempt_at`,`id`);

ALTER TABLE `artifact_job` ADD `next_dispatch_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `artifact_job` ADD `dispatch_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `artifact_job_dispatch_idx` ON `artifact_job` (`state`,`next_dispatch_at`,`id`);

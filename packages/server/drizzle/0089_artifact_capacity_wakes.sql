ALTER TABLE `artifact_job` ADD `capacity_wait_at` integer;--> statement-breakpoint
ALTER TABLE `artifact_job` ADD `capacity_wait_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `artifact_job` ADD `capacity_wait_staged` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `artifact_job_capacity_idx` ON `artifact_job` (`state`,`capacity_wait_bytes`,`capacity_wait_staged`,`capacity_wait_at`,`id`) WHERE "artifact_job"."capacity_wait_at" IS NOT NULL;

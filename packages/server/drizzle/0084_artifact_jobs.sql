CREATE TABLE `artifact_job` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`cache_generation` integer NOT NULL,
	`definition` text NOT NULL,
	`generation` integer NOT NULL,
	`state` text NOT NULL,
	`discovery_complete` integer DEFAULT false NOT NULL,
	`cursor` text,
	`discovered` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "artifact_job_generation_check" CHECK("artifact_job"."generation" >= 1),
	CONSTRAINT "artifact_job_progress_check" CHECK("artifact_job"."discovered" >= 0 AND "artifact_job"."completed" >= 0 AND "artifact_job"."skipped" >= 0 AND "artifact_job"."failed" >= 0 AND "artifact_job"."completed" + "artifact_job"."skipped" + "artifact_job"."failed" <= "artifact_job"."discovered"),
	CONSTRAINT "artifact_job_completion_check" CHECK("artifact_job"."state" != 'complete' OR ("artifact_job"."discovery_complete" = 1 AND "artifact_job"."completed" + "artifact_job"."skipped" + "artifact_job"."failed" = "artifact_job"."discovered" AND "artifact_job"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `artifact_job_cache_idx` ON `artifact_job` (`cache_id`,`id`);--> statement-breakpoint
CREATE INDEX `artifact_job_state_idx` ON `artifact_job` (`state`,`id`);--> statement-breakpoint
CREATE TABLE `artifact_task` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`source_key` text NOT NULL,
	`source` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`claim_generation` integer DEFAULT 0 NOT NULL,
	`job_generation` integer DEFAULT 0 NOT NULL,
	`owner` text,
	`lease_expires_at` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "artifact_task_generation_check" CHECK("artifact_task"."claim_generation" >= 0 AND "artifact_task"."job_generation" >= 0),
	CONSTRAINT "artifact_task_claim_check" CHECK("artifact_task"."state" != 'claimed' OR ("artifact_task"."owner" IS NOT NULL AND "artifact_task"."lease_expires_at" IS NOT NULL AND "artifact_task"."claim_generation" > 0 AND "artifact_task"."job_generation" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_task_source_idx` ON `artifact_task` (`job_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `artifact_task_state_idx` ON `artifact_task` (`job_id`,`state`,`id`);--> statement-breakpoint
CREATE INDEX `artifact_task_lease_idx` ON `artifact_task` (`job_id`,`state`,`lease_expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `artifact_task_job_generation_idx` ON `artifact_task` (`job_id`,`state`,`job_generation`,`id`);

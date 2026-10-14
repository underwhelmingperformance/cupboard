CREATE TABLE `artifact_admission` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`job_generation` integer NOT NULL,
	`cache_generation` integer NOT NULL,
	`task_id` text NOT NULL,
	`task_generation` integer NOT NULL,
	`source_key` text NOT NULL,
	`kind` text NOT NULL,
	`maximum_bytes` integer NOT NULL,
	`stage_id` text,
	`claim_json` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT "artifact_admission_generation_check" CHECK("artifact_admission"."job_generation" >= 1 AND "artifact_admission"."cache_generation" >= 1 AND "artifact_admission"."task_generation" >= 0),
	CONSTRAINT "artifact_admission_bytes_check" CHECK("artifact_admission"."maximum_bytes" >= 0 AND "artifact_admission"."maximum_bytes" <= 67108864)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_admission_task_idx` ON `artifact_admission` (`task_id`);--> statement-breakpoint
CREATE INDEX `artifact_admission_expiry_idx` ON `artifact_admission` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `artifact_admission_stage_idx` ON `artifact_admission` (`stage_id`);

CREATE TABLE `artifact_stage` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`cache_generation` integer NOT NULL,
	`job_id` text NOT NULL,
	`job_generation` integer NOT NULL,
	`task_id` text NOT NULL,
	`task_generation` integer NOT NULL,
	`source_key` text NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`maximum_bytes` integer NOT NULL,
	`state` text NOT NULL,
	`multipart_id` text,
	`writes_sealed` integer DEFAULT false NOT NULL,
	`digest` text,
	`size` integer,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`write_until` text NOT NULL,
	`cleanup_after` text NOT NULL,
	`next_cleanup_at` text NOT NULL,
	CONSTRAINT "artifact_stage_budget_check" CHECK("artifact_stage"."maximum_bytes" BETWEEN 1 AND 67108864 AND ("artifact_stage"."size" IS NULL OR "artifact_stage"."size" BETWEEN 0 AND "artifact_stage"."maximum_bytes")),
	CONSTRAINT "artifact_stage_seal_check" CHECK("artifact_stage"."writes_sealed" = 0 OR ("artifact_stage"."multipart_id" IS NOT NULL AND "artifact_stage"."digest" IS NOT NULL AND "artifact_stage"."size" IS NOT NULL)),
	CONSTRAINT "artifact_stage_ready_check" CHECK("artifact_stage"."state" != 'ready' OR "artifact_stage"."writes_sealed" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_stage_task_idx` ON `artifact_stage` (`task_id`,`task_generation`);--> statement-breakpoint
CREATE INDEX `artifact_stage_cleanup_idx` ON `artifact_stage` (`state`,`next_cleanup_at`,`id`);

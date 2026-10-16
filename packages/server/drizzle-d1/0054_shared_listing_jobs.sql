CREATE TABLE `shared_listing_job` (
	`id` text PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`generator_revision` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`phase` text DEFAULT 'historical' NOT NULL,
	`cursor` text,
	`discovered` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`claim_generation` integer DEFAULT 0 NOT NULL,
	`owner` text,
	`lease_expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "shared_listing_job_generation_check" CHECK("shared_listing_job"."generation" BETWEEN 1 AND 9007199254740991 AND "shared_listing_job"."claim_generation" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "shared_listing_job_state_check" CHECK("shared_listing_job"."state" IN ('running', 'cancelled', 'complete') AND "shared_listing_job"."phase" IN ('historical', 'catchup', 'processing')),
	CONSTRAINT "shared_listing_job_progress_check" CHECK("shared_listing_job"."completed" >= 0 AND "shared_listing_job"."skipped" >= 0 AND "shared_listing_job"."failed" >= 0 AND "shared_listing_job"."discovered" BETWEEN 0 AND 9007199254740991 AND "shared_listing_job"."discovered" >= "shared_listing_job"."completed" + "shared_listing_job"."skipped" + "shared_listing_job"."failed"),
	CONSTRAINT "shared_listing_job_owner_check" CHECK(("shared_listing_job"."owner" IS NULL AND "shared_listing_job"."lease_expires_at" IS NULL) OR ("shared_listing_job"."owner" IS NOT NULL AND "shared_listing_job"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `shared_listing_task` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`nar_hash` text NOT NULL,
	`source_incarnation` integer NOT NULL,
	`nar_size` integer NOT NULL,
	`file_size` integer NOT NULL,
	`discovery_page` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "shared_listing_task_source_check" CHECK("shared_listing_task"."source_incarnation" >= 1 AND "shared_listing_task"."nar_size" >= 0 AND "shared_listing_task"."file_size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_listing_task_source_idx` ON `shared_listing_task` (`job_id`,`nar_hash`);--> statement-breakpoint
CREATE INDEX `shared_listing_task_page_idx` ON `shared_listing_task` (`discovery_page`);

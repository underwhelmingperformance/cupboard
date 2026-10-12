CREATE TABLE `attestation_list_refresh_chunk` (
	`job_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`body` text NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`job_id`, `sequence`)
);

--> statement-breakpoint
CREATE TABLE `attestation_list_refresh_job` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer,
	`slot` integer DEFAULT 1 NOT NULL,
	`source` text NOT NULL,
	`key` text NOT NULL,
	`upload_id` text,
	`phase` text DEFAULT 'collecting' NOT NULL,
	`after` text,
	`read_sequence` integer DEFAULT 0 NOT NULL,
	`read_offset` integer DEFAULT 0 NOT NULL,
	`next_sequence` integer DEFAULT 0 NOT NULL,
	`buffered_bytes` integer DEFAULT 0 NOT NULL,
	`next_part` integer DEFAULT 1 NOT NULL,
	`completed_bytes` integer DEFAULT 0 NOT NULL,
	`has_entries` integer DEFAULT false NOT NULL,
	`is_final` integer DEFAULT false NOT NULL,
	`cleanup_not_before` integer DEFAULT 0 NOT NULL,
	`cleanup_at` integer,
	CONSTRAINT "attestation_list_refresh_slot_check" CHECK("attestation_list_refresh_job"."slot" = 1)
);

--> statement-breakpoint
CREATE UNIQUE INDEX `attestation_list_refresh_active_idx` ON `attestation_list_refresh_job` (`slot`) WHERE "attestation_list_refresh_job"."cleanup_at" IS NULL;
--> statement-breakpoint
CREATE INDEX `attestation_list_refresh_cleanup_idx` ON `attestation_list_refresh_job` (`cleanup_at`,`id`);
--> statement-breakpoint
CREATE INDEX `attestation_list_refresh_key_idx` ON `attestation_list_refresh_job` (`key`,`cleanup_not_before`);
--> statement-breakpoint
CREATE INDEX `attestation_list_refresh_cache_idx` ON `attestation_list_refresh_job` (`cache_id`,`id`);
--> statement-breakpoint
CREATE TABLE `attestation_list_refresh_lease` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "attestation_list_refresh_lease_singleton" CHECK("attestation_list_refresh_lease"."id" = 1)
);

--> statement-breakpoint
CREATE TABLE `attestation_list_refresh_part` (
	`job_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`etag` text NOT NULL,
	PRIMARY KEY(`job_id`, `part_number`)
);

--> statement-breakpoint
CREATE TABLE `attestation_list_refresh_retry` (
	`revision_id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`cache_id` integer,
	`not_before` integer NOT NULL,
	`failure` text NOT NULL
);

--> statement-breakpoint
CREATE TABLE `attestation_list_refresh_wake` (
	`id` integer PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	CONSTRAINT "attestation_list_refresh_wake_singleton" CHECK("attestation_list_refresh_wake"."id" = 1)
);

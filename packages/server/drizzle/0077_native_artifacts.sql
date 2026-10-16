CREATE TABLE `artifact_parent` (
	`artifact_id` text NOT NULL,
	`artifact_generation` integer NOT NULL,
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`publication_generation` integer NOT NULL,
	PRIMARY KEY(`artifact_id`, `artifact_generation`, `store_path_hash`, `publication_generation`)
);

--> statement-breakpoint
CREATE INDEX `artifact_parent_publication_idx` ON `artifact_parent` (`cache_id`,`store_path_hash`,`publication_generation`,`artifact_id`);
--> statement-breakpoint
CREATE TABLE `artifact_reference_deletion` (
	`artifact_id` text NOT NULL,
	`artifact_generation` integer NOT NULL,
	`cache_id` integer NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`artifact_id`, `artifact_generation`)
);

--> statement-breakpoint
CREATE INDEX `artifact_reference_deletion_cache_idx` ON `artifact_reference_deletion` (`cache_id`);
--> statement-breakpoint
CREATE TABLE `artifact_root` (
	`artifact_id` text NOT NULL,
	`artifact_generation` integer NOT NULL,
	`kind` text NOT NULL,
	`expires_at` text,
	PRIMARY KEY(`artifact_id`, `artifact_generation`, `kind`),
	CONSTRAINT "artifact_root_expiry_check" CHECK(("artifact_root"."kind" = 'cache-lifetime' AND "artifact_root"."expires_at" IS NULL) OR ("artifact_root"."kind" = 'expiry' AND "artifact_root"."expires_at" IS NOT NULL))
);

--> statement-breakpoint
CREATE INDEX `artifact_root_expiry_idx` ON `artifact_root` (`expires_at`,`artifact_id`);
--> statement-breakpoint
CREATE TABLE `artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`generation` integer NOT NULL,
	`kind` text NOT NULL,
	`digest` text NOT NULL,
	`publication_incarnation` integer NOT NULL,
	`state` text NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "artifact_generation_check" CHECK("artifact"."generation" >= 1),
	CONSTRAINT "artifact_incarnation_check" CHECK("artifact"."publication_incarnation" >= 1),
	CONSTRAINT "artifact_log_expiry_check" CHECK("artifact"."kind" != 'build-log' OR "artifact"."expires_at" IS NOT NULL),
	CONSTRAINT "artifact_completion_check" CHECK("artifact"."state" != 'live' OR "artifact"."completed_at" IS NOT NULL)
);

--> statement-breakpoint
CREATE INDEX `artifact_cache_idx` ON `artifact` (`cache_id`,`id`);
--> statement-breakpoint
CREATE INDEX `artifact_digest_idx` ON `artifact` (`digest`,`id`);
--> statement-breakpoint
CREATE INDEX `artifact_expiry_idx` ON `artifact` (`expires_at`,`id`);
--> statement-breakpoint
CREATE INDEX `artifact_pending_idx` ON `artifact` (`state`,`id`);
--> statement-breakpoint
CREATE TABLE `build_log` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`derivation` text NOT NULL,
	`attempt_id` text,
	`source_kind` text NOT NULL,
	`source_description` text NOT NULL,
	`captured_at` text NOT NULL,
	`completeness` text NOT NULL,
	`outcome` text NOT NULL
);

--> statement-breakpoint
CREATE INDEX `build_log_derivation_idx` ON `build_log` (`cache_id`,`derivation`,`captured_at`,`artifact_id`);
--> statement-breakpoint
CREATE INDEX `build_log_attempt_idx` ON `build_log` (`cache_id`,`attempt_id`);
--> statement-breakpoint
CREATE TABLE `build_trace_mapping` (
	`cache_id` integer NOT NULL,
	`derivation` text NOT NULL,
	`output_name` text NOT NULL,
	`output_path` text NOT NULL,
	`artifact_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`cache_id`, `derivation`, `output_name`)
);

--> statement-breakpoint
CREATE INDEX `build_trace_mapping_artifact_idx` ON `build_trace_mapping` (`artifact_id`);
--> statement-breakpoint
CREATE TABLE `listing_generation_proof` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`listing_artifact_id` text NOT NULL,
	`predicate_type` text NOT NULL,
	`signing_key` text NOT NULL,
	`created_at` text NOT NULL
);

--> statement-breakpoint
CREATE INDEX `listing_generation_proof_listing_idx` ON `listing_generation_proof` (`listing_artifact_id`);
--> statement-breakpoint
CREATE TABLE `nar_listing` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`nar_hash` text NOT NULL,
	`generator_revision` text NOT NULL,
	`format` integer NOT NULL,
	CONSTRAINT "nar_listing_format_check" CHECK("nar_listing"."format" = 1)
);

--> statement-breakpoint
CREATE UNIQUE INDEX `nar_listing_identity_idx` ON `nar_listing` (`cache_id`,`nar_hash`,`generator_revision`);

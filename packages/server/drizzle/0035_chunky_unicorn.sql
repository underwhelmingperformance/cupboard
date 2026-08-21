CREATE TABLE `cache_purge_continuation` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`signing_key_id` text,
	`entries_json` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_attempt_at` text,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `cache_purge_kind_created_at_idx` ON `cache_purge_continuation` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `signing_key_backfill` (
	`key_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`resigned` integer DEFAULT 0 NOT NULL,
	`failure_operation` text,
	`failed_at` text,
	`failure_message` text
);
--> statement-breakpoint
CREATE TABLE `signing_key_sequence` (
	`id` text PRIMARY KEY NOT NULL,
	`next_generation` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `narinfo` ADD `signature_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narinfo` ADD `pending_signature_generation` integer;--> statement-breakpoint
CREATE INDEX `narinfo_pending_signature_generation_idx` ON `narinfo` (`pending_signature_generation`,`signature_generation`,`cache`,`store_path_hash`);--> statement-breakpoint
CREATE INDEX `narinfo_signature_generation_idx` ON `narinfo` (`signature_generation`);--> statement-breakpoint
ALTER TABLE `signing_key` ADD `generation` integer DEFAULT 0 NOT NULL;

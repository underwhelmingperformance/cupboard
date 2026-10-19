CREATE TABLE `publication_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`cache_generation` integer NOT NULL,
	`push_id` text NOT NULL,
	`canonical_json` text NOT NULL,
	`accepted_at` text NOT NULL,
	`push_expires_at` text NOT NULL,
	`recovery_deadline` text NOT NULL,
	`prune_after` text NOT NULL,
	`blob_json` text,
	`grace_decision_json` text NOT NULL,
	`grace_deadline` text,
	`root_expires_at` text,
	`state` text DEFAULT 'accepted' NOT NULL,
	`result_json` text
);
--> statement-breakpoint
CREATE INDEX `publication_operation_prune_idx` ON `publication_operation` (`state`,`prune_after`);--> statement-breakpoint
CREATE INDEX `publication_operation_deadline_idx` ON `publication_operation` (`state`,`recovery_deadline`);--> statement-breakpoint
ALTER TABLE `pending_upload` ADD `recovery_deadline` text;

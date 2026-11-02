CREATE TABLE `confirmation_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`cache_generation` integer NOT NULL,
	`push_id` text NOT NULL,
	`canonical_json` text NOT NULL,
	`retention_epoch` integer NOT NULL,
	`grace_decision_json` text NOT NULL,
	`grace_deadline` text,
	`result_json` text NOT NULL,
	`accepted_at` text NOT NULL,
	`push_expires_at` text NOT NULL,
	`recovery_deadline` text NOT NULL,
	`prune_after` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `confirmation_receipt_prune_idx` ON `confirmation_receipt` (`prune_after`);

CREATE TABLE `control_consumed_subject_nonce` (
	`nonce` text PRIMARY KEY NOT NULL,
	`family_id` text,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `control_consumed_subject_nonce_expires_at_idx` ON `control_consumed_subject_nonce` (`expires_at`);

CREATE TABLE `consumed_subject_nonce` (
	`nonce` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `consumed_subject_nonce_expires_at_idx` ON `consumed_subject_nonce` (`expires_at`);

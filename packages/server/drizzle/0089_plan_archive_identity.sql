CREATE TABLE `plan_archive_identity` (
	`ticket` text PRIMARY KEY NOT NULL,
	`binding` text NOT NULL,
	`identity` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plan_archive_identity_expiry_idx` ON `plan_archive_identity` (`expires_at`);

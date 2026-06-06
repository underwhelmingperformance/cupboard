CREATE TABLE `tenant_maintenance_eligibility` (
	`tenant` text PRIMARY KEY NOT NULL,
	`pending_verification_count` integer DEFAULT 0 NOT NULL,
	`earliest_upload_expiry` text,
	`queued_narinfo_deletion_count` integer DEFAULT 0 NOT NULL,
	`earliest_root_expiry` text,
	`next_maintenance_at` text,
	`reconciled_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tenant_maintenance_eligibility_due_idx` ON `tenant_maintenance_eligibility` (`next_maintenance_at`,`reconciled_at`);

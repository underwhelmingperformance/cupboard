CREATE INDEX `auth_key_retirement_idx` ON `auth_key` (`retired_at`,`scheduled_retire_at`);--> statement-breakpoint
CREATE INDEX `pending_upload_expires_at_idx` ON `pending_upload` (`expires_at`);--> statement-breakpoint
CREATE INDEX `pending_upload_verdict_idx` ON `pending_upload` (`verdict`);--> statement-breakpoint
CREATE INDEX `retention_root_expires_at_idx` ON `retention_root` (`expires_at`);

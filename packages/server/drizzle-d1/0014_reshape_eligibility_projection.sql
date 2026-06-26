ALTER TABLE `tenant_maintenance_eligibility` DROP COLUMN `pending_verification_count`;--> statement-breakpoint
ALTER TABLE `tenant_maintenance_eligibility` DROP COLUMN `earliest_upload_expiry`;--> statement-breakpoint
ALTER TABLE `tenant_maintenance_eligibility` DROP COLUMN `queued_narinfo_deletion_count`;--> statement-breakpoint
ALTER TABLE `tenant_maintenance_eligibility` DROP COLUMN `earliest_root_expiry`;--> statement-breakpoint
ALTER TABLE `tenant_maintenance_eligibility` RENAME COLUMN `next_maintenance_at` TO `next_wake_at`;

CREATE TABLE `control_database_split` (
	`id` text PRIMARY KEY NOT NULL,
	`target_database_id` text NOT NULL,
	`frozen_at` text NOT NULL,
	`copied_at` text
);
--> statement-breakpoint
CREATE TRIGGER `control_auth_key_split_freeze_insert` BEFORE INSERT ON `control_auth_key` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_auth_key_split_freeze_update` BEFORE UPDATE ON `control_auth_key` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_auth_key_split_freeze_delete` BEFORE DELETE ON `control_auth_key` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_trust_split_freeze_insert` BEFORE INSERT ON `control_trust` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_trust_split_freeze_update` BEFORE UPDATE ON `control_trust` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_trust_split_freeze_delete` BEFORE DELETE ON `control_trust` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_refresh_session_family_split_freeze_insert` BEFORE INSERT ON `control_refresh_session_family` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_refresh_session_family_split_freeze_update` BEFORE UPDATE ON `control_refresh_session_family` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_refresh_session_family_split_freeze_delete` BEFORE DELETE ON `control_refresh_session_family` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_refresh_session_member_split_freeze_insert` BEFORE INSERT ON `control_refresh_session_member` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_refresh_session_member_split_freeze_update` BEFORE UPDATE ON `control_refresh_session_member` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_refresh_session_member_split_freeze_delete` BEFORE DELETE ON `control_refresh_session_member` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_consumed_subject_nonce_split_freeze_insert` BEFORE INSERT ON `control_consumed_subject_nonce` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_consumed_subject_nonce_split_freeze_update` BEFORE UPDATE ON `control_consumed_subject_nonce` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `control_consumed_subject_nonce_split_freeze_delete` BEFORE DELETE ON `control_consumed_subject_nonce` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `global_admin_split_freeze_insert` BEFORE INSERT ON `global_admin` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `global_admin_split_freeze_update` BEFORE UPDATE ON `global_admin` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `global_admin_split_freeze_delete` BEFORE DELETE ON `global_admin` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `tenant_maintenance_failure_split_freeze_insert` BEFORE INSERT ON `tenant_maintenance_failure` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `tenant_maintenance_failure_split_freeze_update` BEFORE UPDATE ON `tenant_maintenance_failure` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;
--> statement-breakpoint
CREATE TRIGGER `tenant_maintenance_failure_split_freeze_delete` BEFORE DELETE ON `tenant_maintenance_failure` WHEN EXISTS (SELECT 1 FROM `control_database_split` WHERE `id` = 'current') BEGIN SELECT RAISE(ABORT, 'control database migration pending'); END;

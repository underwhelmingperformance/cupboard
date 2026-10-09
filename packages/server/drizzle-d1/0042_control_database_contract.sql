CREATE TABLE `control_database_contract_assertion` (`ready` integer NOT NULL CHECK (`ready` = 1));
--> statement-breakpoint
INSERT INTO `control_database_contract_assertion` SELECT count(*) FROM `control_database_split` WHERE `id` = 'current' AND `copied_at` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `control_database_contract_assertion`;
--> statement-breakpoint
DROP TABLE `control_auth_key`;
--> statement-breakpoint
DROP TABLE `control_trust`;
--> statement-breakpoint
DROP TABLE `control_refresh_session_family`;
--> statement-breakpoint
DROP TABLE `control_refresh_session_member`;
--> statement-breakpoint
DROP TABLE `control_consumed_subject_nonce`;
--> statement-breakpoint
DROP TABLE `global_admin`;
--> statement-breakpoint
DROP TABLE `tenant_maintenance_failure`;

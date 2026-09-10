PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenant` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`read_mode` text,
	`owner_issuer` text NOT NULL,
	`owner_subject` text NOT NULL,
	`owner_audience` text NOT NULL,
	`config_version` integer NOT NULL,
	`cache_catalogue_version` integer,
	`created_at` text NOT NULL,
	`read_user` text,
	`read_password_hash` text,
	`read_password_salt` text,
	`last_maintained_at` text
);
--> statement-breakpoint
INSERT INTO `__new_tenant`("id", "status", "read_mode", "owner_issuer", "owner_subject", "owner_audience", "config_version", "cache_catalogue_version", "created_at", "read_user", "read_password_hash", "read_password_salt", "last_maintained_at") SELECT "id", "status", "read_mode", "owner_issuer", "owner_subject", "owner_audience", "config_version", "cache_catalogue_version", "created_at", "read_user", "read_password_hash", "read_password_salt", "last_maintained_at" FROM `tenant`;--> statement-breakpoint
DROP TABLE `tenant`;--> statement-breakpoint
ALTER TABLE `__new_tenant` RENAME TO `tenant`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tenant_maintenance_idx` ON `tenant` (`status`,`last_maintained_at`);

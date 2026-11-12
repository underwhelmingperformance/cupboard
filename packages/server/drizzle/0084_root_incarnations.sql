CREATE TABLE `retention_root_release` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cache_id` integer NOT NULL,
	`root_name` text NOT NULL,
	`incarnation` integer,
	`released_at` text NOT NULL,
	`retain_until` text,
	`close_retention_epoch` integer
);
--> statement-breakpoint
CREATE INDEX `retention_root_release_cache_idx` ON `retention_root_release` (`cache_id`,`id`);--> statement-breakpoint
CREATE INDEX `retention_root_release_root_idx` ON `retention_root_release` (`cache_id`,`root_name`,`incarnation`);--> statement-breakpoint
ALTER TABLE `retention_root_target` ADD `incarnation` integer;--> statement-breakpoint
CREATE INDEX `retention_root_target_incarnation_idx` ON `retention_root_target` (`incarnation`,`store_path_hash`) WHERE "retention_root_target"."incarnation" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `retention_root_target_legacy_idx` ON `retention_root_target` (`cache_id`,`root_name`) WHERE "retention_root_target"."incarnation" IS NULL;--> statement-breakpoint
ALTER TABLE `retention_root` ADD `incarnation` integer;

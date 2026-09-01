ALTER TABLE `cache_identity` ADD `lifecycle_state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `creation_expires_at` text;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `management_kind` text DEFAULT 'durable' NOT NULL;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `managed_policy_id` text;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `managed_policy_revision` integer;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `managed_group_id` text;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `selection_state` text;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `update_hold` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `cache_managed_group_selection_idx` ON `cache_identity` (`managed_group_id`,`access`,`lifecycle_state`,`selection_state`);

CREATE TABLE `managed_cache_group` (
	`tenant` text NOT NULL,
	`id` text NOT NULL,
	`access` text NOT NULL,
	`reuse_view_name` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_cache_group_view_idx` ON `managed_cache_group` (`tenant`,`reuse_view_name`);--> statement-breakpoint
CREATE TABLE `managed_policy_family` (
	`tenant` text NOT NULL,
	`id` text NOT NULL,
	`owner_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`cache_namespace` text NOT NULL,
	`status` text NOT NULL,
	`current_revision` integer NOT NULL,
	`pending_revision` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_policy_repository_idx` ON `managed_policy_family` (`tenant`,`repository_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `managed_policy_namespace_idx` ON `managed_policy_family` (`tenant`,`cache_namespace`);--> statement-breakpoint
CREATE TABLE `managed_policy_revision` (
	`tenant` text NOT NULL,
	`policy_id` text NOT NULL,
	`revision` integer NOT NULL,
	`group_id` text NOT NULL,
	`access` text NOT NULL,
	`priority` integer NOT NULL,
	`default_root_ttl_seconds` integer,
	`maximum_root_duration_seconds` integer NOT NULL,
	`allow_permanent_roots` integer NOT NULL,
	`grace_seconds` integer,
	`creation_lease_seconds` integer NOT NULL,
	`provisional_lease_seconds` integer NOT NULL,
	`activity_lease_seconds` integer NOT NULL,
	`maximum_live_caches` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `policy_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `managed_policy_revision_group_idx` ON `managed_policy_revision` (`tenant`,`group_id`,`revision`);--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `creation_expires_at` text;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `management_kind` text DEFAULT 'durable' NOT NULL;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `managed_policy_id` text;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `managed_policy_revision` integer;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `managed_group_id` text;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `selection_state` text;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `update_hold` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `cache_lifecycle_managed_capacity_idx` ON `cache_lifecycle` (`tenant`,`managed_policy_id`,`state`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `cache_lifecycle_managed_group_selection_idx` ON `cache_lifecycle` (`tenant`,`managed_group_id`,`access`,`state`,`selection_state`);

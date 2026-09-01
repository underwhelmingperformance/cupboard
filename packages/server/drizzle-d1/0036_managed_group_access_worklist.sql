CREATE TABLE `managed_group_access_transition_cache` (
	`tenant` text NOT NULL,
	`transition_id` text NOT NULL,
	`cache_name` text NOT NULL,
	`generation` integer NOT NULL,
	`target_read_revision` integer NOT NULL,
	`policy_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	PRIMARY KEY(`tenant`, `transition_id`, `cache_name`)
);
--> statement-breakpoint
CREATE INDEX `managed_group_access_transition_cache_work_idx` ON `managed_group_access_transition_cache` (`tenant`,`transition_id`,`state`,`cache_name`);--> statement-breakpoint
ALTER TABLE `managed_group_access_transition` ADD `target_group_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `managed_group_access_transition` ADD `phase` text DEFAULT 'cancel-creations' NOT NULL;--> statement-breakpoint
ALTER TABLE `managed_group_access_transition` ADD `policy_cursor` text;--> statement-breakpoint
ALTER TABLE `managed_group_access_transition` ADD `cache_cursor` text;--> statement-breakpoint
ALTER TABLE `managed_group_access_transition` DROP COLUMN `cache_worklist_json`;

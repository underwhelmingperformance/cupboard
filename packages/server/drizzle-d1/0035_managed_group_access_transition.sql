CREATE TABLE `managed_group_access_transition` (
	`tenant` text NOT NULL,
	`id` text NOT NULL,
	`group_id` text NOT NULL,
	`source_access` text NOT NULL,
	`target_access` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_failure_json` text,
	`participant_policies_json` text DEFAULT '[]' NOT NULL,
	`cache_worklist_json` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`tenant`, `id`),
	CONSTRAINT "managed_group_access_transition_access_check" CHECK(`source_access` IN ('public', 'private') AND `target_access` IN ('public', 'private') AND `source_access` <> `target_access`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_group_access_transition_active_idx` ON `managed_group_access_transition` (`tenant`,`group_id`) WHERE `status` IN ('running', 'finalising');
--> statement-breakpoint
CREATE INDEX `managed_group_access_transition_work_idx` ON `managed_group_access_transition` (`tenant`,`status`,`group_id`);
--> statement-breakpoint
ALTER TABLE `managed_cache_group` ADD `reuse_view_priority` integer NOT NULL DEFAULT 50;

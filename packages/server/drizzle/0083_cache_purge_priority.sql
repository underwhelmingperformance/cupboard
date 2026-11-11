DROP INDEX `cache_purge_kind_created_at_idx`;--> statement-breakpoint
ALTER TABLE `cache_purge_continuation` ADD `priority` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `cache_purge_kind_priority_created_at_idx` ON `cache_purge_continuation` (`kind`,`priority`,`created_at`);

ALTER TABLE `cache_teardown` ADD `next_work_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `cache_teardown` ADD `origin` text;
--> statement-breakpoint
CREATE INDEX `cache_teardown_work_idx` ON `cache_teardown` (`next_work_at`,`cache_id`);

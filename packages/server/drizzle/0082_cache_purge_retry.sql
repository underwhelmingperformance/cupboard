ALTER TABLE `cache_purge_continuation` ADD `next_attempt_at` text;--> statement-breakpoint
ALTER TABLE `cache_purge_continuation` ADD `failed_attempts` integer DEFAULT 0 NOT NULL;

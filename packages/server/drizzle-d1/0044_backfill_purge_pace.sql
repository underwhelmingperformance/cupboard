CREATE TABLE IF NOT EXISTS `backfill_purge_pace` (
	`id` text PRIMARY KEY NOT NULL,
	`next_at` integer NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `backfill_purge_pace` (`id`, `next_at`) VALUES ('backfill', 0);

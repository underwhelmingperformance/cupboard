CREATE TABLE `root_target_count_backfill` (
	`id` integer PRIMARY KEY NOT NULL,
	`rowid_high_water` integer NOT NULL,
	`cursor` integer NOT NULL,
	CONSTRAINT "root_target_count_backfill_id_check" CHECK("root_target_count_backfill"."id" = 1),
	CONSTRAINT "root_target_count_backfill_cursor_check" CHECK("root_target_count_backfill"."cursor" BETWEEN 0 AND "root_target_count_backfill"."rowid_high_water")
);
--> statement-breakpoint
ALTER TABLE `retention_root` ADD `target_count` integer;--> statement-breakpoint
INSERT OR IGNORE INTO `root_target_count_backfill` (`id`, `rowid_high_water`, `cursor`)
SELECT 1, coalesce((SELECT max(rowid) FROM `retention_root`), 0), 0;

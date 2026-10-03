ALTER TABLE `pending_upload` ADD `nar_refresh_pending` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE `__new_narinfo` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`store_path` text NOT NULL,
	`nar_hash` text NOT NULL,
	`nar_size` integer NOT NULL,
	`references_json` text NOT NULL,
	`deriver` text,
	`ca` text,
	`sigs_json` text DEFAULT '[]' NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`signature_generation` integer DEFAULT 0 NOT NULL,
	`pending_signature_generation` integer,
	`created_at` text NOT NULL,
	PRIMARY KEY(`cache_id`, `store_path_hash`)
);
--> statement-breakpoint
INSERT OR REPLACE INTO `__new_narinfo`(rowid, "cache_id", "store_path_hash", "store_path", "nar_hash", "nar_size", "references_json", "deriver", "ca", "sigs_json", "generation", "signature_generation", "pending_signature_generation", "created_at") SELECT rowid, "cache_id", "store_path_hash", "store_path", "nar_hash", "nar_size", "references_json", "deriver", "ca", "sigs_json", "generation", "signature_generation", "pending_signature_generation", "created_at" FROM `narinfo`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_barrier_narinfo_insert`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_barrier_narinfo_update`;
--> statement-breakpoint
DROP TRIGGER `cache_narinfo_count_insert`;
--> statement-breakpoint
DROP TRIGGER `cache_narinfo_count_delete`;
--> statement-breakpoint
DROP TRIGGER `cache_narinfo_count_update_cache`;
--> statement-breakpoint
DROP TRIGGER `managed_retirement_narinfo_delete`;
--> statement-breakpoint
DROP TABLE `narinfo`;
--> statement-breakpoint
ALTER TABLE `__new_narinfo` RENAME TO `narinfo`;
--> statement-breakpoint
CREATE INDEX `narinfo_store_path_hash_cache_idx` ON `narinfo` (`store_path_hash`,`cache_id`);
--> statement-breakpoint
CREATE INDEX `narinfo_pending_signature_generation_idx` ON `narinfo` (`pending_signature_generation`,`signature_generation`,`cache_id`,`store_path_hash`);
--> statement-breakpoint
CREATE INDEX `narinfo_signature_generation_idx` ON `narinfo` (`signature_generation`);
--> statement-breakpoint
CREATE INDEX `narinfo_nar_hash_cache_id_store_path_hash_idx` ON `narinfo` (`nar_hash`,`cache_id`,`store_path_hash`);
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_narinfo_insert`
AFTER INSERT ON `narinfo`
WHEN EXISTS (
	SELECT 1 FROM `garbage_collection_mark`
	WHERE `cache_id` = NEW.`cache_id` AND `store_path_hash` = NEW.`store_path_hash`
)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_narinfo_update`
AFTER UPDATE OF `cache_id`, `store_path_hash`, `references_json` ON `narinfo`
WHEN EXISTS (
	SELECT 1 FROM `garbage_collection_mark`
	WHERE `cache_id` = NEW.`cache_id` AND `store_path_hash` = NEW.`store_path_hash`
)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `cache_narinfo_count_insert`
AFTER INSERT ON `narinfo`
WHEN NEW.`cache_id` IS NOT NULL AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`narinfo_complete`
		OR NEW.rowid <= `narinfo_cursor`
		OR NEW.rowid > `narinfo_initial_rowid_high_water`
	)
)
BEGIN
	INSERT INTO `cache_narinfo_count` (`cache_id`, `count`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `count` = `count` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `cache_narinfo_count_delete`
AFTER DELETE ON `narinfo`
WHEN OLD.`cache_id` IS NOT NULL AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`narinfo_complete`
		OR OLD.rowid <= `narinfo_cursor`
		OR OLD.rowid > `narinfo_initial_rowid_high_water`
	)
)
BEGIN
	UPDATE `cache_narinfo_count`
	SET `count` = `count` - 1
	WHERE `cache_id` = OLD.`cache_id`;
	DELETE FROM `cache_narinfo_count`
	WHERE `cache_id` = OLD.`cache_id` AND `count` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `cache_narinfo_count_update_cache`
AFTER UPDATE OF `cache_id` ON `narinfo`
WHEN OLD.`cache_id` IS NOT NEW.`cache_id` AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`narinfo_complete`
		OR NEW.rowid <= `narinfo_cursor`
		OR NEW.rowid > `narinfo_initial_rowid_high_water`
	)
)
BEGIN
	UPDATE `cache_narinfo_count`
	SET `count` = `count` - 1
	WHERE OLD.`cache_id` IS NOT NULL AND `cache_id` = OLD.`cache_id`;
	DELETE FROM `cache_narinfo_count`
	WHERE OLD.`cache_id` IS NOT NULL AND `cache_id` = OLD.`cache_id` AND `count` = 0;
	INSERT INTO `cache_narinfo_count` (`cache_id`, `count`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` IS NOT NULL
	ON CONFLICT (`cache_id`) DO UPDATE SET `count` = `count` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `managed_retirement_narinfo_delete` AFTER DELETE ON `narinfo`
WHEN EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
  AND NOT EXISTS (SELECT 1 FROM `narinfo` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;

ALTER TABLE `garbage_collection_scan` ADD `present_seed_hash` text;--> statement-breakpoint
ALTER TABLE `narinfo` ADD `build_inputs_json` text;--> statement-breakpoint
ALTER TABLE `narinfo` ADD `build_inputs_version` integer;--> statement-breakpoint
UPDATE `garbage_collection_scan`
SET `phase` = 'expire-grace',
	`cursor` = '',
	`mark_store_path_hash` = NULL,
	`reference_cursor` = -1
WHERE `phase` IN ('roots', 'grace', 'mark', 'collect');
--> statement-breakpoint
DROP TRIGGER `garbage_collection_barrier_retention_root_target_insert`;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_retention_root_target_insert`
AFTER INSERT ON `retention_root_target`
WHEN EXISTS (
	SELECT 1 FROM `garbage_collection_scan`
	WHERE `cache_id` = NEW.`cache_id`
	  AND `phase` IN ('roots', 'grace', 'mark', 'collect')
)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_barrier_retention_root_target_update`;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_retention_root_target_update`
AFTER UPDATE OF `cache_id`, `store_path_hash` ON `retention_root_target`
WHEN EXISTS (
	SELECT 1 FROM `garbage_collection_scan`
	WHERE `cache_id` = NEW.`cache_id`
	  AND `phase` IN ('roots', 'grace', 'mark', 'collect')
)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_barrier_retention_grace_insert`;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_retention_grace_insert`
AFTER INSERT ON `retention_grace`
WHEN EXISTS (
	SELECT 1 FROM `garbage_collection_scan`
	WHERE `cache_id` = NEW.`cache_id`
	  AND `phase` IN ('roots', 'grace', 'mark', 'collect')
)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_barrier_retention_grace_update`;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_retention_grace_update`
AFTER UPDATE OF `cache_id`, `store_path_hash` ON `retention_grace`
WHEN EXISTS (
	SELECT 1 FROM `garbage_collection_scan`
	WHERE `cache_id` = NEW.`cache_id`
	  AND `phase` IN ('roots', 'grace', 'mark', 'collect')
)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_barrier_narinfo_insert`;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_narinfo_insert`
AFTER INSERT ON `narinfo`
WHEN EXISTS (
	SELECT 1 FROM `garbage_collection_scan`
	WHERE `cache_id` = NEW.`cache_id`
	  AND `phase` IN ('mark', 'collect')
)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_barrier_narinfo_update`;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_narinfo_update`
AFTER UPDATE OF `cache_id`, `store_path_hash`, `references_json`, `build_inputs_json` ON `narinfo`
WHEN EXISTS (
	SELECT 1 FROM `garbage_collection_mark`
	WHERE `cache_id` = NEW.`cache_id` AND `store_path_hash` = NEW.`store_path_hash`
)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;

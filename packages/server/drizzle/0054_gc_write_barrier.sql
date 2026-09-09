CREATE TRIGGER `garbage_collection_barrier_retention_root_target_insert`
AFTER INSERT ON `retention_root_target`
WHEN EXISTS (SELECT 1 FROM `garbage_collection_scan` WHERE `cache_id` = NEW.`cache_id`)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_retention_root_target_update`
AFTER UPDATE OF `cache_id`, `store_path_hash` ON `retention_root_target`
WHEN EXISTS (SELECT 1 FROM `garbage_collection_scan` WHERE `cache_id` = NEW.`cache_id`)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_retention_grace_insert`
AFTER INSERT ON `retention_grace`
WHEN EXISTS (SELECT 1 FROM `garbage_collection_scan` WHERE `cache_id` = NEW.`cache_id`)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_retention_grace_update`
AFTER UPDATE OF `cache_id`, `store_path_hash` ON `retention_grace`
WHEN EXISTS (SELECT 1 FROM `garbage_collection_scan` WHERE `cache_id` = NEW.`cache_id`)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
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

CREATE TABLE `garbage_collection_input` (
	`cache_id` integer PRIMARY KEY NOT NULL,
	`inputs_changed` integer DEFAULT true NOT NULL,
	`scan_completed_at` text
);
--> statement-breakpoint
CREATE INDEX `garbage_collection_input_changed_idx` ON `garbage_collection_input` (`inputs_changed`,`scan_completed_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
SELECT `id`,
	EXISTS (SELECT 1 FROM `narinfo` WHERE `narinfo`.`cache_id` = `cache_identity`.`id`)
	OR EXISTS (SELECT 1 FROM `cache_close_event` WHERE `cache_close_event`.`cache_id` = `cache_identity`.`id`)
	OR EXISTS (
		SELECT 1 FROM `retention_root`
		WHERE `retention_root`.`cache_id` = `cache_identity`.`id`
			AND `retention_root`.`close_applied_epoch` < `cache_identity`.`retention_epoch`
	),
	`created_at`
FROM `cache_identity`;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_cache_identity_insert`
AFTER INSERT ON `cache_identity`
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (NEW.`id`, 0, NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_cache_identity_grace_managed`
AFTER UPDATE OF `grace_managed` ON `cache_identity`
WHEN OLD.`grace_managed` IS NOT NEW.`grace_managed` AND NEW.`grace_managed`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (NEW.`id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_cache_identity_undelete`
AFTER UPDATE OF `deleted_at` ON `cache_identity`
WHEN OLD.`deleted_at` IS NOT NULL AND NEW.`deleted_at` IS NULL
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (NEW.`id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_cache_close_event_insert`
AFTER INSERT ON `cache_close_event`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (NEW.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_narinfo_insert`
AFTER INSERT ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (NEW.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_narinfo_update`
AFTER UPDATE OF `cache_id`, `store_path_hash`, `references_json` ON `narinfo`
WHEN OLD.`cache_id` IS NOT NEW.`cache_id`
	OR OLD.`store_path_hash` IS NOT NEW.`store_path_hash`
	OR OLD.`references_json` IS NOT NEW.`references_json`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (OLD.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	SELECT NEW.`cache_id`, 1, NULL WHERE NEW.`cache_id` IS NOT OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_narinfo_delete`
AFTER DELETE ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (OLD.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_retention_root_target_insert`
AFTER INSERT ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (NEW.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_retention_root_target_update`
AFTER UPDATE OF `cache_id`, `store_path_hash` ON `retention_root_target`
WHEN OLD.`cache_id` IS NOT NEW.`cache_id`
	OR OLD.`store_path_hash` IS NOT NEW.`store_path_hash`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (OLD.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	SELECT NEW.`cache_id`, 1, NULL WHERE NEW.`cache_id` IS NOT OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_retention_root_target_delete`
AFTER DELETE ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (OLD.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_retention_grace_insert`
AFTER INSERT ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (NEW.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_retention_grace_update`
AFTER UPDATE OF `cache_id`, `store_path_hash` ON `retention_grace`
WHEN OLD.`cache_id` IS NOT NEW.`cache_id`
	OR OLD.`store_path_hash` IS NOT NEW.`store_path_hash`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (OLD.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	SELECT NEW.`cache_id`, 1, NULL WHERE NEW.`cache_id` IS NOT OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_retention_grace_delete`
AFTER DELETE ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (OLD.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_pending_upload_update`
AFTER UPDATE OF `verdict`, `cache_id`, `metadata_json` ON `pending_upload`
WHEN OLD.`verdict` IN ('pending', 'committing') AND (
	NEW.`verdict` IS NULL
	OR NEW.`verdict` NOT IN ('pending', 'committing')
	OR OLD.`cache_id` IS NOT NEW.`cache_id`
	OR json_extract(OLD.`metadata_json`, '$.storePathHash')
		IS NOT json_extract(NEW.`metadata_json`, '$.storePathHash')
)
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (OLD.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_pending_upload_delete`
AFTER DELETE ON `pending_upload`
WHEN OLD.`verdict` IN ('pending', 'committing')
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	VALUES (OLD.`cache_id`, 1, NULL)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;

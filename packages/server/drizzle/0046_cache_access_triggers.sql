CREATE INDEX `pending_upload_gc_path_idx`
ON `pending_upload` (`cache_id`, json_extract(`metadata_json`, '$.storePathHash'), `verdict`);--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_narinfo_insert`
AFTER INSERT ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_narinfo_update`
AFTER UPDATE ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` <> OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_narinfo_delete`
AFTER DELETE ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_insert`
AFTER INSERT ON `retention_root`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_update`
AFTER UPDATE ON `retention_root`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` <> OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_delete`
AFTER DELETE ON `retention_root`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_target_insert`
AFTER INSERT ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_target_update`
AFTER UPDATE ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` <> OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_target_delete`
AFTER DELETE ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_grace_insert`
AFTER INSERT ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_grace_update`
AFTER UPDATE ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` <> OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_grace_delete`
AFTER DELETE ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_cache_delete`
AFTER DELETE ON `cache_identity`
BEGIN
	DELETE FROM `garbage_collection_frontier` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_mark` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_scan` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_revision` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_tenant_run` WHERE `cache_id` = OLD.`id`;
END;

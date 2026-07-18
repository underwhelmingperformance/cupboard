CREATE TABLE `garbage_collection_frontier` (
	`cache` text NOT NULL,
	`store_path_hash` text NOT NULL,
	PRIMARY KEY(`cache`, `store_path_hash`)
);
--> statement-breakpoint
CREATE TABLE `garbage_collection_mark` (
	`cache` text NOT NULL,
	`store_path_hash` text NOT NULL,
	PRIMARY KEY(`cache`, `store_path_hash`)
);
--> statement-breakpoint
CREATE TABLE `garbage_collection_revision` (
	`cache` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `garbage_collection_scan` (
	`cache` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`phase` text NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`mark_store_path_hash` text,
	`reference_cursor` integer DEFAULT -1 NOT NULL,
	`allow_empty_sweep` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `garbage_collection_tenant_run` (
	`id` integer PRIMARY KEY NOT NULL,
	`cache` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_upload_gc_path_idx`
ON `pending_upload` (`cache`, json_extract(`metadata_json`, '$.storePathHash'), `verdict`);
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_narinfo_insert`
AFTER INSERT ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (NEW.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_narinfo_update`
AFTER UPDATE ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (OLD.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	SELECT NEW.`cache`, 1 WHERE NEW.`cache` <> OLD.`cache`
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_narinfo_delete`
AFTER DELETE ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (OLD.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_insert`
AFTER INSERT ON `retention_root`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (NEW.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_update`
AFTER UPDATE ON `retention_root`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (OLD.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	SELECT NEW.`cache`, 1 WHERE NEW.`cache` <> OLD.`cache`
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_delete`
AFTER DELETE ON `retention_root`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (OLD.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_target_insert`
AFTER INSERT ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (NEW.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_target_update`
AFTER UPDATE ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (OLD.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	SELECT NEW.`cache`, 1 WHERE NEW.`cache` <> OLD.`cache`
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_target_delete`
AFTER DELETE ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (OLD.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_grace_insert`
AFTER INSERT ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (NEW.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_grace_update`
AFTER UPDATE ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (OLD.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	SELECT NEW.`cache`, 1 WHERE NEW.`cache` <> OLD.`cache`
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_grace_delete`
AFTER DELETE ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache`, `revision`)
	VALUES (OLD.`cache`, 1)
	ON CONFLICT (`cache`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_cache_delete`
AFTER DELETE ON `cache`
BEGIN
	DELETE FROM `garbage_collection_frontier` WHERE `cache` = OLD.`name`;
	DELETE FROM `garbage_collection_mark` WHERE `cache` = OLD.`name`;
	DELETE FROM `garbage_collection_scan` WHERE `cache` = OLD.`name`;
	DELETE FROM `garbage_collection_revision` WHERE `cache` = OLD.`name`;
	DELETE FROM `garbage_collection_tenant_run` WHERE `cache` = OLD.`name`;
END;

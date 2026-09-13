DROP TRIGGER `garbage_collection_revision_narinfo_insert`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_narinfo_update`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_narinfo_delete`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_root_insert`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_root_update`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_root_delete`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_root_target_insert`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_root_target_update`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_root_target_delete`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_grace_insert`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_grace_update`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_revision_grace_delete`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_cache_delete`;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_cache_delete`
AFTER DELETE ON `cache_identity`
BEGIN
	DELETE FROM `garbage_collection_frontier` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_mark` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_scan` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_tenant_run` WHERE `cache_id` = OLD.`id`;
END;
--> statement-breakpoint
DROP TABLE `garbage_collection_revision`;
--> statement-breakpoint
DELETE FROM `garbage_collection_frontier`;
--> statement-breakpoint
DELETE FROM `garbage_collection_mark`;
--> statement-breakpoint
DELETE FROM `garbage_collection_scan`;
--> statement-breakpoint
ALTER TABLE `garbage_collection_scan` DROP COLUMN `revision`;

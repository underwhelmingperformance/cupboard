CREATE TABLE `cache_identity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`access` text,
	`priority` integer NOT NULL,
	`grace_managed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "cache_identity_shape_check" CHECK(("cache_identity"."kind" = 'default' AND "cache_identity"."name" IS NULL) OR ("cache_identity"."kind" = 'named' AND "cache_identity"."name" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cache_identity_default_idx` ON `cache_identity` (`kind`) WHERE "cache_identity"."kind" = 'default' AND "cache_identity"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `cache_identity_name_idx` ON `cache_identity` (`name`) WHERE "cache_identity"."kind" = 'named' AND "cache_identity"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `cache_identity_history_scope_id_idx` ON `cache_identity` (`kind`,`name`,`id`) WHERE "cache_identity"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `cache_identity_incomplete_access_idx` ON `cache_identity` (`access`) WHERE "cache_identity"."access" IS NULL;--> statement-breakpoint
CREATE TABLE `reuse_view_selector_native` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`view` text NOT NULL,
	`kind` text NOT NULL,
	`cache_name` text,
	`prefix` text,
	CONSTRAINT "reuse_view_selector_native_shape_check" CHECK(("reuse_view_selector_native"."kind" IN ('default', 'all-named', 'all') AND "reuse_view_selector_native"."cache_name" IS NULL AND "reuse_view_selector_native"."prefix" IS NULL) OR ("reuse_view_selector_native"."kind" = 'named' AND "reuse_view_selector_native"."cache_name" IS NOT NULL AND "reuse_view_selector_native"."prefix" IS NULL) OR ("reuse_view_selector_native"."kind" = 'prefix' AND "reuse_view_selector_native"."cache_name" IS NULL AND "reuse_view_selector_native"."prefix" IS NOT NULL AND length("reuse_view_selector_native"."prefix") > 0))
);
--> statement-breakpoint
ALTER TABLE `garbage_collection_frontier` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `garbage_collection_mark` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `garbage_collection_revision` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `garbage_collection_scan` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `garbage_collection_tenant_run` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `generation_seq` ADD `cache_kind` text;--> statement-breakpoint
ALTER TABLE `generation_seq` ADD `cache_name` text;--> statement-breakpoint
ALTER TABLE `narinfo_deletion` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `narinfo` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `pending_attestation` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `pending_upload` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `retention_grace` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `retention_policy` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `retention_policy` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `retention_policy` ADD `root_name_prefix` text;--> statement-breakpoint
ALTER TABLE `retention_root_target` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `retention_root` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `reuse_view` ADD `access` text;--> statement-breakpoint
CREATE INDEX `reuse_view_incomplete_access_idx` ON `reuse_view` (`access`) WHERE "reuse_view"."access" IS NULL;--> statement-breakpoint
ALTER TABLE `verification_cursor` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `cache` ADD `migration_identity_id` integer;--> statement-breakpoint
CREATE INDEX `cache_missing_cache_identity_idx` ON `cache` (`migration_identity_id`) WHERE "cache"."migration_identity_id" IS NULL;--> statement-breakpoint
CREATE INDEX `narinfo_missing_cache_identity_idx` ON `narinfo` (`cache_id`) WHERE "narinfo"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `pending_upload_missing_cache_identity_idx` ON `pending_upload` (`cache_id`) WHERE "pending_upload"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `pending_attestation_missing_cache_identity_idx` ON `pending_attestation` (`cache_id`) WHERE "pending_attestation"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `narinfo_deletion_missing_cache_identity_idx` ON `narinfo_deletion` (`cache_id`) WHERE "narinfo_deletion"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `retention_root_missing_cache_identity_idx` ON `retention_root` (`cache_id`) WHERE "retention_root"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `retention_root_target_missing_cache_identity_idx` ON `retention_root_target` (`cache_id`) WHERE "retention_root_target"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `retention_grace_missing_cache_identity_idx` ON `retention_grace` (`cache_id`) WHERE "retention_grace"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `garbage_collection_revision_missing_cache_identity_idx` ON `garbage_collection_revision` (`cache_id`) WHERE "garbage_collection_revision"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `garbage_collection_scan_missing_cache_identity_idx` ON `garbage_collection_scan` (`cache_id`) WHERE "garbage_collection_scan"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `garbage_collection_frontier_missing_cache_identity_idx` ON `garbage_collection_frontier` (`cache_id`) WHERE "garbage_collection_frontier"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `garbage_collection_mark_missing_cache_identity_idx` ON `garbage_collection_mark` (`cache_id`) WHERE "garbage_collection_mark"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `garbage_collection_tenant_run_missing_cache_identity_idx` ON `garbage_collection_tenant_run` (`cache_id`) WHERE "garbage_collection_tenant_run"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `verification_cursor_missing_cache_identity_idx` ON `verification_cursor` (`cache_id`) WHERE "verification_cursor"."cache_id" IS NULL;--> statement-breakpoint
CREATE INDEX `retention_policy_missing_cache_identity_idx` ON `retention_policy` (`cache_id`) WHERE "retention_policy"."cache_id" IS NULL AND "retention_policy"."scope" = 'cache';--> statement-breakpoint
CREATE TABLE `cache_identity_backfill_revision` (
	`table_name` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
INSERT INTO `cache_identity_backfill_revision` (`table_name`) VALUES
	('cache_identity'),
	('narinfo'),
	('pending_upload'),
	('pending_attestation'),
	('narinfo_deletion'),
	('retention_root'),
	('retention_root_target'),
	('retention_grace'),
	('garbage_collection_revision'),
	('garbage_collection_scan'),
	('garbage_collection_frontier'),
	('garbage_collection_mark'),
	('garbage_collection_tenant_run'),
	('verification_cursor'),
	('retention_policy');--> statement-breakpoint
CREATE TRIGGER `narinfo_backfill_insert`
AFTER INSERT ON `narinfo`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'narinfo';
END;--> statement-breakpoint
CREATE TRIGGER `narinfo_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `narinfo`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'narinfo';
END;--> statement-breakpoint
CREATE TRIGGER `pending_upload_backfill_insert`
AFTER INSERT ON `pending_upload`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'pending_upload';
END;--> statement-breakpoint
CREATE TRIGGER `pending_upload_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `pending_upload`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'pending_upload';
END;--> statement-breakpoint
CREATE TRIGGER `pending_attestation_backfill_insert`
AFTER INSERT ON `pending_attestation`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'pending_attestation';
END;--> statement-breakpoint
CREATE TRIGGER `pending_attestation_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `pending_attestation`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'pending_attestation';
END;--> statement-breakpoint
CREATE TRIGGER `narinfo_deletion_backfill_insert`
AFTER INSERT ON `narinfo_deletion`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'narinfo_deletion';
END;--> statement-breakpoint
CREATE TRIGGER `narinfo_deletion_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `narinfo_deletion`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'narinfo_deletion';
END;--> statement-breakpoint
CREATE TRIGGER `retention_root_backfill_insert`
AFTER INSERT ON `retention_root`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'retention_root';
END;--> statement-breakpoint
CREATE TRIGGER `retention_root_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `retention_root`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'retention_root';
END;--> statement-breakpoint
CREATE TRIGGER `retention_root_target_backfill_insert`
AFTER INSERT ON `retention_root_target`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'retention_root_target';
END;--> statement-breakpoint
CREATE TRIGGER `retention_root_target_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `retention_root_target`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'retention_root_target';
END;--> statement-breakpoint
CREATE TRIGGER `retention_grace_backfill_insert`
AFTER INSERT ON `retention_grace`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'retention_grace';
END;--> statement-breakpoint
CREATE TRIGGER `retention_grace_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `retention_grace`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'retention_grace';
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_backfill_insert`
AFTER INSERT ON `garbage_collection_revision`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'garbage_collection_revision';
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `garbage_collection_revision`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'garbage_collection_revision';
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_scan_backfill_insert`
AFTER INSERT ON `garbage_collection_scan`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'garbage_collection_scan';
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_scan_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `garbage_collection_scan`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'garbage_collection_scan';
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_frontier_backfill_insert`
AFTER INSERT ON `garbage_collection_frontier`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'garbage_collection_frontier';
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_frontier_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `garbage_collection_frontier`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'garbage_collection_frontier';
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_mark_backfill_insert`
AFTER INSERT ON `garbage_collection_mark`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'garbage_collection_mark';
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_mark_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `garbage_collection_mark`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'garbage_collection_mark';
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_tenant_run_backfill_insert`
AFTER INSERT ON `garbage_collection_tenant_run`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'garbage_collection_tenant_run';
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_tenant_run_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `garbage_collection_tenant_run`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'garbage_collection_tenant_run';
END;--> statement-breakpoint
CREATE TRIGGER `verification_cursor_backfill_insert`
AFTER INSERT ON `verification_cursor`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'verification_cursor';
END;--> statement-breakpoint
CREATE TRIGGER `verification_cursor_backfill_update`
AFTER UPDATE OF `cache_id`, `cache` ON `verification_cursor`
WHEN NEW.`cache_id` IS NULL
	AND (
		(NEW.`cache` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`cache` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9) ELSE NEW.`cache` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`cache` IS NOT NEW.`cache`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'verification_cursor';
END;--> statement-breakpoint
CREATE TRIGGER `retention_policy_backfill_insert`
AFTER INSERT ON `retention_policy`
WHEN NEW.`cache_id` IS NULL
	AND NEW.`scope` = 'cache'
	AND (
		(NEW.`pattern` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`pattern` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`pattern` LIKE 'private/%' THEN substr(NEW.`pattern`, 9) ELSE NEW.`pattern` END
		))
	)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'retention_policy';
END;--> statement-breakpoint
CREATE TRIGGER `retention_policy_backfill_update`
AFTER UPDATE OF `cache_id`, `pattern`, `scope` ON `retention_policy`
WHEN NEW.`cache_id` IS NULL
	AND NEW.`scope` = 'cache'
	AND (
		(NEW.`pattern` = '' AND EXISTS (SELECT 1 FROM `cache_identity` WHERE `kind` = 'default' AND `deleted_at` IS NULL))
		OR (NEW.`pattern` <> '' AND EXISTS (
			SELECT 1 FROM `cache_identity`
			WHERE `kind` = 'named' AND `deleted_at` IS NULL
				AND `name` = CASE WHEN NEW.`pattern` LIKE 'private/%' THEN substr(NEW.`pattern`, 9) ELSE NEW.`pattern` END
		))
	)
	AND (OLD.`cache_id` IS NOT NULL OR OLD.`pattern` IS NOT NEW.`pattern` OR OLD.`scope` IS NOT NEW.`scope`)
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'retention_policy';
END;--> statement-breakpoint
CREATE TRIGGER `cache_identity_backfill_insert`
AFTER INSERT ON `cache_identity`
WHEN NEW.`deleted_at` IS NULL
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'cache_identity';
END;--> statement-breakpoint
CREATE TRIGGER `cache_identity_backfill_revive`
AFTER UPDATE OF `deleted_at` ON `cache_identity`
WHEN OLD.`deleted_at` IS NOT NULL AND NEW.`deleted_at` IS NULL
BEGIN
	UPDATE `cache_identity_backfill_revision` SET `revision` = `revision` + 1 WHERE `table_name` = 'cache_identity';
END;

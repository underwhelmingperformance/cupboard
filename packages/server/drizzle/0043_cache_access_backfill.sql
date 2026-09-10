CREATE TABLE `_cache_access_migration_assertion` (
	`valid` integer NOT NULL CHECK (`valid` = 1)
);--> statement-breakpoint
INSERT INTO `_cache_access_migration_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `cache`
	WHERE `name` <> ''
	GROUP BY CASE WHEN `name` LIKE 'private/%' THEN substr(`name`, 9) ELSE `name` END
	HAVING min(`name` LIKE 'private/%') <> max(`name` LIKE 'private/%')
);--> statement-breakpoint
INSERT INTO `_cache_access_migration_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `reuse_view`
	GROUP BY CASE WHEN `name` LIKE 'private/%' THEN substr(`name`, 9) ELSE `name` END
	HAVING min(`name` LIKE 'private/%') <> max(`name` LIKE 'private/%')
);--> statement-breakpoint
DROP TABLE `_cache_access_migration_assertion`;--> statement-breakpoint
CREATE TABLE `_legacy_cache_catalogue` (
	`kind` text NOT NULL,
	`name` text,
	`access` text,
	`priority` integer NOT NULL,
	`grace_managed` integer NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	PRIMARY KEY (`kind`, `name`)
);--> statement-breakpoint
CREATE UNIQUE INDEX `_legacy_cache_catalogue_default_idx`
ON `_legacy_cache_catalogue` (`kind`)
WHERE `kind` = 'default';--> statement-breakpoint
INSERT INTO `_legacy_cache_catalogue` (
	`kind`, `name`, `access`, `priority`, `grace_managed`, `created_at`, `deleted_at`
)
SELECT
	CASE WHEN `name` = '' THEN 'default' ELSE 'named' END,
	CASE
		WHEN `name` = '' THEN NULL
		WHEN `name` LIKE 'private/%' THEN substr(`name`, 9)
		ELSE `name`
	END,
	CASE WHEN `name` LIKE 'private/%' THEN 'private' ELSE NULL END,
	`priority`, `grace_managed`, `created_at`, NULL
FROM `cache`;--> statement-breakpoint
CREATE TABLE `_legacy_cache_names` (
	`legacy_cache` text PRIMARY KEY NOT NULL
);--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `narinfo`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `narinfo_deletion`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `pending_upload`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `pending_attestation`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `retention_root`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `retention_root_target`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `retention_grace`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `garbage_collection_revision`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `garbage_collection_scan`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `garbage_collection_frontier`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `garbage_collection_mark`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `garbage_collection_tenant_run`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names` SELECT `cache` FROM `verification_cursor`;--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_names`
SELECT `pattern` FROM `retention_policy` WHERE `scope` = 'cache';--> statement-breakpoint
INSERT OR IGNORE INTO `_legacy_cache_catalogue` (
	`kind`, `name`, `access`, `priority`, `grace_managed`, `created_at`, `deleted_at`
)
SELECT
	CASE WHEN `legacy_cache` = '' THEN 'default' ELSE 'named' END,
	CASE
		WHEN `legacy_cache` = '' THEN NULL
		WHEN `legacy_cache` LIKE 'private/%' THEN substr(`legacy_cache`, 9)
		ELSE `legacy_cache`
	END,
	CASE WHEN `legacy_cache` LIKE 'private/%' THEN 'private' ELSE NULL END,
	40,
	0,
	'1970-01-01T00:00:00.000Z',
	'1970-01-01T00:00:00.000Z'
FROM `_legacy_cache_names`;--> statement-breakpoint
DROP TABLE `_legacy_cache_names`;--> statement-breakpoint
INSERT INTO `cache_identity` (
	`kind`, `name`, `access`, `priority`, `grace_managed`, `created_at`, `deleted_at`
)
SELECT
	`kind`,
	`name`,
	`access`,
	`priority`, `grace_managed`, `created_at`, `deleted_at`
FROM `_legacy_cache_catalogue`;--> statement-breakpoint
DROP TABLE `_legacy_cache_catalogue`;--> statement-breakpoint
UPDATE `narinfo`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`narinfo`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`narinfo`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `narinfo`.`cache` LIKE 'private/%' THEN substr(`narinfo`.`cache`, 9) ELSE `narinfo`.`cache` END)
);--> statement-breakpoint
UPDATE `generation_seq`
SET
	`cache_kind` = CASE WHEN `cache` = '' THEN 'default' ELSE 'named' END,
	`cache_name` = CASE
		WHEN `cache` = '' THEN NULL
		WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9)
		ELSE `cache`
	END;--> statement-breakpoint
UPDATE `pending_upload`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`pending_upload`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`pending_upload`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `pending_upload`.`cache` LIKE 'private/%' THEN substr(`pending_upload`.`cache`, 9) ELSE `pending_upload`.`cache` END)
);--> statement-breakpoint
UPDATE `pending_attestation`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`pending_attestation`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`pending_attestation`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `pending_attestation`.`cache` LIKE 'private/%' THEN substr(`pending_attestation`.`cache`, 9) ELSE `pending_attestation`.`cache` END)
);--> statement-breakpoint
UPDATE `narinfo_deletion`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`narinfo_deletion`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`narinfo_deletion`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `narinfo_deletion`.`cache` LIKE 'private/%' THEN substr(`narinfo_deletion`.`cache`, 9) ELSE `narinfo_deletion`.`cache` END)
);--> statement-breakpoint
UPDATE `retention_root`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`retention_root`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`retention_root`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `retention_root`.`cache` LIKE 'private/%' THEN substr(`retention_root`.`cache`, 9) ELSE `retention_root`.`cache` END)
);--> statement-breakpoint
UPDATE `retention_root_target`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`retention_root_target`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`retention_root_target`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `retention_root_target`.`cache` LIKE 'private/%' THEN substr(`retention_root_target`.`cache`, 9) ELSE `retention_root_target`.`cache` END)
);--> statement-breakpoint
UPDATE `retention_grace`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`retention_grace`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`retention_grace`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `retention_grace`.`cache` LIKE 'private/%' THEN substr(`retention_grace`.`cache`, 9) ELSE `retention_grace`.`cache` END)
);--> statement-breakpoint
UPDATE `garbage_collection_revision`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`garbage_collection_revision`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`garbage_collection_revision`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `garbage_collection_revision`.`cache` LIKE 'private/%' THEN substr(`garbage_collection_revision`.`cache`, 9) ELSE `garbage_collection_revision`.`cache` END)
);--> statement-breakpoint
UPDATE `garbage_collection_scan`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`garbage_collection_scan`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`garbage_collection_scan`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `garbage_collection_scan`.`cache` LIKE 'private/%' THEN substr(`garbage_collection_scan`.`cache`, 9) ELSE `garbage_collection_scan`.`cache` END)
);--> statement-breakpoint
UPDATE `garbage_collection_frontier`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`garbage_collection_frontier`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`garbage_collection_frontier`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `garbage_collection_frontier`.`cache` LIKE 'private/%' THEN substr(`garbage_collection_frontier`.`cache`, 9) ELSE `garbage_collection_frontier`.`cache` END)
);--> statement-breakpoint
UPDATE `garbage_collection_mark`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`garbage_collection_mark`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`garbage_collection_mark`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `garbage_collection_mark`.`cache` LIKE 'private/%' THEN substr(`garbage_collection_mark`.`cache`, 9) ELSE `garbage_collection_mark`.`cache` END)
);--> statement-breakpoint
UPDATE `garbage_collection_tenant_run`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`garbage_collection_tenant_run`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`garbage_collection_tenant_run`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `garbage_collection_tenant_run`.`cache` LIKE 'private/%' THEN substr(`garbage_collection_tenant_run`.`cache`, 9) ELSE `garbage_collection_tenant_run`.`cache` END)
);--> statement-breakpoint
UPDATE `verification_cursor`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE (`verification_cursor`.`cache` = '' AND `cache_identity`.`kind` = 'default')
		OR (`verification_cursor`.`cache` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `verification_cursor`.`cache` LIKE 'private/%' THEN substr(`verification_cursor`.`cache`, 9) ELSE `verification_cursor`.`cache` END)
);--> statement-breakpoint
UPDATE `retention_policy`
SET
	`kind` = CASE WHEN `scope` = 'cache' THEN 'cache' ELSE 'root-name-prefix' END,
	`cache_id` = CASE WHEN `scope` = 'cache' THEN (
		SELECT `id` FROM `cache_identity`
		WHERE (`retention_policy`.`pattern` = '' AND `cache_identity`.`kind` = 'default')
			OR (`retention_policy`.`pattern` <> '' AND `cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `retention_policy`.`pattern` LIKE 'private/%' THEN substr(`retention_policy`.`pattern`, 9) ELSE `retention_policy`.`pattern` END)
	) ELSE NULL END,
	`root_name_prefix` = CASE WHEN `scope` = 'root-name-prefix' THEN `pattern` ELSE NULL END;--> statement-breakpoint
UPDATE `reuse_view`
SET `access` = CASE WHEN `name` LIKE 'private/%' THEN 'private' ELSE NULL END;--> statement-breakpoint
INSERT INTO `reuse_view_selector_native` (`view`, `kind`, `cache_name`, `prefix`)
SELECT
	`view`,
	CASE
		WHEN `kind` = 'exact' AND `pattern` = '_default' THEN 'default'
		WHEN `kind` = 'exact' THEN 'named'
		WHEN `pattern` = '' AND `view` LIKE 'private/%' THEN 'all-named'
		WHEN `pattern` = '' THEN 'all'
		ELSE 'prefix'
	END,
	CASE WHEN `kind` = 'exact' AND `pattern` <> '_default' THEN `pattern` ELSE NULL END,
	CASE WHEN `kind` = 'prefix' AND `pattern` <> '' THEN `pattern` ELSE NULL END
FROM `reuse_view_selector`;--> statement-breakpoint
CREATE INDEX `narinfo_cache_id_store_path_hash_idx`
ON `narinfo` (`cache_id`, `store_path_hash`);--> statement-breakpoint
CREATE INDEX `reuse_view_selector_native_view_idx`
ON `reuse_view_selector_native` (`view`);

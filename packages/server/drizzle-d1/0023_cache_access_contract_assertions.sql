CREATE TABLE `_cache_access_contract_assertion` (
	`valid` integer NOT NULL CHECK (`valid` = 1)
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `tenant`
	WHERE `status` IN ('active', 'suspended')
		AND (`cache_catalogue_version` IS NULL OR `cache_catalogue_version` <> 1)
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `tenant`
	WHERE `status` IN ('active', 'suspended')
		AND (
			SELECT count(*)
			FROM `cache_lifecycle`
			WHERE `cache_lifecycle`.`tenant` = `tenant`.`id`
				AND `cache_kind` = 'default'
				AND `cache_name` IS NULL
				AND `access` IN ('public', 'private')
				AND `deleted_at` IS NULL
		) <> 1
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `blob_ref`
	WHERE (`cache_kind` = 'default' AND `cache_name` IS NOT NULL)
		OR (`cache_kind` = 'named' AND (
			`cache_name` IS NULL
			OR length(`cache_name`) NOT BETWEEN 1 AND 63
			OR `cache_name` NOT GLOB '[a-z0-9]*'
			OR `cache_name` GLOB '*[^a-z0-9._-]*'
		))
		OR `cache_kind` NOT IN ('default', 'named')
		OR `cache_kind` IS NULL
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `attestation_ref`
	WHERE (`cache_kind` = 'default' AND `cache_name` IS NOT NULL)
		OR (`cache_kind` = 'named' AND (
			`cache_name` IS NULL
			OR length(`cache_name`) NOT BETWEEN 1 AND 63
			OR `cache_name` NOT GLOB '[a-z0-9]*'
			OR `cache_name` GLOB '*[^a-z0-9._-]*'
		))
		OR `cache_kind` NOT IN ('default', 'named')
		OR `cache_kind` IS NULL
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `cache_lifecycle`
	WHERE (`cache_kind` = 'default' AND `cache_name` IS NOT NULL)
		OR (`cache_kind` = 'named' AND (
			`cache_name` IS NULL
			OR length(`cache_name`) NOT BETWEEN 1 AND 63
			OR `cache_name` NOT GLOB '[a-z0-9]*'
			OR `cache_name` GLOB '*[^a-z0-9._-]*'
		))
		OR `cache_kind` NOT IN ('default', 'named')
		OR `cache_kind` IS NULL
		OR `access` NOT IN ('public', 'private')
		OR `access` IS NULL
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `tenant_cache_read_credential`
	WHERE (`cache_kind` = 'default' AND `cache_name` IS NOT NULL)
		OR (`cache_kind` = 'named' AND (
			`cache_name` IS NULL
			OR length(`cache_name`) NOT BETWEEN 1 AND 63
			OR `cache_name` NOT GLOB '[a-z0-9]*'
			OR `cache_name` GLOB '*[^a-z0-9._-]*'
		))
		OR `cache_kind` NOT IN ('default', 'named')
		OR `cache_kind` IS NULL
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `blob_ref`
	GROUP BY `tenant`, `cache_kind`, `cache_name`, `store_path_hash`, `generation`
	HAVING count(*) > 1
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `attestation_ref`
	GROUP BY `tenant`, `cache_kind`, `cache_name`, `store_path_hash`, `generation`, `predicate_type`, `digest`
	HAVING count(*) > 1
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `cache_lifecycle`
	GROUP BY `tenant`, `cache_kind`, `cache_name`
	HAVING count(*) > 1
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `tenant_cache_read_credential`
	GROUP BY `tenant`, `cache_kind`, `cache_name`
	HAVING count(*) > 1
);--> statement-breakpoint
DROP TABLE `_cache_access_contract_assertion`;
--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_blob_ref_insert`;
--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_attestation_ref_insert`;
--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_lifecycle_insert`;
--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_credential_insert`;
--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_tenant_read_mode_update`;
--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_tenant_insert`;

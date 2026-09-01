-- Custom SQL migration file, put your code below! --
CREATE TRIGGER `cache_access_mirror_tenant_insert`
AFTER INSERT ON `tenant`
BEGIN
	INSERT INTO `cache_lifecycle` (
		`tenant`, `cache`, `cache_kind`, `cache_name`, `access`,
		`generation`, `deleted_at`, `updated_at`
	) VALUES (
		NEW.`id`, '', 'default', NULL, NEW.`read_mode`, 1, NULL, NEW.`created_at`
	)
	ON CONFLICT (`tenant`, `cache`) DO NOTHING;
END;--> statement-breakpoint
CREATE TABLE `_cache_access_migration_assertion` (
	`valid` integer NOT NULL CHECK (`valid` = 1)
);--> statement-breakpoint
INSERT INTO `_cache_access_migration_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM (
		SELECT `tenant`, CASE WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9) ELSE `cache` END AS `name`, `cache` LIKE 'private/%' AS `private`
		FROM `blob_ref`
		WHERE `cache` <> ''
		UNION ALL
		SELECT `tenant`, CASE WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9) ELSE `cache` END, `cache` LIKE 'private/%'
		FROM `attestation_ref`
		WHERE `cache` <> ''
		UNION ALL
		SELECT `tenant`, CASE WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9) ELSE `cache` END, `cache` LIKE 'private/%'
		FROM `cache_lifecycle`
		WHERE `cache` <> ''
		UNION ALL
		SELECT `tenant`, substr(`cache`, 9), 1
		FROM `tenant_cache_read_credential`
	) AS `cache_names`
	GROUP BY `tenant`, `name`
	HAVING min(`private`) <> max(`private`)
);--> statement-breakpoint
INSERT INTO `_cache_access_migration_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM (
		SELECT CASE WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9) ELSE `cache` END AS `name`
		FROM `blob_ref`
		WHERE `cache` <> ''
		UNION ALL
		SELECT CASE WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9) ELSE `cache` END
		FROM `attestation_ref`
		WHERE `cache` <> ''
		UNION ALL
		SELECT CASE WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9) ELSE `cache` END
		FROM `cache_lifecycle`
		WHERE `cache` <> ''
	) AS `cache_names`
	WHERE length(`name`) NOT BETWEEN 1 AND 63
		OR `name` NOT GLOB '[a-z0-9]*'
		OR `name` GLOB '*[^a-z0-9._-]*'
);--> statement-breakpoint
INSERT INTO `_cache_access_migration_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `tenant_cache_read_credential`
	WHERE `cache` NOT LIKE 'private/%'
		OR length(substr(`cache`, 9)) NOT BETWEEN 1 AND 63
		OR substr(`cache`, 9) NOT GLOB '[a-z0-9]*'
		OR substr(`cache`, 9) GLOB '*[^a-z0-9._-]*'
);--> statement-breakpoint
INSERT INTO `_cache_access_migration_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `tenant`
	WHERE `status` = 'offboarded'
		AND `id` IN (
			SELECT `tenant` FROM `blob_ref`
			UNION
			SELECT `tenant` FROM `attestation_ref`
			UNION
			SELECT `tenant` FROM `cache_lifecycle`
			UNION
			SELECT `tenant` FROM `tenant_cache_read_credential`
		)
);--> statement-breakpoint
DROP TABLE `_cache_access_migration_assertion`;--> statement-breakpoint
UPDATE `blob_ref`
SET
	`cache_kind` = CASE WHEN `cache` = '' THEN 'default' ELSE 'named' END,
	`cache_name` = CASE
		WHEN `cache` = '' THEN NULL
		WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9)
		ELSE `cache`
	END;--> statement-breakpoint
UPDATE `attestation_ref`
SET
	`cache_kind` = CASE WHEN `cache` = '' THEN 'default' ELSE 'named' END,
	`cache_name` = CASE
		WHEN `cache` = '' THEN NULL
		WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9)
		ELSE `cache`
	END;--> statement-breakpoint
UPDATE `cache_lifecycle`
SET
	`cache_kind` = CASE WHEN `cache` = '' THEN 'default' ELSE 'named' END,
	`cache_name` = CASE
		WHEN `cache` = '' THEN NULL
		WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9)
		ELSE `cache`
	END,
	`access` = CASE
		WHEN `cache` LIKE 'private/%' THEN 'private'
		ELSE (SELECT `read_mode` FROM `tenant` WHERE `tenant`.`id` = `cache_lifecycle`.`tenant`)
	END;--> statement-breakpoint
INSERT INTO `cache_lifecycle` (
	`tenant`, `cache`, `cache_kind`, `cache_name`, `access`, `generation`, `deleted_at`, `updated_at`
)
SELECT
	`id`, '', 'default', NULL, `read_mode`, 1, NULL, `created_at`
FROM `tenant`
WHERE `status` IN ('active', 'suspended', 'offboarding')
ON CONFLICT (`tenant`, `cache`) DO UPDATE SET
	`cache_kind` = excluded.`cache_kind`,
	`cache_name` = excluded.`cache_name`,
	`access` = excluded.`access`;--> statement-breakpoint
WITH `referenced_cache` (`tenant`, `cache`, `name`, `private`, `generation`) AS (
	SELECT
		`tenant`, `cache`,
		CASE WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9) ELSE `cache` END,
		`cache` LIKE 'private/%', coalesce(`cache_generation`, 1)
	FROM `blob_ref`
	WHERE `cache` <> ''
	UNION ALL
	SELECT
		`tenant`, `cache`,
		CASE WHEN `cache` LIKE 'private/%' THEN substr(`cache`, 9) ELSE `cache` END,
		`cache` LIKE 'private/%', 1
	FROM `attestation_ref`
	WHERE `cache` <> ''
	UNION ALL
	SELECT `tenant`, `cache`, substr(`cache`, 9), 1, 1
	FROM `tenant_cache_read_credential`
),
`referenced_cache_identity` AS (
	SELECT
		`tenant`, `name`, max(`private`) AS `private`,
		max(`generation`) AS `generation`
	FROM `referenced_cache`
	GROUP BY `tenant`, `name`
)
INSERT INTO `cache_lifecycle` (
	`tenant`, `cache`, `cache_kind`, `cache_name`, `access`, `generation`, `deleted_at`, `updated_at`
)
SELECT
	`tenant`.`id`,
	CASE
		WHEN `referenced_cache_identity`.`private` = 1 THEN 'private/' || `referenced_cache_identity`.`name`
		ELSE `referenced_cache_identity`.`name`
	END,
	'named', `referenced_cache_identity`.`name`,
	CASE
		WHEN `referenced_cache_identity`.`private` = 1 THEN 'private'
		ELSE `tenant`.`read_mode`
	END,
	`referenced_cache_identity`.`generation`, NULL, `tenant`.`created_at`
FROM `referenced_cache_identity`
INNER JOIN `tenant` ON `tenant`.`id` = `referenced_cache_identity`.`tenant`
WHERE `tenant`.`status` IN ('active', 'suspended', 'offboarding')
ON CONFLICT (`tenant`, `cache`) DO NOTHING;--> statement-breakpoint
UPDATE `tenant_cache_read_credential`
SET
	`cache_kind` = 'named',
	`cache_name` = substr(`cache`, 9);--> statement-breakpoint
CREATE INDEX `blob_ref_native_identity_idx`
ON `blob_ref` (`tenant`, `cache_kind`, `cache_name`, `store_path_hash`, `generation`);--> statement-breakpoint
CREATE INDEX `blob_ref_tenant_nar_hash_native_idx`
ON `blob_ref` (`tenant`, `nar_hash`, `cache_kind`, `cache_name`, `cache_generation`);--> statement-breakpoint
CREATE INDEX `attestation_ref_native_identity_idx`
ON `attestation_ref` (`tenant`, `cache_kind`, `cache_name`, `store_path_hash`, `digest`);--> statement-breakpoint
CREATE INDEX `cache_lifecycle_native_identity_idx`
ON `cache_lifecycle` (`tenant`, `cache_kind`, `cache_name`);--> statement-breakpoint
CREATE INDEX `tenant_cache_read_credential_native_identity_idx`
ON `tenant_cache_read_credential` (`tenant`, `cache_kind`, `cache_name`);

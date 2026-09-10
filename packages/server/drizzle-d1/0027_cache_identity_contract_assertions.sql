-- Custom SQL migration file, put your code below! --
-- Each statement below inserts 0 into this table when its assertion fails, and
-- the CHECK rejects the insert, so the migration stops on the first failure.
-- The error names only the constraint, so the comment on each statement says
-- which assertion failed.
CREATE TABLE `_cache_identity_contract_assertion` (
	`valid` integer NOT NULL CHECK (`valid` = 1)
);--> statement-breakpoint
-- Every tenant whose Durable Object can still be woken has to be able to
-- convert its cache catalogue, and the conversion reads the access recorded for
-- the tenant's default cache. A tenant without that row could not convert, and
-- its object could not apply the contraction.
INSERT INTO `_cache_identity_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `tenant`
	WHERE `status` <> 'offboarded'
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
-- An offboarded tenant must retain no cache rows.
INSERT INTO `_cache_identity_contract_assertion` (`valid`)
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
-- Every `blob_ref` row must carry identity columns this release can parse.
INSERT INTO `_cache_identity_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `blob_ref`
	WHERE `cache_kind` IS NULL
		OR `cache_kind` NOT IN ('default', 'named')
		OR (`cache_kind` = 'default' AND `cache_name` IS NOT NULL)
		OR (`cache_kind` = 'named' AND (
			`cache_name` IS NULL
			OR length(`cache_name`) NOT BETWEEN 1 AND 63
			OR `cache_name` NOT GLOB '[a-z0-9]*'
			OR `cache_name` GLOB '*[^a-z0-9._-]*'
		))
);--> statement-breakpoint
-- Every `attestation_ref` row must carry identity columns this release can parse.
INSERT INTO `_cache_identity_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `attestation_ref`
	WHERE `cache_kind` IS NULL
		OR `cache_kind` NOT IN ('default', 'named')
		OR (`cache_kind` = 'default' AND `cache_name` IS NOT NULL)
		OR (`cache_kind` = 'named' AND (
			`cache_name` IS NULL
			OR length(`cache_name`) NOT BETWEEN 1 AND 63
			OR `cache_name` NOT GLOB '[a-z0-9]*'
			OR `cache_name` GLOB '*[^a-z0-9._-]*'
		))
);--> statement-breakpoint
-- Every `cache_lifecycle` row must carry identity columns and an access.
INSERT INTO `_cache_identity_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `cache_lifecycle`
	WHERE `cache_kind` IS NULL
		OR `cache_kind` NOT IN ('default', 'named')
		OR `access` IS NULL
		OR `access` NOT IN ('public', 'private')
		OR (`cache_kind` = 'default' AND `cache_name` IS NOT NULL)
		OR (`cache_kind` = 'named' AND (
			`cache_name` IS NULL
			OR length(`cache_name`) NOT BETWEEN 1 AND 63
			OR `cache_name` NOT GLOB '[a-z0-9]*'
			OR `cache_name` GLOB '*[^a-z0-9._-]*'
		))
);--> statement-breakpoint
-- Every read credential must carry identity columns this release can parse.
INSERT INTO `_cache_identity_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `tenant_cache_read_credential`
	WHERE `cache_kind` IS NULL
		OR `cache_kind` NOT IN ('default', 'named')
		OR (`cache_kind` = 'default' AND `cache_name` IS NOT NULL)
		OR (`cache_kind` = 'named' AND (
			`cache_name` IS NULL
			OR length(`cache_name`) NOT BETWEEN 1 AND 63
			OR `cache_name` NOT GLOB '[a-z0-9]*'
			OR `cache_name` GLOB '*[^a-z0-9._-]*'
		))
);--> statement-breakpoint
-- No two rows may share one identity under the new keys.
INSERT INTO `_cache_identity_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `blob_ref`
	GROUP BY `tenant`, `cache_kind`, `cache_name`, `store_path_hash`, `generation`
	HAVING count(*) > 1
) OR EXISTS (
	SELECT 1
	FROM `attestation_ref`
	GROUP BY `tenant`, `cache_kind`, `cache_name`, `store_path_hash`, `generation`, `predicate_type`, `digest`
	HAVING count(*) > 1
) OR EXISTS (
	SELECT 1
	FROM `cache_lifecycle`
	GROUP BY `tenant`, `cache_kind`, `cache_name`
	HAVING count(*) > 1
) OR EXISTS (
	SELECT 1
	FROM `tenant_cache_read_credential`
	GROUP BY `tenant`, `cache_kind`, `cache_name`
	HAVING count(*) > 1
);--> statement-breakpoint
DROP TABLE `_cache_identity_contract_assertion`;--> statement-breakpoint
UPDATE `blob_ref` SET `cache_generation` = 1 WHERE `cache_generation` IS NULL;--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_blob_ref_insert`;--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_attestation_ref_insert`;--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_lifecycle_insert`;--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_credential_insert`;--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_tenant_read_mode_update`;--> statement-breakpoint
DROP TRIGGER `cache_access_mirror_tenant_insert`;

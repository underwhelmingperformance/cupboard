CREATE TABLE `_cache_access_contract_assertion` (
	`valid` integer NOT NULL CHECK (`valid` = 1)
);--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `reuse_view_revision_seq`
	GROUP BY CASE WHEN `name` LIKE 'private/%' THEN substr(`name`, 9) ELSE `name` END
	HAVING count(*) > 1
);--> statement-breakpoint
UPDATE `reuse_view_selector_native`
SET `view` = substr(`view`, 9)
WHERE `view` LIKE 'private/%';--> statement-breakpoint
UPDATE `reuse_view_revision_seq`
SET `name` = substr(`name`, 9)
WHERE `name` LIKE 'private/%';--> statement-breakpoint
UPDATE `reuse_view`
SET `name` = substr(`name`, 9)
WHERE `name` LIKE 'private/%';--> statement-breakpoint
CREATE TABLE `_generation_seq_cache_scope` (
	`cache_kind` text,
	`cache_name` text,
	`store_path_hash` text NOT NULL,
	`next_generation` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `_generation_seq_cache_scope` (
	`cache_kind`, `cache_name`, `store_path_hash`, `next_generation`
)
SELECT
	`cache_kind`, `cache_name`, `store_path_hash`, max(`next_generation`)
FROM (
	SELECT
		`cache_kind`, `cache_name`, `store_path_hash`, `next_generation`
	FROM `generation_seq`
	UNION ALL
	SELECT
		CASE WHEN `narinfo`.`cache` = '' THEN 'default' ELSE 'named' END,
		CASE
			WHEN `narinfo`.`cache` = '' THEN NULL
			WHEN `narinfo`.`cache` LIKE 'private/%' THEN substr(`narinfo`.`cache`, 9)
			ELSE `narinfo`.`cache`
		END,
		`narinfo`.`store_path_hash`,
		`narinfo`.`generation` + 1
	FROM `narinfo`
	UNION ALL
	SELECT
		CASE WHEN `narinfo_deletion`.`cache` = '' THEN 'default' ELSE 'named' END,
		CASE
			WHEN `narinfo_deletion`.`cache` = '' THEN NULL
			WHEN `narinfo_deletion`.`cache` LIKE 'private/%' THEN substr(`narinfo_deletion`.`cache`, 9)
			ELSE `narinfo_deletion`.`cache`
		END,
		`narinfo_deletion`.`store_path_hash`,
		`narinfo_deletion`.`generation` + 1
	FROM `narinfo_deletion`
)
GROUP BY `cache_kind`, `cache_name`, `store_path_hash`;--> statement-breakpoint
DELETE FROM `generation_seq`;--> statement-breakpoint
INSERT INTO `generation_seq` (
	`cache`, `cache_kind`, `cache_name`, `store_path_hash`, `next_generation`
)
SELECT
	CASE WHEN `cache_kind` = 'default' THEN '' ELSE `cache_name` END,
	`cache_kind`, `cache_name`, `store_path_hash`, `next_generation`
FROM `_generation_seq_cache_scope`;--> statement-breakpoint
DROP TABLE `_generation_seq_cache_scope`;--> statement-breakpoint
INSERT INTO `_cache_access_contract_assertion` (`valid`)
SELECT 0
WHERE
	(SELECT count(*) FROM `cache_identity` WHERE `access` IS NULL OR `access` NOT IN ('public', 'private')) > 0
	OR (SELECT count(*) FROM `cache_identity` WHERE
		`kind` IS NULL
		OR `kind` NOT IN ('default', 'named')
		OR (`kind` = 'default' AND `name` IS NOT NULL)
		OR (`kind` = 'named' AND (
			`name` IS NULL
			OR length(`name`) NOT BETWEEN 1 AND 63
			OR substr(`name`, 1, 1) NOT GLOB '[a-z0-9]'
			OR `name` GLOB '*[^a-z0-9._-]*'
		))
	) > 0
	OR (SELECT count(*) FROM `cache_identity` WHERE `kind` = 'default' AND `name` IS NULL) <> 1
	OR (SELECT count(*) FROM `reuse_view` WHERE `access` IS NULL OR `access` NOT IN ('public', 'private')) > 0
	OR (SELECT count(*) FROM `reuse_view` WHERE
		length(`name`) NOT BETWEEN 1 AND 63
		OR substr(`name`, 1, 1) NOT GLOB '[a-z0-9]'
		OR `name` GLOB '*[^a-z0-9._-]*'
	) > 0
	OR (SELECT count(*) FROM `reuse_view_selector_native` WHERE
		length(`view`) NOT BETWEEN 1 AND 63
		OR substr(`view`, 1, 1) NOT GLOB '[a-z0-9]'
		OR `view` GLOB '*[^a-z0-9._-]*'
		OR `kind` IS NULL
		OR `kind` NOT IN ('default', 'named', 'prefix', 'all-named', 'all')
		OR (`kind` IN ('default', 'all-named', 'all') AND (`cache_name` IS NOT NULL OR `prefix` IS NOT NULL))
		OR (`kind` = 'named' AND (
			`cache_name` IS NULL
			OR length(`cache_name`) NOT BETWEEN 1 AND 63
			OR substr(`cache_name`, 1, 1) NOT GLOB '[a-z0-9]'
			OR `cache_name` GLOB '*[^a-z0-9._-]*'
			OR `prefix` IS NOT NULL
		))
		OR (`kind` = 'prefix' AND (
			`cache_name` IS NOT NULL
			OR `prefix` IS NULL
			OR length(`prefix`) NOT BETWEEN 1 AND 63
			OR substr(`prefix`, 1, 1) NOT GLOB '[a-z0-9]'
			OR `prefix` GLOB '*[^a-z0-9._-]*'
		))
	) > 0
	OR (SELECT count(*) FROM `narinfo` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `generation_seq` WHERE
		(`cache_kind` = 'default' AND `cache_name` IS NOT NULL)
		OR (`cache_kind` = 'named' AND (
			`cache_name` IS NULL
			OR length(`cache_name`) NOT BETWEEN 1 AND 63
			OR substr(`cache_name`, 1, 1) NOT GLOB '[a-z0-9]'
			OR `cache_name` GLOB '*[^a-z0-9._-]*'
		))
		OR `cache_kind` IS NULL
		OR `cache_kind` NOT IN ('default', 'named')
	) > 0
	OR (SELECT count(*) FROM `pending_upload` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `pending_attestation` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `narinfo_deletion` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `retention_root` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `retention_root_target` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `retention_grace` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `garbage_collection_revision` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `garbage_collection_scan` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `garbage_collection_frontier` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `garbage_collection_mark` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `garbage_collection_tenant_run` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `verification_cursor` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `retention_policy` WHERE `kind` IS NULL) > 0
	OR (SELECT count(*) FROM `reuse_view_selector`) <> (SELECT count(*) FROM `reuse_view_selector_native`);--> statement-breakpoint
DROP TABLE `_cache_access_contract_assertion`;

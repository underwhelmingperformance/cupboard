-- Custom SQL migration file, put your code below! --
CREATE TABLE `_cache_identity_contract_assertion` (
	`valid` integer NOT NULL CHECK (`valid` = 1)
);--> statement-breakpoint
INSERT INTO `_cache_identity_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `reuse_view_revision_seq`
	GROUP BY CASE WHEN `name` LIKE 'private/%' THEN substr(`name`, 9) ELSE `name` END
	HAVING count(*) > 1
);--> statement-breakpoint
UPDATE `reuse_view`
SET `name` = substr(`name`, 9)
WHERE `name` LIKE 'private/%';--> statement-breakpoint
UPDATE `reuse_view_revision_seq`
SET `name` = substr(`name`, 9)
WHERE `name` LIKE 'private/%';--> statement-breakpoint
UPDATE `reuse_view_selector_native`
SET `view` = substr(`view`, 9)
WHERE `view` LIKE 'private/%';--> statement-breakpoint
UPDATE `narinfo`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`narinfo`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `narinfo`.`cache` LIKE 'private/%' THEN substr(`narinfo`.`cache`, 9) ELSE `narinfo`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `narinfo_deletion`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`narinfo_deletion`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `narinfo_deletion`.`cache` LIKE 'private/%' THEN substr(`narinfo_deletion`.`cache`, 9) ELSE `narinfo_deletion`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `pending_upload`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`pending_upload`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `pending_upload`.`cache` LIKE 'private/%' THEN substr(`pending_upload`.`cache`, 9) ELSE `pending_upload`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `pending_attestation`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`pending_attestation`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `pending_attestation`.`cache` LIKE 'private/%' THEN substr(`pending_attestation`.`cache`, 9) ELSE `pending_attestation`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `retention_root`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`retention_root`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `retention_root`.`cache` LIKE 'private/%' THEN substr(`retention_root`.`cache`, 9) ELSE `retention_root`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `retention_root_target`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`retention_root_target`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `retention_root_target`.`cache` LIKE 'private/%' THEN substr(`retention_root_target`.`cache`, 9) ELSE `retention_root_target`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `retention_grace`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`retention_grace`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `retention_grace`.`cache` LIKE 'private/%' THEN substr(`retention_grace`.`cache`, 9) ELSE `retention_grace`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `garbage_collection_revision`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`garbage_collection_revision`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `garbage_collection_revision`.`cache` LIKE 'private/%' THEN substr(`garbage_collection_revision`.`cache`, 9) ELSE `garbage_collection_revision`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `garbage_collection_scan`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`garbage_collection_scan`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `garbage_collection_scan`.`cache` LIKE 'private/%' THEN substr(`garbage_collection_scan`.`cache`, 9) ELSE `garbage_collection_scan`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `garbage_collection_frontier`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`garbage_collection_frontier`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `garbage_collection_frontier`.`cache` LIKE 'private/%' THEN substr(`garbage_collection_frontier`.`cache`, 9) ELSE `garbage_collection_frontier`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `garbage_collection_mark`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`garbage_collection_mark`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `garbage_collection_mark`.`cache` LIKE 'private/%' THEN substr(`garbage_collection_mark`.`cache`, 9) ELSE `garbage_collection_mark`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `garbage_collection_tenant_run`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`garbage_collection_tenant_run`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `garbage_collection_tenant_run`.`cache` LIKE 'private/%' THEN substr(`garbage_collection_tenant_run`.`cache`, 9) ELSE `garbage_collection_tenant_run`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `verification_cursor`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`verification_cursor`.`cache` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `verification_cursor`.`cache` LIKE 'private/%' THEN substr(`verification_cursor`.`cache`, 9) ELSE `verification_cursor`.`cache` END))
)
WHERE `cache_id` IS NULL;--> statement-breakpoint
UPDATE `retention_policy`
SET `cache_id` = (
	SELECT `id` FROM `cache_identity`
	WHERE `cache_identity`.`deleted_at` IS NULL
		AND ((`retention_policy`.`pattern` = '' AND `cache_identity`.`kind` = 'default')
			OR (`cache_identity`.`kind` = 'named' AND `cache_identity`.`name` = CASE WHEN `retention_policy`.`pattern` LIKE 'private/%' THEN substr(`retention_policy`.`pattern`, 9) ELSE `retention_policy`.`pattern` END))
)
WHERE `cache_id` IS NULL AND `scope` = 'cache';--> statement-breakpoint
UPDATE `retention_policy`
SET
	`kind` = CASE WHEN `scope` = 'cache' THEN 'cache' ELSE 'root-name-prefix' END,
	`root_name_prefix` = CASE WHEN `scope` = 'root-name-prefix' THEN `pattern` ELSE `root_name_prefix` END
WHERE `kind` IS NULL;--> statement-breakpoint
DELETE FROM `retention_policy`
WHERE `kind` = 'cache' AND `cache_id` IS NULL;--> statement-breakpoint
CREATE TABLE `_generation_seq_cache_identity` (
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`store_path_hash` text NOT NULL,
	`next_generation` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `_generation_seq_cache_identity` (
	`cache_kind`, `cache_name`, `store_path_hash`, `next_generation`
)
SELECT `cache_kind`, `cache_name`, `store_path_hash`, max(`next_generation`)
FROM (
	SELECT `cache_kind`, `cache_name`, `store_path_hash`, `next_generation`
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
FROM `_generation_seq_cache_identity`;--> statement-breakpoint
DROP TABLE `_generation_seq_cache_identity`;--> statement-breakpoint
INSERT INTO `_cache_identity_contract_assertion` (`valid`)
SELECT 0
WHERE
	(SELECT count(*) FROM `cache_identity` WHERE `access` IS NULL) > 0
	OR (SELECT count(*) FROM `reuse_view` WHERE `access` IS NULL) > 0
	OR (SELECT count(*) FROM `narinfo` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `narinfo_deletion` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `pending_upload` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `pending_attestation` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `retention_root` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `retention_root_target` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `retention_grace` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `garbage_collection_revision` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `garbage_collection_scan` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `garbage_collection_frontier` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `garbage_collection_mark` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `garbage_collection_tenant_run` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `verification_cursor` WHERE `cache_id` IS NULL) > 0
	OR (SELECT count(*) FROM `retention_policy` WHERE `kind` IS NULL) > 0;--> statement-breakpoint
INSERT INTO `_cache_identity_contract_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1 FROM `narinfo` GROUP BY `cache_id`, `store_path_hash` HAVING count(*) > 1
) OR EXISTS (
	SELECT 1 FROM `narinfo_deletion` GROUP BY `cache_id`, `store_path_hash`, `generation` HAVING count(*) > 1
) OR EXISTS (
	SELECT 1 FROM `retention_root` GROUP BY `cache_id`, `name` HAVING count(*) > 1
) OR EXISTS (
	SELECT 1 FROM `retention_root_target` GROUP BY `cache_id`, `root_name`, `store_path_hash` HAVING count(*) > 1
) OR EXISTS (
	SELECT 1 FROM `retention_grace` GROUP BY `cache_id`, `store_path_hash` HAVING count(*) > 1
) OR EXISTS (
	SELECT 1 FROM `garbage_collection_revision` GROUP BY `cache_id` HAVING count(*) > 1
) OR EXISTS (
	SELECT 1 FROM `garbage_collection_scan` GROUP BY `cache_id` HAVING count(*) > 1
) OR EXISTS (
	SELECT 1 FROM `garbage_collection_frontier` GROUP BY `cache_id`, `store_path_hash` HAVING count(*) > 1
) OR EXISTS (
	SELECT 1 FROM `garbage_collection_mark` GROUP BY `cache_id`, `store_path_hash` HAVING count(*) > 1
) OR EXISTS (
	SELECT 1 FROM `retention_policy` WHERE `kind` = 'cache' GROUP BY `cache_id` HAVING count(*) > 1
) OR EXISTS (
	SELECT 1 FROM `retention_policy` WHERE `kind` = 'root-name-prefix' GROUP BY `root_name_prefix` HAVING count(*) > 1
);--> statement-breakpoint
DROP TABLE `_cache_identity_contract_assertion`;

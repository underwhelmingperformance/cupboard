CREATE TABLE `cache_root_ttl_override` (
	`cache_id` integer NOT NULL,
	`root_prefix` text NOT NULL,
	`ttl_seconds` integer NOT NULL,
	PRIMARY KEY(`cache_id`, `root_prefix`),
	CONSTRAINT "cache_root_ttl_override_prefix_check" CHECK(length("cache_root_ttl_override"."root_prefix") BETWEEN 1 AND 256 AND instr("cache_root_ttl_override"."root_prefix", char(0)) = 0 AND "cache_root_ttl_override"."root_prefix" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
	CONSTRAINT "cache_root_ttl_override_ttl_check" CHECK("cache_root_ttl_override"."ttl_seconds" BETWEEN 1 AND 315360000)
);
--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `default_root_ttl_seconds` integer;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `grace_seconds` integer;--> statement-breakpoint
INSERT INTO `cache_root_ttl_override` (`cache_id`, `root_prefix`, `ttl_seconds`)
SELECT
	`cache_identity`.`id`,
	`retention_policy`.`root_name_prefix`,
	`retention_policy`.`default_ttl_seconds`
FROM `cache_identity`
CROSS JOIN `retention_policy`
WHERE `cache_identity`.`deleted_at` IS NULL
	AND `retention_policy`.`kind` = 'root-name-prefix'
	AND `retention_policy`.`root_name_prefix` IS NOT NULL
	AND length(`retention_policy`.`root_name_prefix`) BETWEEN 1 AND 256
	AND instr(`retention_policy`.`root_name_prefix`, char(0)) = 0
	AND `retention_policy`.`root_name_prefix` NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
	AND `retention_policy`.`default_ttl_seconds` BETWEEN 1 AND 315360000;--> statement-breakpoint
UPDATE `cache_identity`
SET `default_root_ttl_seconds` = (
	SELECT `retention_policy`.`default_ttl_seconds`
	FROM `retention_policy`
	WHERE `retention_policy`.`kind` = 'cache'
		AND `retention_policy`.`cache_id` = `cache_identity`.`id`
		AND `retention_policy`.`default_ttl_seconds` BETWEEN 1 AND 315360000
	LIMIT 1
)
WHERE `cache_identity`.`deleted_at` IS NULL
	AND EXISTS (
		SELECT 1
		FROM `retention_policy`
		WHERE `retention_policy`.`kind` = 'cache'
			AND `retention_policy`.`cache_id` = `cache_identity`.`id`
			AND `retention_policy`.`default_ttl_seconds` BETWEEN 1 AND 315360000
	);--> statement-breakpoint
UPDATE `cache_identity`
SET `grace_seconds` = (
	SELECT `retention_grace_policy`.`grace_seconds`
	FROM `retention_grace_policy`
	WHERE `retention_grace_policy`.`grace_seconds` BETWEEN 0 AND 315360000
		AND ((
			`cache_identity`.`kind` = 'default'
			AND `retention_grace_policy`.`cache_prefix` = ''
		) OR (
			`cache_identity`.`kind` = 'named'
			AND substr(
				`cache_identity`.`name`,
				1,
				length(`retention_grace_policy`.`cache_prefix`)
			) = `retention_grace_policy`.`cache_prefix`
		))
	ORDER BY length(`retention_grace_policy`.`cache_prefix`) DESC
	LIMIT 1
)
WHERE `cache_identity`.`deleted_at` IS NULL
	AND `cache_identity`.`access` = 'public'
	AND EXISTS (
		SELECT 1
		FROM `retention_grace_policy`
		WHERE `retention_grace_policy`.`grace_seconds` BETWEEN 0 AND 315360000
			AND ((
				`cache_identity`.`kind` = 'default'
				AND `retention_grace_policy`.`cache_prefix` = ''
			) OR (
				`cache_identity`.`kind` = 'named'
				AND substr(
					`cache_identity`.`name`,
					1,
					length(`retention_grace_policy`.`cache_prefix`)
				) = `retention_grace_policy`.`cache_prefix`
			))
	);--> statement-breakpoint
DROP TABLE `retention_grace_policy`;--> statement-breakpoint
DROP TABLE `retention_policy`;

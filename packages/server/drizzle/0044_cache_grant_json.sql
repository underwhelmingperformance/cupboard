CREATE TABLE `_cache_grant_json_assertion` (
	`valid` integer NOT NULL CONSTRAINT `cache_template_has_fixed_scope` CHECK (`valid` = 1)
);--> statement-breakpoint
INSERT INTO `_cache_grant_json_assertion` (`valid`)
SELECT 0
WHERE EXISTS (
	SELECT 1
	FROM `oidc_trust`, json_each(`oidc_trust`.`permitted_grants_json`) AS `grant_item`
	WHERE json_extract(`grant_item`.`value`, '$.type') = 'cupboard_cache'
		AND json_type(`grant_item`.`value`, '$.resources.cache.kind') IS NULL
		AND json_extract(`grant_item`.`value`, '$.resources.cache.equalsTemplate') LIKE '{%'
);--> statement-breakpoint
DROP TABLE `_cache_grant_json_assertion`;--> statement-breakpoint
CREATE TABLE `_oidc_trust_grant_migration` (
	`rule_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`original_json` text NOT NULL,
	`migrated_json` text NOT NULL,
	PRIMARY KEY (`rule_id`, `ordinal`)
);--> statement-breakpoint
INSERT INTO `_oidc_trust_grant_migration` (`rule_id`, `ordinal`, `original_json`, `migrated_json`)
SELECT
	`oidc_trust`.`id`,
	CAST(`grant_item`.`key` AS integer),
	`grant_item`.`value`,
	`grant_item`.`value`
FROM `oidc_trust`, json_each(`oidc_trust`.`permitted_grants_json`) AS `grant_item`;--> statement-breakpoint
UPDATE `_oidc_trust_grant_migration`
SET `migrated_json` = CASE
	WHEN json_extract(`original_json`, '$.type') IS NOT 'cupboard_cache' THEN `original_json`
	WHEN json_type(`original_json`, '$.resources.cache.kind') IS NOT NULL THEN `original_json`
	WHEN json_extract(`original_json`, '$.resources.cache.exact') = '_default'
		OR json_extract(`original_json`, '$.resources.cache.equalsTemplate') = '_default'
	THEN json_set(
		`original_json`,
		'$.resources.cache',
		json_object('kind', 'default')
	)
	WHEN json_type(`original_json`, '$.resources.cache.exact') IS NOT NULL THEN json_set(
		json_set(
			`original_json`,
			'$.resources.cache.kind',
			'named'
		),
		'$.resources.cache.exact',
		CASE
			WHEN substr(json_extract(`original_json`, '$.resources.cache.exact'), 1, 9) = '_private-'
			THEN substr(json_extract(`original_json`, '$.resources.cache.exact'), 10)
			ELSE json_extract(`original_json`, '$.resources.cache.exact')
		END
	)
	ELSE json_set(
		json_set(
			`original_json`,
			'$.resources.cache.kind',
			'named'
		),
		'$.resources.cache.equalsTemplate',
		CASE
			WHEN substr(json_extract(`original_json`, '$.resources.cache.equalsTemplate'), 1, 9) = '_private-'
			THEN substr(json_extract(`original_json`, '$.resources.cache.equalsTemplate'), 10)
			ELSE json_extract(`original_json`, '$.resources.cache.equalsTemplate')
		END
	)
END;--> statement-breakpoint
UPDATE `_oidc_trust_grant_migration`
SET `migrated_json` = json_set(
	`migrated_json`,
	'$.resources.root',
	CASE
		WHEN json_type(`original_json`, '$.resources.cache.exact') IS NOT NULL THEN json_object(
			'exact',
			json_extract(`original_json`, '$.resources.cache.exact'),
			'validate',
			'rootName'
		)
		WHEN json_type(`original_json`, '$.resources.cache.substitutions') IS NULL THEN json_object(
			'equalsTemplate',
			json_extract(`original_json`, '$.resources.cache.equalsTemplate'),
			'validate',
			'rootName'
		)
		ELSE json_object(
			'equalsTemplate',
			json_extract(`original_json`, '$.resources.cache.equalsTemplate'),
			'substitutions',
			json(json_extract(`original_json`, '$.resources.cache.substitutions')),
			'validate',
			'rootName'
		)
	END
)
WHERE json_extract(`original_json`, '$.type') = 'cupboard_cache'
	AND json_extract(`original_json`, '$.resources.root.equalsResource') = 'cache';--> statement-breakpoint
UPDATE `oidc_trust`
SET `permitted_grants_json` = (
	SELECT json_group_array(json(`migrated_json`))
	FROM (
		SELECT `migrated_json`
		FROM `_oidc_trust_grant_migration`
		WHERE `rule_id` = `oidc_trust`.`id`
		ORDER BY `ordinal`
	)
);--> statement-breakpoint
DROP TABLE `_oidc_trust_grant_migration`;--> statement-breakpoint
CREATE TABLE `_refresh_grant_migration` (
	`family_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`migrated_json` text NOT NULL,
	PRIMARY KEY (`family_id`, `ordinal`)
);--> statement-breakpoint
INSERT INTO `_refresh_grant_migration` (`family_id`, `ordinal`, `migrated_json`)
SELECT
	`refresh_token_family`.`id`,
	CAST(`grant_item`.`key` AS integer),
	CASE
		WHEN json_extract(`grant_item`.`value`, '$.type') IS NOT 'cupboard_cache'
			OR json_type(`grant_item`.`value`, '$.cache') IS NOT 'text'
		THEN `grant_item`.`value`
		WHEN json_extract(`grant_item`.`value`, '$.cache') = '_default' THEN json_set(
			`grant_item`.`value`,
			'$.cache',
			json_object('kind', 'default')
		)
		ELSE json_set(
			`grant_item`.`value`,
			'$.cache',
			json_object(
				'kind',
				'named',
				'name',
				CASE
					WHEN substr(json_extract(`grant_item`.`value`, '$.cache'), 1, 9) = '_private-'
					THEN substr(json_extract(`grant_item`.`value`, '$.cache'), 10)
					ELSE json_extract(`grant_item`.`value`, '$.cache')
				END
			)
		)
	END
FROM `refresh_token_family`, json_each(`refresh_token_family`.`grants_json`) AS `grant_item`
WHERE `refresh_token_family`.`grants_json` IS NOT NULL;--> statement-breakpoint
UPDATE `refresh_token_family`
SET `grants_json` = (
	SELECT json_group_array(json(`migrated_json`))
	FROM (
		SELECT `migrated_json`
		FROM `_refresh_grant_migration`
		WHERE `family_id` = `refresh_token_family`.`id`
		ORDER BY `ordinal`
	)
)
WHERE `grants_json` IS NOT NULL;--> statement-breakpoint
DROP TABLE `_refresh_grant_migration`;

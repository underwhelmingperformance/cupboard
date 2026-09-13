-- A stored cache grant could bind its root to the cache it grants authority
-- over, with `root.equalsResource = 'cache'`. A cache is now bound by a scope
-- whose default variant has no name to copy, so that spelling has left the
-- grant grammar and a rule still carrying it no longer parses. Rewrite each one
-- into the explicit root binding it stood for.
--
-- The cache binding itself is left as stored. A rule written before this build,
-- or by this build before the deploy records `contracted`, spells the cache as
-- a selector: `_default` for the default cache and a `_private-` prefix for a
-- private one. The root that binding copied was the cache's name, so the copy
-- strips the prefix. A grant bound to the default cache resolved no root name
-- and therefore permitted no root-bearing request; dropping its root binding
-- leaves it permitting none, so authority does not widen.
CREATE TABLE `_root_binding_migration` (
	`rule_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`migrated_json` text NOT NULL,
	PRIMARY KEY (`rule_id`, `ordinal`)
);--> statement-breakpoint
INSERT INTO `_root_binding_migration` (`rule_id`, `ordinal`, `migrated_json`)
SELECT
	`oidc_trust`.`id`,
	CAST(`grant_item`.`key` AS integer),
	CASE
		WHEN json_extract(`grant_item`.`value`, '$.type') IS NOT 'cupboard_cache'
			OR json_extract(`grant_item`.`value`, '$.resources.root.equalsResource') IS NOT 'cache'
		THEN `grant_item`.`value`
		WHEN json_extract(`grant_item`.`value`, '$.resources.cache.kind') = 'default'
			OR json_extract(`grant_item`.`value`, '$.resources.cache.exact') = '_default'
			OR json_extract(`grant_item`.`value`, '$.resources.cache.equalsTemplate') = '_default'
		THEN json_remove(`grant_item`.`value`, '$.resources.root')
		WHEN json_type(`grant_item`.`value`, '$.resources.cache.exact') IS NOT NULL
		THEN json_set(
			`grant_item`.`value`,
			'$.resources.root',
			json_object(
				'exact',
				CASE
					WHEN json_extract(`grant_item`.`value`, '$.resources.cache.exact') GLOB '_private-*'
					THEN substr(json_extract(`grant_item`.`value`, '$.resources.cache.exact'), length('_private-') + 1)
					ELSE json_extract(`grant_item`.`value`, '$.resources.cache.exact')
				END,
				'validate',
				'rootName'
			)
		)
		WHEN json_type(`grant_item`.`value`, '$.resources.cache.substitutions') IS NULL
		THEN json_set(
			`grant_item`.`value`,
			'$.resources.root',
			json_object(
				'equalsTemplate',
				CASE
					WHEN json_extract(`grant_item`.`value`, '$.resources.cache.equalsTemplate') GLOB '_private-*'
					THEN substr(json_extract(`grant_item`.`value`, '$.resources.cache.equalsTemplate'), length('_private-') + 1)
					ELSE json_extract(`grant_item`.`value`, '$.resources.cache.equalsTemplate')
				END,
				'validate',
				'rootName'
			)
		)
		ELSE json_set(
			`grant_item`.`value`,
			'$.resources.root',
			json_object(
				'equalsTemplate',
				CASE
					WHEN json_extract(`grant_item`.`value`, '$.resources.cache.equalsTemplate') GLOB '_private-*'
					THEN substr(json_extract(`grant_item`.`value`, '$.resources.cache.equalsTemplate'), length('_private-') + 1)
					ELSE json_extract(`grant_item`.`value`, '$.resources.cache.equalsTemplate')
				END,
				'substitutions',
				json(json_extract(`grant_item`.`value`, '$.resources.cache.substitutions')),
				'validate',
				'rootName'
			)
		)
	END
FROM `oidc_trust`, json_each(`oidc_trust`.`permitted_grants_json`) AS `grant_item`;--> statement-breakpoint
UPDATE `oidc_trust`
SET `permitted_grants_json` = (
	SELECT json_group_array(json(`migrated_json`))
	FROM (
		SELECT `migrated_json`
		FROM `_root_binding_migration`
		WHERE `rule_id` = `oidc_trust`.`id`
		ORDER BY `ordinal`
	)
)
WHERE EXISTS (
	SELECT 1
	FROM json_each(`oidc_trust`.`permitted_grants_json`) AS `grant_item`
	WHERE json_extract(`grant_item`.`value`, '$.resources.root.equalsResource') = 'cache'
);--> statement-breakpoint
DROP TABLE `_root_binding_migration`;

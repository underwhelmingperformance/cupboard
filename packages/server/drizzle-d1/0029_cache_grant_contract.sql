UPDATE `control_trust`
SET `permitted_grants_json` = (
	SELECT json_group_array(
		CASE
			WHEN json_extract(`grant`.`value`, '$.type') <> 'cupboard_cache'
				THEN json(`grant`.`value`)
			WHEN json_extract(`grant`.`value`, '$.resources.cache.kind') IS NOT NULL
				THEN json(`grant`.`value`)
			WHEN json_extract(`grant`.`value`, '$.resources.cache.exact') = '_default'
				OR json_extract(`grant`.`value`, '$.resources.cache.equalsTemplate') = '_default'
				THEN json_set(
					`grant`.`value`,
					'$.resources.cache', json('{"kind":"default"}')
				)
			WHEN json_extract(`grant`.`value`, '$.resources.cache.exact') GLOB '_private-*'
				THEN json_set(
					`grant`.`value`,
					'$.resources.cache.kind', 'named',
					'$.resources.cache.exact',
					substr(json_extract(`grant`.`value`, '$.resources.cache.exact'), 10)
				)
			WHEN json_extract(`grant`.`value`, '$.resources.cache.equalsTemplate') GLOB '_private-*'
				THEN json_set(
					`grant`.`value`,
					'$.resources.cache.kind', 'named',
					'$.resources.cache.equalsTemplate',
					substr(json_extract(`grant`.`value`, '$.resources.cache.equalsTemplate'), 10)
				)
			ELSE json_set(`grant`.`value`, '$.resources.cache.kind', 'named')
		END
	)
	FROM json_each(`control_trust`.`permitted_grants_json`) AS `grant`
)
WHERE EXISTS (
	SELECT 1
	FROM json_each(`control_trust`.`permitted_grants_json`) AS `grant`
	WHERE json_extract(`grant`.`value`, '$.type') = 'cupboard_cache'
		AND json_extract(`grant`.`value`, '$.resources.cache.kind') IS NULL
);

--> statement-breakpoint
CREATE TRIGGER control_trust_native_grants_insert
BEFORE INSERT ON control_trust
WHEN EXISTS (
 SELECT 1 FROM json_each(NEW.permitted_grants_json) AS grant
 WHERE json_extract(grant.value, '$.type') = 'cupboard_cache'
  AND json_extract(grant.value, '$.resources.cache.kind') IS NULL
)
BEGIN
 SELECT RAISE(ABORT, 'cache grants require scope spelling after contraction');
END;

--> statement-breakpoint
CREATE TRIGGER control_trust_native_grants_update
BEFORE UPDATE ON control_trust
WHEN EXISTS (
 SELECT 1 FROM json_each(NEW.permitted_grants_json) AS grant
 WHERE json_extract(grant.value, '$.type') = 'cupboard_cache'
  AND json_extract(grant.value, '$.resources.cache.kind') IS NULL
)
BEGIN
 SELECT RAISE(ABORT, 'cache grants require scope spelling after contraction');
END;

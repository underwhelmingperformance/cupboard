UPDATE `control_trust`
SET `permitted_grants_json` = (
	SELECT json_group_array(
		CASE
			WHEN json_extract(`grant`.`value`, '$.type') <> 'cupboard_cache'
				THEN json(`grant`.`value`)
			WHEN json_extract(`grant`.`value`, '$.resources.cache.kind') IS NOT NULL
				THEN json(`grant`.`value`)
			WHEN json_extract(`grant`.`value`, '$.resources.cache.exact') = '_default'
				THEN json_set(
					json_remove(
						`grant`.`value`,
						'$.resources.cache.exact',
						'$.resources.cache.validate'
					),
					'$.resources.cache.kind', 'default'
				)
			WHEN json_extract(`grant`.`value`, '$.resources.cache.exact') LIKE '\_private-%' ESCAPE '\'
				THEN json_set(
					`grant`.`value`,
					'$.resources.cache.kind', 'named',
					'$.resources.cache.exact',
					substr(json_extract(`grant`.`value`, '$.resources.cache.exact'), 10)
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

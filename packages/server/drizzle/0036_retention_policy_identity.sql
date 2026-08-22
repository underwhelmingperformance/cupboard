DELETE FROM `retention_policy` AS `existing`
WHERE EXISTS (
	SELECT 1
	FROM `retention_policy` AS `winner`
	WHERE `winner`.`scope` = `existing`.`scope`
		AND `winner`.`pattern` = `existing`.`pattern`
		AND (
			`winner`.`created_at` > `existing`.`created_at`
			OR (
				`winner`.`created_at` = `existing`.`created_at`
				AND `winner`.`id` > `existing`.`id`
			)
		)
);--> statement-breakpoint
CREATE UNIQUE INDEX `retention_policy_scope_pattern_unique` ON `retention_policy` (`scope`,`pattern`);

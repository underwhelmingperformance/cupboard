ALTER TABLE `global_admin` ADD `audience` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `global_admin`
SET `audience` = (
	SELECT `audience`
	FROM `control_trust`
	WHERE `id` = 'signup'
)
WHERE `id` = 'singleton'
	AND EXISTS (SELECT 1 FROM `control_trust` WHERE `id` = 'signup');

-- `cupboard deploy` can create this table before this migration runs, so the
-- statement must keep IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS `deployment_transition` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	`contracted_at` text
);

-- `cupboard deploy` creates this table itself before it walks the schema
-- transitions, because it has to record the first transition on a database
-- from before this migration. This migration creates it for a database set up
-- by wrangler or the Workers test pool, so the drizzle snapshot knows it, and
-- is a no-op where the deploy got there first.
CREATE TABLE IF NOT EXISTS `deployment_transition` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);

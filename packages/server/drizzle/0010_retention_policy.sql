CREATE TABLE `retention_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`pattern` text NOT NULL,
	`default_ttl_seconds` integer NOT NULL,
	`created_at` text NOT NULL
);

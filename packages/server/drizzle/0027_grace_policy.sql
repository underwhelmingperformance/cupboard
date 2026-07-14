CREATE TABLE `retention_grace_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_prefix` text NOT NULL,
	`grace_seconds` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retention_grace_policy_cache_prefix_unique` ON `retention_grace_policy` (`cache_prefix`);

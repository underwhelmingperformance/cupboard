CREATE TABLE `cache_teardown` (
	`cache_id` integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `staging_cleanup` (
	`cache_id` integer NOT NULL,
	`r2_key` text NOT NULL,
	PRIMARY KEY(`cache_id`, `r2_key`)
);

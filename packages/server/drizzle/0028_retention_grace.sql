CREATE TABLE `retention_grace` (
	`cache` text DEFAULT '' NOT NULL,
	`store_path_hash` text NOT NULL,
	`retain_until` text NOT NULL,
	PRIMARY KEY(`cache`, `store_path_hash`)
);
--> statement-breakpoint
CREATE INDEX `retention_grace_retain_until_idx` ON `retention_grace` (`retain_until`);--> statement-breakpoint
ALTER TABLE `cache` ADD `grace_managed` integer DEFAULT false NOT NULL;

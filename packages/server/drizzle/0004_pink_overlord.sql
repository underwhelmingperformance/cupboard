CREATE TABLE `retention_root_target` (
	`root_name` text NOT NULL,
	`store_path_hash` text NOT NULL,
	`store_path` text NOT NULL,
	PRIMARY KEY(`root_name`, `store_path_hash`)
);
--> statement-breakpoint
CREATE TABLE `retention_root` (
	`name` text PRIMARY KEY NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

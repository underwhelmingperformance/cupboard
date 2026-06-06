CREATE TABLE `cache` (
	`name` text PRIMARY KEY NOT NULL,
	`priority` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_retention_root_target` (
	`cache` text DEFAULT '' NOT NULL,
	`root_name` text NOT NULL,
	`store_path_hash` text NOT NULL,
	`store_path` text NOT NULL,
	PRIMARY KEY(`cache`, `root_name`, `store_path_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_retention_root_target`("root_name", "store_path_hash", "store_path") SELECT "root_name", "store_path_hash", "store_path" FROM `retention_root_target`;--> statement-breakpoint
DROP TABLE `retention_root_target`;--> statement-breakpoint
ALTER TABLE `__new_retention_root_target` RENAME TO `retention_root_target`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_narinfo` (
	`cache` text DEFAULT '' NOT NULL,
	`store_path_hash` text NOT NULL,
	`store_path` text NOT NULL,
	`nar_hash` text NOT NULL,
	`nar_size` integer NOT NULL,
	`file_hash` text NOT NULL,
	`file_size` integer NOT NULL,
	`compression` text NOT NULL,
	`references_json` text NOT NULL,
	`deriver` text,
	`ca` text,
	`sigs_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`cache`, `store_path_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_narinfo`("store_path_hash", "store_path", "nar_hash", "nar_size", "file_hash", "file_size", "compression", "references_json", "deriver", "ca", "sigs_json", "created_at") SELECT "store_path_hash", "store_path", "nar_hash", "nar_size", "file_hash", "file_size", "compression", "references_json", "deriver", "ca", "sigs_json", "created_at" FROM `narinfo`;--> statement-breakpoint
DROP TABLE `narinfo`;--> statement-breakpoint
ALTER TABLE `__new_narinfo` RENAME TO `narinfo`;--> statement-breakpoint
CREATE TABLE `__new_retention_root` (
	`cache` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`cache`, `name`)
);
--> statement-breakpoint
INSERT INTO `__new_retention_root`("name", "expires_at", "created_at", "updated_at") SELECT "name", "expires_at", "created_at", "updated_at" FROM `retention_root`;--> statement-breakpoint
DROP TABLE `retention_root`;--> statement-breakpoint
ALTER TABLE `__new_retention_root` RENAME TO `retention_root`;

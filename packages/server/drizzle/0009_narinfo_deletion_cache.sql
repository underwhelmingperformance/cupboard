PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_narinfo_deletion` (
	`cache` text DEFAULT '' NOT NULL,
	`store_path_hash` text NOT NULL,
	`nar_hash` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`cache`, `store_path_hash`, `generation`)
);
--> statement-breakpoint
INSERT INTO `__new_narinfo_deletion`("store_path_hash", "nar_hash", "generation", "created_at") SELECT "store_path_hash", "nar_hash", "generation", "created_at" FROM `narinfo_deletion`;--> statement-breakpoint
DROP TABLE `narinfo_deletion`;--> statement-breakpoint
ALTER TABLE `__new_narinfo_deletion` RENAME TO `narinfo_deletion`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

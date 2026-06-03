PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_nar_blob` (
	`nar_hash` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`compression` text NOT NULL,
	`file_hash` text NOT NULL,
	`file_size` integer NOT NULL,
	`nar_size` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_nar_blob`("nar_hash", "r2_key", "compression", "file_hash", "file_size", "nar_size", "created_at") SELECT "nar_hash", "r2_key", "compression", "file_hash", "file_size", 0, "created_at" FROM `nar_blob`;--> statement-breakpoint
DROP TABLE `nar_blob`;--> statement-breakpoint
ALTER TABLE `__new_nar_blob` RENAME TO `nar_blob`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

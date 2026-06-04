CREATE TABLE `generation_seq` (
	`cache` text DEFAULT '' NOT NULL,
	`store_path_hash` text NOT NULL,
	`next_generation` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`cache`, `store_path_hash`)
);
--> statement-breakpoint
ALTER TABLE `narinfo` ADD `generation` integer DEFAULT 0 NOT NULL;

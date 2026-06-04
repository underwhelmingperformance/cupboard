CREATE TABLE `blob_ref` (
	`tenant` text NOT NULL,
	`cache` text NOT NULL,
	`store_path_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`nar_hash` text NOT NULL,
	PRIMARY KEY(`tenant`, `cache`, `store_path_hash`, `generation`)
);
--> statement-breakpoint
CREATE INDEX `blob_ref_nar_hash_idx` ON `blob_ref` (`nar_hash`);--> statement-breakpoint
CREATE TABLE `tenant_blob` (
	`tenant` text NOT NULL,
	`nar_hash` text NOT NULL,
	`file_size` integer NOT NULL,
	PRIMARY KEY(`tenant`, `nar_hash`)
);

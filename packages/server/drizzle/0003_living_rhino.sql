CREATE TABLE `narinfo_deletion` (
	`store_path_hash` text NOT NULL,
	`nar_hash` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`store_path_hash`, `generation`)
);

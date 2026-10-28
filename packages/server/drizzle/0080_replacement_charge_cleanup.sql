CREATE TABLE `replacement_charge_cleanup` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`nar_hash` text NOT NULL,
	`due_at` text NOT NULL,
	PRIMARY KEY(`cache_id`, `store_path_hash`, `generation`)
);
--> statement-breakpoint
CREATE INDEX `replacement_charge_cleanup_due_idx` ON `replacement_charge_cleanup` (`due_at`);

CREATE TABLE `backfill_unpublishable_narinfo` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`target_generation` integer NOT NULL,
	`narinfo_generation` integer NOT NULL,
	`defect` text NOT NULL,
	`failed_attempts` integer NOT NULL,
	`set_aside_at` text NOT NULL,
	PRIMARY KEY(`cache_id`, `store_path_hash`, `target_generation`)
);

CREATE TABLE `verification_cursor` (
	`id` text PRIMARY KEY NOT NULL,
	`cache` text DEFAULT '' NOT NULL,
	`last_store_path_hash` text,
	`updated_at` text NOT NULL
);

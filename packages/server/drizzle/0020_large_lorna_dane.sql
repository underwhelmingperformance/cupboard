CREATE TABLE `pending_attestation` (
	`id` text PRIMARY KEY NOT NULL,
	`cache` text DEFAULT '' NOT NULL,
	`store_path_hash` text NOT NULL,
	`digest` text NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);

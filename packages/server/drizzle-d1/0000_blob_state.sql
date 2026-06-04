CREATE TABLE `blob_state` (
	`nar_hash` text PRIMARY KEY NOT NULL,
	`file_hash` text NOT NULL,
	`file_size` integer NOT NULL,
	`compression` text NOT NULL,
	`nar_size` integer NOT NULL,
	`verified_at` text NOT NULL
);

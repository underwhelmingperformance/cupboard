CREATE TABLE `attestation_inheritance` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`nar_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`not_before` text NOT NULL,
	PRIMARY KEY(`cache_id`, `store_path_hash`, `generation`)
);
--> statement-breakpoint
CREATE INDEX `attestation_inheritance_not_before_idx` ON `attestation_inheritance` (`not_before`);--> statement-breakpoint
ALTER TABLE `narinfo_deletion` ADD `withdrawn` integer DEFAULT false NOT NULL;

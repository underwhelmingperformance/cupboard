CREATE TABLE `cache_lifecycle` (
	`tenant` text NOT NULL,
	`cache` text NOT NULL,
	`generation` integer NOT NULL,
	`deleted_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `cache`)
);
--> statement-breakpoint
ALTER TABLE `blob_ref` ADD `cache_generation` integer;--> statement-breakpoint
CREATE INDEX `blob_ref_tenant_nar_hash_cache_idx` ON `blob_ref` (`tenant`,`nar_hash`,`cache`,`cache_generation`);
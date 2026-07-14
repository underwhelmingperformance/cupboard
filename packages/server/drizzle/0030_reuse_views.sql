CREATE TABLE `reuse_view_revision_seq` (
	`name` text PRIMARY KEY NOT NULL,
	`next_revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reuse_view_selector` (
	`view` text NOT NULL,
	`kind` text NOT NULL,
	`pattern` text NOT NULL,
	PRIMARY KEY(`view`, `kind`, `pattern`)
);
--> statement-breakpoint
CREATE TABLE `reuse_view` (
	`name` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`priority` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `narinfo_store_path_hash_cache_idx` ON `narinfo` (`store_path_hash`,`cache`);

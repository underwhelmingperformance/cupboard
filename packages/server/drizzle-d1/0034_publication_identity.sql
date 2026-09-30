CREATE TABLE `publication` (
	`tenant` text NOT NULL,
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`store_path_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`nar_hash` text NOT NULL,
	`upload_id` text,
	`cache_generation` integer NOT NULL,
	CONSTRAINT "publication_cache_identity_check" CHECK(("publication"."cache_kind" = 'default' AND "publication"."cache_name" IS NULL) OR ("publication"."cache_kind" = 'named' AND "publication"."cache_name" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_default_identity_idx` ON `publication` (`tenant`,`store_path_hash`,`generation`) WHERE "publication"."cache_kind" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX `publication_named_identity_idx` ON `publication` (`tenant`,`cache_name`,`store_path_hash`,`generation`) WHERE "publication"."cache_kind" = 'named';

CREATE TABLE `listing_adoption_parent` (
	`id` text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`tenant` text NOT NULL,
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`cache_generation` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`nar_hash` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "listing_adoption_parent_id_check" CHECK(length("listing_adoption_parent"."id") = 32 AND "listing_adoption_parent"."id" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "listing_adoption_parent_cache_identity_check" CHECK(("listing_adoption_parent"."cache_kind" = 'default' AND "listing_adoption_parent"."cache_name" IS NULL) OR ("listing_adoption_parent"."cache_kind" = 'named' AND "listing_adoption_parent"."cache_name" IS NOT NULL)),
	CONSTRAINT "listing_adoption_parent_generation_check" CHECK(typeof("listing_adoption_parent"."generation") = 'integer' AND "listing_adoption_parent"."generation" BETWEEN 0 AND 9007199254740991 AND typeof("listing_adoption_parent"."cache_generation") = 'integer' AND "listing_adoption_parent"."cache_generation" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_adoption_parent_default_identity_idx` ON `listing_adoption_parent` (`tenant`,`store_path_hash`) WHERE "listing_adoption_parent"."cache_kind" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX `listing_adoption_parent_named_identity_idx` ON `listing_adoption_parent` (`tenant`,`cache_name`,`store_path_hash`) WHERE "listing_adoption_parent"."cache_kind" = 'named';--> statement-breakpoint
CREATE INDEX `listing_adoption_parent_nar_id_idx` ON `listing_adoption_parent` (`nar_hash`,`id`);--> statement-breakpoint
CREATE INDEX `listing_adoption_parent_tenant_id_idx` ON `listing_adoption_parent` (`tenant`,`id`);

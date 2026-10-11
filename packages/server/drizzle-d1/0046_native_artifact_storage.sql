CREATE TABLE `artifact_ref` (
	`tenant` text NOT NULL,
	`artifact_id` text NOT NULL,
	`artifact_generation` integer NOT NULL,
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`cache_generation` integer NOT NULL,
	`kind` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `artifact_id`, `artifact_generation`),
	CONSTRAINT "artifact_ref_cache_identity_check" CHECK(("artifact_ref"."cache_kind" = 'default' AND "artifact_ref"."cache_name" IS NULL) OR ("artifact_ref"."cache_kind" = 'named' AND "artifact_ref"."cache_name" IS NOT NULL)),
	CONSTRAINT "artifact_ref_generation_check" CHECK("artifact_ref"."artifact_generation" >= 1),
	CONSTRAINT "artifact_ref_cache_generation_check" CHECK("artifact_ref"."cache_generation" >= 1)
);
--> statement-breakpoint
CREATE INDEX `artifact_ref_digest_idx` ON `artifact_ref` (`digest`,`tenant`);
--> statement-breakpoint
CREATE INDEX `artifact_ref_tenant_digest_idx` ON `artifact_ref` (`tenant`,`digest`);
--> statement-breakpoint
CREATE INDEX `artifact_ref_cache_idx` ON `artifact_ref` (`tenant`,`cache_kind`,`cache_name`,`cache_generation`,`artifact_id`,`artifact_generation`);
--> statement-breakpoint
CREATE TABLE `listing_fact` (
	`nar_hash` text NOT NULL,
	`generator_revision` text NOT NULL,
	`format` integer NOT NULL,
	`digest` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`nar_hash`, `generator_revision`),
	CONSTRAINT "listing_fact_format_check" CHECK("listing_fact"."format" = 1),
	CONSTRAINT "listing_fact_size_check" CHECK("listing_fact"."size" > 0)
);

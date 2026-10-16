CREATE TABLE `shared_listing_stage` (
	`id` text PRIMARY KEY NOT NULL,
	`nar_hash` text NOT NULL,
	`generator_revision` text NOT NULL,
	`source_incarnation` integer NOT NULL,
	`computation_generation` integer NOT NULL,
	`r2_key` text NOT NULL,
	`maximum_bytes` integer NOT NULL,
	`state` text NOT NULL,
	`multipart_id` text,
	`writes_sealed` integer DEFAULT false NOT NULL,
	`digest` text,
	`size` integer,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`write_until` text NOT NULL,
	`cleanup_after` text NOT NULL,
	`next_cleanup_at` text NOT NULL,
	`cleanup_generation` integer DEFAULT 0 NOT NULL,
	`cleanup_owner` text,
	`cleanup_lease_expires_at` text,
	CONSTRAINT "shared_listing_stage_state_check" CHECK("shared_listing_stage"."state" IN ('pending', 'ready', 'retired')),
	CONSTRAINT "shared_listing_stage_generation_check" CHECK(typeof("shared_listing_stage"."source_incarnation") = 'integer' AND "shared_listing_stage"."source_incarnation" BETWEEN 1 AND 9007199254740991
		AND typeof("shared_listing_stage"."computation_generation") = 'integer' AND "shared_listing_stage"."computation_generation" BETWEEN 1 AND 9007199254740991
		AND typeof("shared_listing_stage"."cleanup_generation") = 'integer' AND "shared_listing_stage"."cleanup_generation" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "shared_listing_stage_budget_check" CHECK(typeof("shared_listing_stage"."maximum_bytes") = 'integer' AND "shared_listing_stage"."maximum_bytes" BETWEEN 1 AND 67108864
		AND ("shared_listing_stage"."size" IS NULL OR (typeof("shared_listing_stage"."size") = 'integer' AND "shared_listing_stage"."size" BETWEEN 0 AND "shared_listing_stage"."maximum_bytes"))),
	CONSTRAINT "shared_listing_stage_seal_check" CHECK(("shared_listing_stage"."writes_sealed" = 0 AND "shared_listing_stage"."digest" IS NULL AND "shared_listing_stage"."size" IS NULL)
		OR ("shared_listing_stage"."writes_sealed" = 1 AND "shared_listing_stage"."multipart_id" IS NOT NULL AND "shared_listing_stage"."digest" IS NOT NULL AND "shared_listing_stage"."size" IS NOT NULL)),
	CONSTRAINT "shared_listing_stage_ready_check" CHECK("shared_listing_stage"."state" <> 'ready' OR "shared_listing_stage"."writes_sealed" = 1),
	CONSTRAINT "shared_listing_stage_cleanup_claim_check" CHECK(("shared_listing_stage"."cleanup_generation" = 0 AND "shared_listing_stage"."cleanup_owner" IS NULL AND "shared_listing_stage"."cleanup_lease_expires_at" IS NULL)
		OR ("shared_listing_stage"."cleanup_generation" > 0 AND "shared_listing_stage"."cleanup_owner" IS NOT NULL AND "shared_listing_stage"."state" = 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_listing_stage_computation_idx` ON `shared_listing_stage` (`nar_hash`,`generator_revision`,`computation_generation`);--> statement-breakpoint
CREATE INDEX `shared_listing_stage_recovery_idx` ON `shared_listing_stage` (`nar_hash`,`generator_revision`,`state`,`cleanup_after`,`id`);--> statement-breakpoint
CREATE INDEX `shared_listing_stage_cleanup_idx` ON `shared_listing_stage` (`next_cleanup_at`,`id`);

CREATE TABLE `forward_listing_stage` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`upload_id` text NOT NULL,
	`owner` text NOT NULL,
	`nar_hash` text NOT NULL,
	`generator_revision` text NOT NULL,
	`r2_key` text NOT NULL,
	`maximum_bytes` integer NOT NULL,
	`state` text NOT NULL,
	`multipart_id` text,
	`writes_sealed` integer DEFAULT false NOT NULL,
	`digest` text,
	`size` integer,
	`created_at` text NOT NULL,
	`write_until` text NOT NULL,
	`cleanup_after` text NOT NULL,
	`next_cleanup_at` text NOT NULL,
	`cleanup_generation` integer DEFAULT 0 NOT NULL,
	`cleanup_owner` text,
	`cleanup_lease_expires_at` text,
	CONSTRAINT "forward_listing_stage_state_check" CHECK("forward_listing_stage"."state" IN ('pending','ready','retired')),
	CONSTRAINT "forward_listing_stage_key_check" CHECK("forward_listing_stage"."r2_key" = 'shared-artifact-staging/' || "forward_listing_stage"."id"),
	CONSTRAINT "forward_listing_stage_budget_check" CHECK(typeof("forward_listing_stage"."maximum_bytes") = 'integer' AND "forward_listing_stage"."maximum_bytes" BETWEEN 1 AND 67108864 AND ("forward_listing_stage"."size" IS NULL OR (typeof("forward_listing_stage"."size") = 'integer' AND "forward_listing_stage"."size" BETWEEN 0 AND "forward_listing_stage"."maximum_bytes"))),
	CONSTRAINT "forward_listing_stage_seal_check" CHECK(("forward_listing_stage"."writes_sealed" = 0 AND "forward_listing_stage"."digest" IS NULL AND "forward_listing_stage"."size" IS NULL) OR ("forward_listing_stage"."writes_sealed" = 1 AND "forward_listing_stage"."multipart_id" IS NOT NULL AND "forward_listing_stage"."digest" IS NOT NULL AND "forward_listing_stage"."size" IS NOT NULL)),
	CONSTRAINT "forward_listing_stage_ready_check" CHECK("forward_listing_stage"."state" <> 'ready' OR "forward_listing_stage"."writes_sealed" = 1),
	CONSTRAINT "forward_listing_stage_cleanup_generation_check" CHECK(typeof("forward_listing_stage"."cleanup_generation") = 'integer' AND "forward_listing_stage"."cleanup_generation" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "forward_listing_stage_cleanup_claim_check" CHECK(("forward_listing_stage"."cleanup_generation" = 0 AND "forward_listing_stage"."cleanup_owner" IS NULL AND "forward_listing_stage"."cleanup_lease_expires_at" IS NULL) OR ("forward_listing_stage"."cleanup_generation" > 0 AND "forward_listing_stage"."cleanup_owner" IS NOT NULL AND "forward_listing_stage"."state" = 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forward_listing_stage_native_owner_idx` ON `forward_listing_stage` (`tenant`,`upload_id`,`owner`,`generator_revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `forward_listing_stage_active_input_idx` ON `forward_listing_stage` (`nar_hash`,`generator_revision`) WHERE "forward_listing_stage"."state" <> 'retired';--> statement-breakpoint
CREATE INDEX `forward_listing_stage_cleanup_idx` ON `forward_listing_stage` (`next_cleanup_at`,`id`);

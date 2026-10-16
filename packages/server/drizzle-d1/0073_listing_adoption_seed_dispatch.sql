CREATE TABLE `listing_adoption_seed_dispatch` (
	`scope` text PRIMARY KEY NOT NULL,
	`epoch` text DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`available_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`owner` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "listing_adoption_seed_dispatch_scope_check" CHECK("listing_adoption_seed_dispatch"."scope" IN ('facts','default-parents','named-parents')),
	CONSTRAINT "listing_adoption_seed_dispatch_epoch_check" CHECK(length("listing_adoption_seed_dispatch"."epoch") = 32 AND "listing_adoption_seed_dispatch"."epoch" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "listing_adoption_seed_dispatch_claim_check" CHECK(typeof("listing_adoption_seed_dispatch"."generation") = 'integer' AND "listing_adoption_seed_dispatch"."generation" BETWEEN 0 AND 9007199254740991
 AND ("listing_adoption_seed_dispatch"."owner" IS NULL) = ("listing_adoption_seed_dispatch"."lease_expires_at" IS NULL)
 AND ("listing_adoption_seed_dispatch"."owner" IS NULL OR "listing_adoption_seed_dispatch"."generation" >= 1))
);

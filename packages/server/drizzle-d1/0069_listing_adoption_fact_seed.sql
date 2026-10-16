CREATE TABLE `listing_adoption_fact_seed` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` text DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`after_nar_hash` text,
	`after_generator_revision` text,
	`through_nar_hash` text,
	`through_generator_revision` text,
	`scanned` integer DEFAULT 0 NOT NULL,
	`captured` integer DEFAULT 0 NOT NULL,
	`is_complete` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "listing_adoption_fact_seed_id_check" CHECK("listing_adoption_fact_seed"."id" = 1),
	CONSTRAINT "listing_adoption_fact_seed_epoch_check" CHECK(length("listing_adoption_fact_seed"."epoch") = 32 AND "listing_adoption_fact_seed"."epoch" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "listing_adoption_fact_seed_cursor_check" CHECK("listing_adoption_fact_seed"."is_complete" IN (0,1) AND ("listing_adoption_fact_seed"."after_nar_hash" IS NULL) = ("listing_adoption_fact_seed"."after_generator_revision" IS NULL)
 AND ("listing_adoption_fact_seed"."through_nar_hash" IS NULL) = ("listing_adoption_fact_seed"."through_generator_revision" IS NULL)
 AND ("listing_adoption_fact_seed"."through_nar_hash" IS NOT NULL OR "listing_adoption_fact_seed"."is_complete" = 1)
 AND ("listing_adoption_fact_seed"."after_nar_hash" IS NULL OR ("listing_adoption_fact_seed"."through_nar_hash" IS NOT NULL AND ("listing_adoption_fact_seed"."after_nar_hash","listing_adoption_fact_seed"."after_generator_revision") <= ("listing_adoption_fact_seed"."through_nar_hash","listing_adoption_fact_seed"."through_generator_revision")))
 AND ("listing_adoption_fact_seed"."is_complete" = 0 OR "listing_adoption_fact_seed"."through_nar_hash" IS NULL OR ("listing_adoption_fact_seed"."after_nar_hash" IS NOT NULL AND ("listing_adoption_fact_seed"."after_nar_hash","listing_adoption_fact_seed"."after_generator_revision") = ("listing_adoption_fact_seed"."through_nar_hash","listing_adoption_fact_seed"."through_generator_revision")))),
	CONSTRAINT "listing_adoption_fact_seed_counts_check" CHECK(typeof("listing_adoption_fact_seed"."scanned") = 'integer' AND "listing_adoption_fact_seed"."scanned" BETWEEN 0 AND 9007199254740991
 AND typeof("listing_adoption_fact_seed"."captured") = 'integer' AND "listing_adoption_fact_seed"."captured" BETWEEN 0 AND "listing_adoption_fact_seed"."scanned")
);

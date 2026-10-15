CREATE TABLE `listing_adoption_parent_seed` (
	`cache_kind` text PRIMARY KEY NOT NULL,
	`epoch` text DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`after_tenant` text,
	`after_cache_name` text,
	`after_store_path_hash` text,
	`through_tenant` text,
	`through_cache_name` text,
	`through_store_path_hash` text,
	`page_capture_after` integer,
	`scanned` integer DEFAULT 0 NOT NULL,
	`captured` integer DEFAULT 0 NOT NULL,
	`is_complete` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "listing_adoption_parent_seed_kind_check" CHECK("listing_adoption_parent_seed"."cache_kind" IN ('default','named')),
	CONSTRAINT "listing_adoption_parent_seed_epoch_check" CHECK(length("listing_adoption_parent_seed"."epoch") = 32 AND "listing_adoption_parent_seed"."epoch" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "listing_adoption_parent_seed_cursor_check" CHECK("listing_adoption_parent_seed"."is_complete" IN (0,1)
 AND ("listing_adoption_parent_seed"."after_tenant" IS NULL) = ("listing_adoption_parent_seed"."after_store_path_hash" IS NULL)
 AND ("listing_adoption_parent_seed"."through_tenant" IS NULL) = ("listing_adoption_parent_seed"."through_store_path_hash" IS NULL)
 AND ("listing_adoption_parent_seed"."through_tenant" IS NOT NULL OR ("listing_adoption_parent_seed"."is_complete" = 1 AND "listing_adoption_parent_seed"."after_tenant" IS NULL))
 AND ("listing_adoption_parent_seed"."after_tenant" IS NULL OR "listing_adoption_parent_seed"."through_tenant" IS NOT NULL)
 AND (("listing_adoption_parent_seed"."cache_kind" = 'default' AND "listing_adoption_parent_seed"."after_cache_name" IS NULL AND "listing_adoption_parent_seed"."through_cache_name" IS NULL
   AND ("listing_adoption_parent_seed"."after_tenant" IS NULL OR ("listing_adoption_parent_seed"."after_tenant","listing_adoption_parent_seed"."after_store_path_hash") <= ("listing_adoption_parent_seed"."through_tenant","listing_adoption_parent_seed"."through_store_path_hash"))
   AND ("listing_adoption_parent_seed"."is_complete" = 0 OR "listing_adoption_parent_seed"."through_tenant" IS NULL OR ("listing_adoption_parent_seed"."after_tenant" IS NOT NULL AND ("listing_adoption_parent_seed"."after_tenant","listing_adoption_parent_seed"."after_store_path_hash") = ("listing_adoption_parent_seed"."through_tenant","listing_adoption_parent_seed"."through_store_path_hash"))))
 OR ("listing_adoption_parent_seed"."cache_kind" = 'named'
   AND ("listing_adoption_parent_seed"."after_tenant" IS NULL) = ("listing_adoption_parent_seed"."after_cache_name" IS NULL)
   AND ("listing_adoption_parent_seed"."through_tenant" IS NULL) = ("listing_adoption_parent_seed"."through_cache_name" IS NULL)
   AND ("listing_adoption_parent_seed"."after_tenant" IS NULL OR ("listing_adoption_parent_seed"."after_tenant","listing_adoption_parent_seed"."after_cache_name","listing_adoption_parent_seed"."after_store_path_hash") <= ("listing_adoption_parent_seed"."through_tenant","listing_adoption_parent_seed"."through_cache_name","listing_adoption_parent_seed"."through_store_path_hash"))
   AND ("listing_adoption_parent_seed"."is_complete" = 0 OR "listing_adoption_parent_seed"."through_tenant" IS NULL OR ("listing_adoption_parent_seed"."after_tenant" IS NOT NULL AND ("listing_adoption_parent_seed"."after_tenant","listing_adoption_parent_seed"."after_cache_name","listing_adoption_parent_seed"."after_store_path_hash") = ("listing_adoption_parent_seed"."through_tenant","listing_adoption_parent_seed"."through_cache_name","listing_adoption_parent_seed"."through_store_path_hash")))))),
	CONSTRAINT "listing_adoption_parent_seed_counts_check" CHECK(typeof("listing_adoption_parent_seed"."scanned") = 'integer' AND "listing_adoption_parent_seed"."scanned" BETWEEN 0 AND 9007199254740991
 AND typeof("listing_adoption_parent_seed"."captured") = 'integer' AND "listing_adoption_parent_seed"."captured" BETWEEN 0 AND "listing_adoption_parent_seed"."scanned"
 AND ("listing_adoption_parent_seed"."page_capture_after" IS NULL OR (typeof("listing_adoption_parent_seed"."page_capture_after") = 'integer' AND "listing_adoption_parent_seed"."page_capture_after" BETWEEN 0 AND 9007199254740991 AND "listing_adoption_parent_seed"."is_complete" = 0)))
);

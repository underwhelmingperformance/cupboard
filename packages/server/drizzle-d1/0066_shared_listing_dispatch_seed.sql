CREATE TABLE `shared_listing_dispatch_seed` (
	`id` integer PRIMARY KEY NOT NULL,
	`after` text,
	`through` text,
	`is_complete` integer DEFAULT false NOT NULL,
	CONSTRAINT "shared_listing_dispatch_seed_id_check" CHECK("shared_listing_dispatch_seed"."id" = 1),
	CONSTRAINT "shared_listing_dispatch_seed_cursor_check" CHECK("shared_listing_dispatch_seed"."is_complete" IN (0,1) AND ("shared_listing_dispatch_seed"."after" IS NULL OR ("shared_listing_dispatch_seed"."through" IS NOT NULL AND "shared_listing_dispatch_seed"."after" <= "shared_listing_dispatch_seed"."through")) AND ("shared_listing_dispatch_seed"."through" IS NOT NULL OR "shared_listing_dispatch_seed"."is_complete" = 1))
);

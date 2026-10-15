CREATE TABLE `listing_adoption_consumer` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` text DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`after` integer DEFAULT 0 NOT NULL,
	`scanned` integer DEFAULT 0 NOT NULL,
	`enrolled` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "listing_adoption_consumer_id_check" CHECK("listing_adoption_consumer"."id" = 1),
	CONSTRAINT "listing_adoption_consumer_epoch_check" CHECK(length("listing_adoption_consumer"."epoch") = 32 AND "listing_adoption_consumer"."epoch" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "listing_adoption_consumer_progress_check" CHECK(typeof("listing_adoption_consumer"."after") = 'integer' AND "listing_adoption_consumer"."after" BETWEEN 0 AND 9007199254740991 AND typeof("listing_adoption_consumer"."scanned") = 'integer' AND "listing_adoption_consumer"."scanned" BETWEEN 0 AND 9007199254740991 AND typeof("listing_adoption_consumer"."enrolled") = 'integer' AND "listing_adoption_consumer"."enrolled" BETWEEN 0 AND "listing_adoption_consumer"."scanned")
);
--> statement-breakpoint
CREATE TABLE `listing_adoption_work` (
	`id` text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`consumer_epoch` text NOT NULL,
	`event_id` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "listing_adoption_work_id_check" CHECK(length("listing_adoption_work"."id") = 32 AND "listing_adoption_work"."id" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "listing_adoption_work_epoch_check" CHECK(length("listing_adoption_work"."consumer_epoch") = 32 AND "listing_adoption_work"."consumer_epoch" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "listing_adoption_work_event_check" CHECK(typeof("listing_adoption_work"."event_id") = 'integer' AND "listing_adoption_work"."event_id" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "listing_adoption_work_source_check" CHECK(coalesce(json_valid("listing_adoption_work"."source") AND json_type("listing_adoption_work"."source") = 'object' AND json_extract("listing_adoption_work"."source", '$.kind') IN ('parent','listing','cas'), 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_adoption_work_consumer_event_idx` ON `listing_adoption_work` (`consumer_epoch`,`event_id`);

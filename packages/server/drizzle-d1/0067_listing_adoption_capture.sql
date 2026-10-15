CREATE TABLE `listing_adoption_capture_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "listing_adoption_capture_event_id_check" CHECK("listing_adoption_capture_event"."id" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "listing_adoption_capture_event_source_check" CHECK(coalesce(json_valid("listing_adoption_capture_event"."source") AND json_type("listing_adoption_capture_event"."source") = 'object' AND json_extract("listing_adoption_capture_event"."source", '$.kind') IN ('parent','listing','cas'), 0))
);
--> statement-breakpoint
CREATE TABLE `listing_adoption_capture_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`latest` integer DEFAULT 0 NOT NULL,
	`pruned_through` integer DEFAULT 0 NOT NULL,
	`is_ready` integer DEFAULT false NOT NULL,
	CONSTRAINT "listing_adoption_capture_state_id_check" CHECK("listing_adoption_capture_state"."id" = 1),
	CONSTRAINT "listing_adoption_capture_state_position_check" CHECK("listing_adoption_capture_state"."pruned_through" BETWEEN 0 AND "listing_adoption_capture_state"."latest" AND "listing_adoption_capture_state"."latest" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `listing_adoption_fact` (
	`nar_hash` text NOT NULL,
	`generator_revision` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`nar_hash`, `generator_revision`)
);
--> statement-breakpoint
CREATE INDEX `listing_adoption_fact_digest_identity_idx` ON `listing_adoption_fact` (`digest`,`nar_hash`,`generator_revision`);
--> statement-breakpoint
INSERT INTO listing_adoption_capture_state (id) VALUES (1);

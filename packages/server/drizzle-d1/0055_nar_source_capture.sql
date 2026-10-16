CREATE TABLE `nar_capture_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nar_hash` text NOT NULL,
	`source_incarnation` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "nar_capture_event_position_check" CHECK("nar_capture_event"."id" BETWEEN 1 AND 9007199254740991 AND "nar_capture_event"."source_incarnation" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `nar_capture_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`latest` integer DEFAULT 0 NOT NULL,
	`pruned_through` integer DEFAULT 0 NOT NULL,
	`is_ready` integer DEFAULT false NOT NULL,
	CONSTRAINT "nar_capture_state_identity_check" CHECK("nar_capture_state"."id" = 1),
	CONSTRAINT "nar_capture_state_position_check" CHECK("nar_capture_state"."pruned_through" BETWEEN 0 AND "nar_capture_state"."latest" AND "nar_capture_state"."latest" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE `shared_listing_job` ADD `event_cursor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `shared_listing_job_capture_idx` ON `shared_listing_job` (`phase`,`event_cursor`);
--> statement-breakpoint
INSERT INTO nar_capture_state (id) VALUES (1);

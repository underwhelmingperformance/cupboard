CREATE TABLE `object_deletion` (
	`kind` text NOT NULL,
	`object_id` text NOT NULL,
	`incarnation` integer NOT NULL,
	`remove_after` text NOT NULL,
	PRIMARY KEY(`kind`, `object_id`, `incarnation`)
);
--> statement-breakpoint
CREATE INDEX `object_deletion_due_idx` ON `object_deletion` (`kind`,`remove_after`,`object_id`,`incarnation`);--> statement-breakpoint
CREATE TABLE `object_incarnation` (
	`kind` text NOT NULL,
	`object_id` text NOT NULL,
	`incarnation` integer NOT NULL,
	`state` text NOT NULL,
	`reservation_owner` text,
	`updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	PRIMARY KEY(`kind`, `object_id`)
);
--> statement-breakpoint
CREATE INDEX `object_incarnation_recovery_idx` ON `object_incarnation` (`kind`,`state`,`updated_at`,`object_id`);--> statement-breakpoint
ALTER TABLE `blob_state` ADD `incarnation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `cas_object` ADD `incarnation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
INSERT INTO `object_incarnation` (`kind`, `object_id`, `incarnation`, `state`)
SELECT 'nar', `nar_hash`, `incarnation`, 'live' FROM `blob_state`;--> statement-breakpoint
INSERT INTO `object_incarnation` (`kind`, `object_id`, `incarnation`, `state`)
SELECT 'cas', `digest`, `incarnation`, 'live' FROM `cas_object`;

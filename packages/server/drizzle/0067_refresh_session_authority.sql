CREATE TABLE `refresh_session_family` (
	`id` text PRIMARY KEY NOT NULL,
	`active_member_id` text NOT NULL,
	`generation` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `refresh_session_family_expires_at_idx` ON `refresh_session_family` (`expires_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_session_family_active_member_unique` ON `refresh_session_family` (`active_member_id`);--> statement-breakpoint
CREATE TABLE `refresh_session_member` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`generation` integer NOT NULL,
	`credential_hash` text NOT NULL,
	`successor_envelope` text,
	`successor_expires_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `refresh_session_member_family_idx` ON `refresh_session_member` (`family_id`);--> statement-breakpoint
CREATE INDEX `refresh_session_member_successor_expiry_idx` ON `refresh_session_member` (`successor_expires_at`,`id`) WHERE "refresh_session_member"."successor_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_session_member_family_generation_unique` ON `refresh_session_member` (`family_id`,`generation`);

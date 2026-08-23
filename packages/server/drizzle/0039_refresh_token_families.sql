CREATE TABLE `refresh_token_family` (
	`id` text PRIMARY KEY NOT NULL,
	`active_member_id` text NOT NULL,
	`generation` integer NOT NULL,
	`rule_id` text NOT NULL,
	`subject` text NOT NULL,
	`grants_json` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `refresh_token_family_rule_idx` ON `refresh_token_family` (`rule_id`,`id`);--> statement-breakpoint
CREATE INDEX `refresh_token_family_expires_at_idx` ON `refresh_token_family` (`expires_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_token_family_active_member_unique` ON `refresh_token_family` (`active_member_id`);--> statement-breakpoint
CREATE TABLE `refresh_token_member` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`generation` integer NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `refresh_token_member_family_idx` ON `refresh_token_member` (`family_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_token_member_family_generation_unique` ON `refresh_token_member` (`family_id`,`generation`);--> statement-breakpoint
DELETE FROM `refresh_token`;

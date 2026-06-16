CREATE TABLE `oidc_trust` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`audience` text NOT NULL,
	`claims_json` text DEFAULT '{}' NOT NULL,
	`permitted_grants_json` text DEFAULT '[]' NOT NULL,
	`display_json` text,
	`created_at` text NOT NULL,
	`disabled_at` text
);
--> statement-breakpoint
ALTER TABLE `auth_key` ADD `kid` text DEFAULT '' NOT NULL;

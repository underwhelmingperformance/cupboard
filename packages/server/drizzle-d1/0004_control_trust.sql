CREATE TABLE `control_trust` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`audience` text NOT NULL,
	`claims_json` text DEFAULT '{}' NOT NULL,
	`permitted_grants_json` text DEFAULT '[{"type":"cupboard_wildcard"}]' NOT NULL,
	`display_json` text,
	`created_at` text NOT NULL,
	`disabled_at` text
);

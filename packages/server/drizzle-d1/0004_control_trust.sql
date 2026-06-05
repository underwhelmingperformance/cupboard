CREATE TABLE `control_trust` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`audience` text NOT NULL,
	`claims_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);

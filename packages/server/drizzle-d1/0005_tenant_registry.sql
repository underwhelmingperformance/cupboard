CREATE TABLE `global_admin` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`claimed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tenant` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`read_mode` text NOT NULL,
	`owner_issuer` text NOT NULL,
	`owner_subject` text NOT NULL,
	`owner_audience` text NOT NULL,
	`config_version` integer NOT NULL,
	`created_at` text NOT NULL
);

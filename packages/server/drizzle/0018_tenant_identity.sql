CREATE TABLE `tenant_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`issuer` text NOT NULL,
	`audience` text NOT NULL,
	`owner_issuer` text NOT NULL,
	`owner_subject` text NOT NULL,
	`owner_audience` text NOT NULL,
	`config_version` integer NOT NULL
);

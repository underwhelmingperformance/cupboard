CREATE TABLE `refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`rule_id` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);

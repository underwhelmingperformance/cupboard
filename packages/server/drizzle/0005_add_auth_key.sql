CREATE TABLE `auth_key` (
	`id` text PRIMARY KEY NOT NULL,
	`private_jwk_json` text NOT NULL,
	`public_jwk_json` text NOT NULL,
	`created_at` text NOT NULL,
	`retired_at` text
);

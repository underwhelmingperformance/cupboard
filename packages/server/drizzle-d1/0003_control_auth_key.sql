CREATE TABLE `control_auth_key` (
	`id` text PRIMARY KEY NOT NULL,
	`kid` text NOT NULL,
	`public_jwk_json` text NOT NULL,
	`wrapped_private_jwk` text NOT NULL,
	`created_at` text NOT NULL,
	`retired_at` text
);

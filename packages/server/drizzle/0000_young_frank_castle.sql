CREATE TABLE `narinfo` (
	`store_path_hash` text PRIMARY KEY NOT NULL,
	`store_path` text NOT NULL,
	`nar_hash` text NOT NULL,
	`nar_size` integer NOT NULL,
	`file_hash` text NOT NULL,
	`file_size` integer NOT NULL,
	`compression` text NOT NULL,
	`references_json` text NOT NULL,
	`deriver` text,
	`ca` text,
	`sig` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pending_upload` (
	`id` text PRIMARY KEY NOT NULL,
	`nar_hash` text NOT NULL,
	`r2_key` text NOT NULL,
	`expected_size` integer NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signing_key` (
	`id` text PRIMARY KEY NOT NULL,
	`private_jwk_json` text NOT NULL,
	`public_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `token` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL
);

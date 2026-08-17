CREATE TABLE `s3_credential` (
	`access_key_id` text PRIMARY KEY NOT NULL,
	`credential_id` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`cache` text DEFAULT '' NOT NULL,
	`grants_json` text DEFAULT '[]' NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text
);

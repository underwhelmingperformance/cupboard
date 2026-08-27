CREATE TABLE `tenant_cache_read_credential` (
	`tenant` text NOT NULL,
	`cache` text NOT NULL,
	`read_user` text NOT NULL,
	`read_password_hash` text NOT NULL,
	`read_password_salt` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `cache`)
);

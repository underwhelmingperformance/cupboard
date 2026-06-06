CREATE TABLE `tenant_maintenance_failure` (
	`tenant` text NOT NULL,
	`pass` text NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_failed_at` text,
	`last_success_at` text,
	PRIMARY KEY(`tenant`, `pass`)
);

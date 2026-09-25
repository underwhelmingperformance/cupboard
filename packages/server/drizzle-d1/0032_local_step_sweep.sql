CREATE TABLE `local_step_sweep` (
	`id` integer PRIMARY KEY NOT NULL,
	`chain` text NOT NULL,
	`link` integer NOT NULL,
	`state` text NOT NULL,
	`expires_at` text NOT NULL,
	`next_at` text,
	`updated_at` text NOT NULL,
	`last_outcomes` text NOT NULL
);

CREATE TABLE `deployment_phase` (
	`id` text PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`required_local_step` integer NOT NULL,
	`updated_at` text NOT NULL
);

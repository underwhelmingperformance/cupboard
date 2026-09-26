CREATE TABLE `local_step_sweep` (
	`id` integer PRIMARY KEY NOT NULL,
	`chain` text NOT NULL,
	`link` integer NOT NULL,
	`sent` integer NOT NULL,
	`batch_message` text,
	`batch_attempts` integer,
	`woken_without_work` integer NOT NULL,
	`stalled_at` text,
	`failing_tenants` text NOT NULL,
	`delay_seconds` integer NOT NULL,
	`expires_at` text NOT NULL,
	`next_at` text,
	`updated_at` text NOT NULL,
	`batch_at` text NOT NULL,
	`last_outcomes` text NOT NULL,
	CONSTRAINT "local_step_sweep_single_row" CHECK("local_step_sweep"."id" = 1),
	CONSTRAINT "local_step_sweep_batch_claim" CHECK(("local_step_sweep"."batch_message" IS NULL) = ("local_step_sweep"."batch_attempts" IS NULL))
);

ALTER TABLE `tenant` ADD `local_step` integer;
--> statement-breakpoint
CREATE TABLE `local_step_wake_cursor` (
 `id` integer PRIMARY KEY NOT NULL,
 `after_tenant` text NOT NULL
);

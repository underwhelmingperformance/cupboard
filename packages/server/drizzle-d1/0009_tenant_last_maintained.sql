ALTER TABLE `tenant` ADD `last_maintained_at` text;--> statement-breakpoint
CREATE INDEX `tenant_maintenance_idx` ON `tenant` (`status`,`last_maintained_at`);

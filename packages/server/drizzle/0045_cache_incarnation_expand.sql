ALTER TABLE `cache_identity` ADD `generation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `read_revision` integer DEFAULT 1 NOT NULL;

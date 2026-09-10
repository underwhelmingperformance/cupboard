CREATE TABLE `root_retention_rule_set` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `root_retention_rule_set_content_hash_idx` ON `root_retention_rule_set` (`content_hash`);--> statement-breakpoint
CREATE TABLE `root_retention_rule` (
	`rule_set_id` integer NOT NULL,
	`root_prefix` text NOT NULL,
	`kind` text NOT NULL,
	`ttl_seconds` integer,
	PRIMARY KEY(`rule_set_id`, `root_prefix`),
	CONSTRAINT "root_retention_rule_prefix_check" CHECK(length("root_retention_rule"."root_prefix") BETWEEN 1 AND 256 AND instr("root_retention_rule"."root_prefix", char(0)) = 0 AND "root_retention_rule"."root_prefix" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
	CONSTRAINT "root_retention_rule_value_check" CHECK(("root_retention_rule"."kind" = 'permanent' AND "root_retention_rule"."ttl_seconds" IS NULL) OR ("root_retention_rule"."kind" = 'duration' AND "root_retention_rule"."ttl_seconds" BETWEEN 1 AND 315360000))
);
--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `root_retention_rule_set_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `default_root_ttl_seconds` integer;--> statement-breakpoint
ALTER TABLE `cache_identity` ADD `grace_seconds` integer;

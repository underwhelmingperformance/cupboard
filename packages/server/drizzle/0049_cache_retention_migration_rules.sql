CREATE TABLE `retention_migration_rule` (
	`source_id` text PRIMARY KEY NOT NULL,
	`root_prefix` text NOT NULL,
	`ttl_seconds` integer NOT NULL,
	CONSTRAINT "retention_migration_rule_prefix_check" CHECK(length("retention_migration_rule"."root_prefix") BETWEEN 1 AND 256 AND instr("retention_migration_rule"."root_prefix", char(0)) = 0 AND "retention_migration_rule"."root_prefix" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
	CONSTRAINT "retention_migration_rule_ttl_check" CHECK("retention_migration_rule"."ttl_seconds" BETWEEN 1 AND 315360000)
);
--> statement-breakpoint
ALTER TABLE `retention_migration_state` ADD `rule_cursor` text;
--> statement-breakpoint
ALTER TABLE `pending_upload` ADD `writer_epoch` text DEFAULT 'legacy-cache-identity' NOT NULL;
--> statement-breakpoint
ALTER TABLE `pending_attestation` ADD `writer_epoch` text DEFAULT 'legacy-cache-identity' NOT NULL;
--> statement-breakpoint
ALTER TABLE `narinfo_deletion` ADD `writer_epoch` text DEFAULT 'legacy-cache-identity' NOT NULL;
--> statement-breakpoint
ALTER TABLE `cache_purge_continuation` ADD `writer_epoch` text DEFAULT 'legacy-cache-identity' NOT NULL;
--> statement-breakpoint
ALTER TABLE `garbage_collection_scan` ADD `writer_epoch` text DEFAULT 'legacy-cache-identity' NOT NULL;

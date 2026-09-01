CREATE TABLE `retention_migration_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`cache_cursor` integer DEFAULT 0 NOT NULL,
	`rule_set_id` integer,
	`discarded_rule_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "retention_migration_singleton_check" CHECK("retention_migration_state"."id" = 1),
	CONSTRAINT "retention_migration_cache_cursor_nonnegative" CHECK("retention_migration_state"."cache_cursor" >= 0),
	CONSTRAINT "retention_migration_discarded_nonnegative" CHECK("retention_migration_state"."discarded_rule_count" >= 0)
);

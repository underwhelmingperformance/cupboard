CREATE TABLE `cache_identity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`access` text,
	`priority` integer NOT NULL,
	`grace_managed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "cache_identity_shape_check" CHECK(("cache_identity"."kind" = 'default' AND "cache_identity"."name" IS NULL) OR ("cache_identity"."kind" = 'named' AND "cache_identity"."name" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cache_identity_default_idx` ON `cache_identity` (`kind`) WHERE "cache_identity"."kind" = 'default' AND "cache_identity"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `cache_identity_name_idx` ON `cache_identity` (`name`) WHERE "cache_identity"."kind" = 'named' AND "cache_identity"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `reuse_view_selector_native` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`view` text NOT NULL,
	`kind` text NOT NULL,
	`cache_name` text,
	`prefix` text,
	CONSTRAINT "reuse_view_selector_native_shape_check" CHECK(("reuse_view_selector_native"."kind" IN ('default', 'all-named', 'all') AND "reuse_view_selector_native"."cache_name" IS NULL AND "reuse_view_selector_native"."prefix" IS NULL) OR ("reuse_view_selector_native"."kind" = 'named' AND "reuse_view_selector_native"."cache_name" IS NOT NULL AND "reuse_view_selector_native"."prefix" IS NULL) OR ("reuse_view_selector_native"."kind" = 'prefix' AND "reuse_view_selector_native"."cache_name" IS NULL AND "reuse_view_selector_native"."prefix" IS NOT NULL AND length("reuse_view_selector_native"."prefix") > 0))
);
--> statement-breakpoint
ALTER TABLE `garbage_collection_frontier` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `garbage_collection_mark` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `garbage_collection_revision` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `garbage_collection_scan` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `garbage_collection_tenant_run` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `generation_seq` ADD `cache_kind` text;--> statement-breakpoint
ALTER TABLE `generation_seq` ADD `cache_name` text;--> statement-breakpoint
ALTER TABLE `narinfo_deletion` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `narinfo` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `pending_attestation` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `pending_upload` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `retention_grace` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `retention_policy` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `retention_policy` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `retention_policy` ADD `root_name_prefix` text;--> statement-breakpoint
ALTER TABLE `retention_root_target` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `retention_root` ADD `cache_id` integer;--> statement-breakpoint
ALTER TABLE `reuse_view` ADD `access` text;--> statement-breakpoint
ALTER TABLE `verification_cursor` ADD `cache_id` integer;

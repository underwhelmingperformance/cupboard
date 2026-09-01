PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reuse_view_selector_native` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`view` text NOT NULL,
	`kind` text NOT NULL,
	`cache_name` text,
	`prefix` text,
	`managed_group_id` text,
	CONSTRAINT "reuse_view_selector_view_check" CHECK(length("__new_reuse_view_selector_native"."view") BETWEEN 1 AND 63 AND substr("__new_reuse_view_selector_native"."view", 1, 1) GLOB '[a-z0-9]' AND "__new_reuse_view_selector_native"."view" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "reuse_view_selector_identity_check" CHECK(("__new_reuse_view_selector_native"."kind" IN ('default', 'all-named', 'all') AND "__new_reuse_view_selector_native"."cache_name" IS NULL AND "__new_reuse_view_selector_native"."prefix" IS NULL AND "__new_reuse_view_selector_native"."managed_group_id" IS NULL) OR ("__new_reuse_view_selector_native"."kind" = 'named' AND "__new_reuse_view_selector_native"."cache_name" IS NOT NULL AND length("__new_reuse_view_selector_native"."cache_name") BETWEEN 1 AND 63 AND substr("__new_reuse_view_selector_native"."cache_name", 1, 1) GLOB '[a-z0-9]' AND "__new_reuse_view_selector_native"."cache_name" NOT GLOB '*[^a-z0-9._-]*' AND "__new_reuse_view_selector_native"."prefix" IS NULL AND "__new_reuse_view_selector_native"."managed_group_id" IS NULL) OR ("__new_reuse_view_selector_native"."kind" = 'prefix' AND "__new_reuse_view_selector_native"."cache_name" IS NULL AND "__new_reuse_view_selector_native"."prefix" IS NOT NULL AND length("__new_reuse_view_selector_native"."prefix") BETWEEN 1 AND 63 AND substr("__new_reuse_view_selector_native"."prefix", 1, 1) GLOB '[a-z0-9]' AND "__new_reuse_view_selector_native"."prefix" NOT GLOB '*[^a-z0-9._-]*' AND "__new_reuse_view_selector_native"."managed_group_id" IS NULL) OR ("__new_reuse_view_selector_native"."kind" = 'managed-group' AND "__new_reuse_view_selector_native"."cache_name" IS NULL AND "__new_reuse_view_selector_native"."prefix" IS NULL AND "__new_reuse_view_selector_native"."managed_group_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_reuse_view_selector_native`("id", "view", "kind", "cache_name", "prefix", "managed_group_id") SELECT "id", "view", "kind", "cache_name", "prefix", "managed_group_id" FROM `reuse_view_selector_native`;--> statement-breakpoint
DROP TABLE `reuse_view_selector_native`;--> statement-breakpoint
ALTER TABLE `__new_reuse_view_selector_native` RENAME TO `reuse_view_selector_native`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `reuse_view_selector_singleton_idx` ON `reuse_view_selector_native` (`view`,`kind`) WHERE "reuse_view_selector_native"."kind" IN ('default', 'all-named', 'all');--> statement-breakpoint
CREATE UNIQUE INDEX `reuse_view_selector_named_idx` ON `reuse_view_selector_native` (`view`,`cache_name`) WHERE "reuse_view_selector_native"."kind" = 'named';--> statement-breakpoint
CREATE UNIQUE INDEX `reuse_view_selector_prefix_idx` ON `reuse_view_selector_native` (`view`,`prefix`) WHERE "reuse_view_selector_native"."kind" = 'prefix';--> statement-breakpoint
CREATE UNIQUE INDEX `reuse_view_selector_managed_group_idx` ON `reuse_view_selector_native` (`view`,`managed_group_id`) WHERE "reuse_view_selector_native"."kind" = 'managed-group';

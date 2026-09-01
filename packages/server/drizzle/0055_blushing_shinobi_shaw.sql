PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cache_identity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`access` text NOT NULL,
	`priority` integer NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`read_revision` integer DEFAULT 1 NOT NULL,
	`lifecycle_state` text DEFAULT 'active' NOT NULL,
	`creation_expires_at` text,
	`management_kind` text DEFAULT 'durable' NOT NULL,
	`managed_policy_id` text,
	`managed_policy_revision` integer,
	`managed_group_id` text,
	`lease_expires_at` text,
	`selection_state` text,
	`update_hold` integer DEFAULT false NOT NULL,
	`root_retention_rule_set_id` integer DEFAULT 1 NOT NULL,
	`default_root_ttl_seconds` integer,
	`grace_seconds` integer,
	`grace_managed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "cache_identity_check" CHECK(("__new_cache_identity"."kind" = 'default' AND "__new_cache_identity"."name" IS NULL) OR ("__new_cache_identity"."kind" = 'named' AND "__new_cache_identity"."name" IS NOT NULL AND length("__new_cache_identity"."name") BETWEEN 1 AND 63 AND substr("__new_cache_identity"."name", 1, 1) GLOB '[a-z0-9]' AND "__new_cache_identity"."name" NOT GLOB '*[^a-z0-9._-]*')),
	CONSTRAINT "cache_identity_access_check" CHECK("__new_cache_identity"."access" IN ('public', 'private')),
	CONSTRAINT "cache_identity_creation_shape_check" CHECK(("__new_cache_identity"."lifecycle_state" = 'creating' AND "__new_cache_identity"."creation_expires_at" IS NOT NULL) OR ("__new_cache_identity"."lifecycle_state" <> 'creating' AND "__new_cache_identity"."creation_expires_at" IS NULL)),
	CONSTRAINT "cache_identity_management_shape_check" CHECK(("__new_cache_identity"."management_kind" = 'durable' AND "__new_cache_identity"."managed_policy_id" IS NULL AND "__new_cache_identity"."managed_policy_revision" IS NULL AND "__new_cache_identity"."managed_group_id" IS NULL AND "__new_cache_identity"."lease_expires_at" IS NULL AND "__new_cache_identity"."selection_state" IS NULL) OR ("__new_cache_identity"."management_kind" = 'managed' AND "__new_cache_identity"."managed_policy_id" IS NOT NULL AND "__new_cache_identity"."managed_policy_revision" IS NOT NULL AND "__new_cache_identity"."managed_group_id" IS NOT NULL AND (("__new_cache_identity"."lifecycle_state" = 'creating' AND "__new_cache_identity"."lease_expires_at" IS NULL AND "__new_cache_identity"."selection_state" = 'detached') OR ("__new_cache_identity"."lifecycle_state" <> 'creating' AND "__new_cache_identity"."lease_expires_at" IS NOT NULL AND "__new_cache_identity"."selection_state" IS NOT NULL))))
);
--> statement-breakpoint
INSERT INTO `__new_cache_identity`("id", "kind", "name", "access", "priority", "generation", "read_revision", "lifecycle_state", "creation_expires_at", "management_kind", "managed_policy_id", "managed_policy_revision", "managed_group_id", "lease_expires_at", "selection_state", "update_hold", "root_retention_rule_set_id", "default_root_ttl_seconds", "grace_seconds", "grace_managed", "created_at", "deleted_at") SELECT "id", "kind", "name", "access", "priority", "generation", "read_revision", "lifecycle_state", "creation_expires_at", "management_kind", "managed_policy_id", "managed_policy_revision", "managed_group_id", "lease_expires_at", "selection_state", "update_hold", "root_retention_rule_set_id", "default_root_ttl_seconds", "grace_seconds", "grace_managed", "created_at", "deleted_at" FROM `cache_identity`;--> statement-breakpoint
DROP TABLE `cache_identity`;--> statement-breakpoint
ALTER TABLE `__new_cache_identity` RENAME TO `cache_identity`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `cache_one_default_idx` ON `cache_identity` (`kind`) WHERE "cache_identity"."kind" = 'default' AND "cache_identity"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `cache_named_name_idx` ON `cache_identity` (`name`) WHERE "cache_identity"."kind" = 'named' AND "cache_identity"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `cache_managed_group_selection_idx` ON `cache_identity` (`managed_group_id`,`access`,`lifecycle_state`,`selection_state`);--> statement-breakpoint
ALTER TABLE `reuse_view_selector_native` ADD `managed_group_id` text;

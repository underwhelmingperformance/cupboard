PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cache_lifecycle` (
	`tenant` text NOT NULL,
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`access` text NOT NULL,
	`generation` integer NOT NULL,
	`read_revision` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`creation_expires_at` text,
	`management_kind` text DEFAULT 'durable' NOT NULL,
	`managed_policy_id` text,
	`managed_policy_revision` integer,
	`managed_group_id` text,
	`lease_expires_at` text,
	`selection_state` text,
	`update_hold` integer DEFAULT false NOT NULL,
	`deleted_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "cache_lifecycle_identity_check" CHECK(("__new_cache_lifecycle"."cache_kind" = 'default' AND "__new_cache_lifecycle"."cache_name" IS NULL) OR ("__new_cache_lifecycle"."cache_kind" = 'named' AND "__new_cache_lifecycle"."cache_name" IS NOT NULL AND length("__new_cache_lifecycle"."cache_name") BETWEEN 1 AND 63 AND substr("__new_cache_lifecycle"."cache_name", 1, 1) GLOB '[a-z0-9]' AND "__new_cache_lifecycle"."cache_name" NOT GLOB '*[^a-z0-9._-]*')),
	CONSTRAINT "cache_lifecycle_access_check" CHECK("__new_cache_lifecycle"."access" IN ('public', 'private')),
	CONSTRAINT "cache_lifecycle_creation_shape_check" CHECK(("__new_cache_lifecycle"."state" = 'creating' AND "__new_cache_lifecycle"."creation_expires_at" IS NOT NULL) OR ("__new_cache_lifecycle"."state" <> 'creating' AND "__new_cache_lifecycle"."creation_expires_at" IS NULL)),
	CONSTRAINT "cache_lifecycle_management_shape_check" CHECK(("__new_cache_lifecycle"."management_kind" = 'durable' AND "__new_cache_lifecycle"."managed_policy_id" IS NULL AND "__new_cache_lifecycle"."managed_policy_revision" IS NULL AND "__new_cache_lifecycle"."managed_group_id" IS NULL AND "__new_cache_lifecycle"."lease_expires_at" IS NULL AND "__new_cache_lifecycle"."selection_state" IS NULL) OR ("__new_cache_lifecycle"."management_kind" = 'managed' AND "__new_cache_lifecycle"."managed_policy_id" IS NOT NULL AND "__new_cache_lifecycle"."managed_policy_revision" IS NOT NULL AND "__new_cache_lifecycle"."managed_group_id" IS NOT NULL AND "__new_cache_lifecycle"."lease_expires_at" IS NOT NULL AND "__new_cache_lifecycle"."selection_state" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_cache_lifecycle`("tenant", "cache_kind", "cache_name", "access", "generation", "read_revision", "state", "creation_expires_at", "management_kind", "managed_policy_id", "managed_policy_revision", "managed_group_id", "lease_expires_at", "selection_state", "update_hold", "deleted_at", "updated_at") SELECT "tenant", "cache_kind", "cache_name", "access", "generation", "read_revision", "state", "creation_expires_at", "management_kind", "managed_policy_id", "managed_policy_revision", "managed_group_id", "lease_expires_at", "selection_state", "update_hold", "deleted_at", "updated_at" FROM `cache_lifecycle`;--> statement-breakpoint
DROP TABLE `cache_lifecycle`;--> statement-breakpoint
ALTER TABLE `__new_cache_lifecycle` RENAME TO `cache_lifecycle`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `cache_lifecycle_default_identity_idx` ON `cache_lifecycle` (`tenant`) WHERE "cache_lifecycle"."cache_kind" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX `cache_lifecycle_named_identity_idx` ON `cache_lifecycle` (`tenant`,`cache_name`) WHERE "cache_lifecycle"."cache_kind" = 'named';--> statement-breakpoint
CREATE INDEX `cache_lifecycle_native_identity_idx` ON `cache_lifecycle` (`tenant`,`cache_kind`,`cache_name`);--> statement-breakpoint
CREATE INDEX `cache_lifecycle_managed_capacity_idx` ON `cache_lifecycle` (`tenant`,`managed_policy_id`,`state`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `cache_lifecycle_managed_group_selection_idx` ON `cache_lifecycle` (`tenant`,`managed_group_id`,`access`,`state`,`selection_state`);--> statement-breakpoint
CREATE TABLE `__new_managed_cache_group` (
	`tenant` text NOT NULL,
	`id` text NOT NULL,
	`access` text NOT NULL,
	`reuse_view_name` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `id`),
	CONSTRAINT "managed_cache_group_access_check" CHECK("__new_managed_cache_group"."access" IN ('public', 'private'))
);
--> statement-breakpoint
INSERT INTO `__new_managed_cache_group`("tenant", "id", "access", "reuse_view_name", "state", "created_at") SELECT "tenant", "id", "access", "reuse_view_name", "state", "created_at" FROM `managed_cache_group`;--> statement-breakpoint
DROP TABLE `managed_cache_group`;--> statement-breakpoint
ALTER TABLE `__new_managed_cache_group` RENAME TO `managed_cache_group`;--> statement-breakpoint
CREATE UNIQUE INDEX `managed_cache_group_view_idx` ON `managed_cache_group` (`tenant`,`reuse_view_name`);--> statement-breakpoint
CREATE TABLE `__new_managed_policy_family` (
	`tenant` text NOT NULL,
	`id` text NOT NULL,
	`owner_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`cache_namespace` text NOT NULL,
	`status` text NOT NULL,
	`current_revision` integer NOT NULL,
	`pending_revision` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `id`),
	CONSTRAINT "managed_policy_family_status_check" CHECK("__new_managed_policy_family"."status" IN ('active', 'updating', 'update-failed', 'retiring')),
	CONSTRAINT "managed_policy_family_revision_check" CHECK("__new_managed_policy_family"."current_revision" > 0 AND ("__new_managed_policy_family"."pending_revision" IS NULL OR "__new_managed_policy_family"."pending_revision" > "__new_managed_policy_family"."current_revision"))
);
--> statement-breakpoint
INSERT INTO `__new_managed_policy_family`("tenant", "id", "owner_id", "repository_id", "cache_namespace", "status", "current_revision", "pending_revision", "created_at", "updated_at") SELECT "tenant", "id", "owner_id", "repository_id", "cache_namespace", "status", "current_revision", "pending_revision", "created_at", "updated_at" FROM `managed_policy_family`;--> statement-breakpoint
DROP TABLE `managed_policy_family`;--> statement-breakpoint
ALTER TABLE `__new_managed_policy_family` RENAME TO `managed_policy_family`;--> statement-breakpoint
CREATE UNIQUE INDEX `managed_policy_repository_idx` ON `managed_policy_family` (`tenant`,`repository_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `managed_policy_namespace_idx` ON `managed_policy_family` (`tenant`,`cache_namespace`);--> statement-breakpoint
CREATE TABLE `__new_managed_policy_revision` (
	`tenant` text NOT NULL,
	`policy_id` text NOT NULL,
	`revision` integer NOT NULL,
	`group_id` text NOT NULL,
	`access` text NOT NULL,
	`priority` integer NOT NULL,
	`default_root_ttl_seconds` integer,
	`maximum_root_duration_seconds` integer NOT NULL,
	`allow_permanent_roots` integer NOT NULL,
	`grace_seconds` integer,
	`creation_lease_seconds` integer NOT NULL,
	`provisional_lease_seconds` integer NOT NULL,
	`activity_lease_seconds` integer NOT NULL,
	`maximum_live_caches` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `policy_id`, `revision`),
	CONSTRAINT "managed_policy_revision_values_check" CHECK("__new_managed_policy_revision"."revision" > 0 AND "__new_managed_policy_revision"."priority" > 0 AND "__new_managed_policy_revision"."maximum_root_duration_seconds" > 0 AND "__new_managed_policy_revision"."creation_lease_seconds" > 0 AND "__new_managed_policy_revision"."provisional_lease_seconds" > 0 AND "__new_managed_policy_revision"."activity_lease_seconds" > 0 AND "__new_managed_policy_revision"."maximum_live_caches" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_managed_policy_revision`("tenant", "policy_id", "revision", "group_id", "access", "priority", "default_root_ttl_seconds", "maximum_root_duration_seconds", "allow_permanent_roots", "grace_seconds", "creation_lease_seconds", "provisional_lease_seconds", "activity_lease_seconds", "maximum_live_caches", "created_at") SELECT "tenant", "policy_id", "revision", "group_id", "access", "priority", "default_root_ttl_seconds", "maximum_root_duration_seconds", "allow_permanent_roots", "grace_seconds", "creation_lease_seconds", "provisional_lease_seconds", "activity_lease_seconds", "maximum_live_caches", "created_at" FROM `managed_policy_revision`;--> statement-breakpoint
DROP TABLE `managed_policy_revision`;--> statement-breakpoint
ALTER TABLE `__new_managed_policy_revision` RENAME TO `managed_policy_revision`;--> statement-breakpoint
CREATE INDEX `managed_policy_revision_group_idx` ON `managed_policy_revision` (`tenant`,`group_id`,`revision`);

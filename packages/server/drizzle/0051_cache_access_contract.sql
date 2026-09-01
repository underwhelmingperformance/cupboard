DROP TABLE `cache`;--> statement-breakpoint
DROP TABLE `reuse_view_selector`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cache_identity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`access` text NOT NULL,
	`priority` integer NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`read_revision` integer DEFAULT 1 NOT NULL,
	`root_retention_rule_set_id` integer DEFAULT 1 NOT NULL,
	`default_root_ttl_seconds` integer,
	`grace_seconds` integer,
	`grace_managed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "cache_identity_check" CHECK(("__new_cache_identity"."kind" = 'default' AND "__new_cache_identity"."name" IS NULL) OR ("__new_cache_identity"."kind" = 'named' AND "__new_cache_identity"."name" IS NOT NULL AND length("__new_cache_identity"."name") BETWEEN 1 AND 63 AND substr("__new_cache_identity"."name", 1, 1) GLOB '[a-z0-9]' AND "__new_cache_identity"."name" NOT GLOB '*[^a-z0-9._-]*')),
	CONSTRAINT "cache_identity_access_check" CHECK("__new_cache_identity"."access" IN ('public', 'private'))
);
--> statement-breakpoint
INSERT INTO `__new_cache_identity`("id", "kind", "name", "access", "priority", "generation", "read_revision", "root_retention_rule_set_id", "default_root_ttl_seconds", "grace_seconds", "grace_managed", "created_at", "deleted_at") SELECT "id", "kind", "name", "access", "priority", "generation", "read_revision", "root_retention_rule_set_id", "default_root_ttl_seconds", "grace_seconds", "grace_managed", "created_at", "deleted_at" FROM `cache_identity`;--> statement-breakpoint
DROP TABLE `cache_identity`;--> statement-breakpoint
ALTER TABLE `__new_cache_identity` RENAME TO `cache_identity`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `cache_one_default_idx` ON `cache_identity` (`kind`) WHERE "cache_identity"."kind" = 'default' AND "cache_identity"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `cache_named_name_idx` ON `cache_identity` (`name`) WHERE "cache_identity"."kind" = 'named' AND "cache_identity"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `__new_reuse_view_selector_native` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`view` text NOT NULL,
	`kind` text NOT NULL,
	`cache_name` text,
	`prefix` text,
	CONSTRAINT "reuse_view_selector_view_check" CHECK(length("__new_reuse_view_selector_native"."view") BETWEEN 1 AND 63 AND substr("__new_reuse_view_selector_native"."view", 1, 1) GLOB '[a-z0-9]' AND "__new_reuse_view_selector_native"."view" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "reuse_view_selector_identity_check" CHECK(("__new_reuse_view_selector_native"."kind" IN ('default', 'all-named', 'all') AND "__new_reuse_view_selector_native"."cache_name" IS NULL AND "__new_reuse_view_selector_native"."prefix" IS NULL) OR ("__new_reuse_view_selector_native"."kind" = 'named' AND "__new_reuse_view_selector_native"."cache_name" IS NOT NULL AND length("__new_reuse_view_selector_native"."cache_name") BETWEEN 1 AND 63 AND substr("__new_reuse_view_selector_native"."cache_name", 1, 1) GLOB '[a-z0-9]' AND "__new_reuse_view_selector_native"."cache_name" NOT GLOB '*[^a-z0-9._-]*' AND "__new_reuse_view_selector_native"."prefix" IS NULL) OR ("__new_reuse_view_selector_native"."kind" = 'prefix' AND "__new_reuse_view_selector_native"."cache_name" IS NULL AND "__new_reuse_view_selector_native"."prefix" IS NOT NULL AND length("__new_reuse_view_selector_native"."prefix") BETWEEN 1 AND 63 AND substr("__new_reuse_view_selector_native"."prefix", 1, 1) GLOB '[a-z0-9]' AND "__new_reuse_view_selector_native"."prefix" NOT GLOB '*[^a-z0-9._-]*'))
);
--> statement-breakpoint
INSERT INTO `__new_reuse_view_selector_native`("id", "view", "kind", "cache_name", "prefix") SELECT "id", "view", "kind", "cache_name", "prefix" FROM `reuse_view_selector_native`;--> statement-breakpoint
DROP TABLE `reuse_view_selector_native`;--> statement-breakpoint
ALTER TABLE `__new_reuse_view_selector_native` RENAME TO `reuse_view_selector_native`;--> statement-breakpoint
CREATE UNIQUE INDEX `reuse_view_selector_singleton_idx` ON `reuse_view_selector_native` (`view`,`kind`) WHERE "reuse_view_selector_native"."kind" IN ('default', 'all-named', 'all');--> statement-breakpoint
CREATE UNIQUE INDEX `reuse_view_selector_named_idx` ON `reuse_view_selector_native` (`view`,`cache_name`) WHERE "reuse_view_selector_native"."kind" = 'named';--> statement-breakpoint
CREATE UNIQUE INDEX `reuse_view_selector_prefix_idx` ON `reuse_view_selector_native` (`view`,`prefix`) WHERE "reuse_view_selector_native"."kind" = 'prefix';--> statement-breakpoint
CREATE TABLE `__new_retention_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`cache_id` integer,
	`root_name_prefix` text,
	`default_ttl_seconds` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "retention_policy_identity_check" CHECK(("__new_retention_policy"."kind" = 'cache' AND "__new_retention_policy"."cache_id" IS NOT NULL AND "__new_retention_policy"."root_name_prefix" IS NULL) OR ("__new_retention_policy"."kind" = 'root-name-prefix' AND "__new_retention_policy"."cache_id" IS NULL AND "__new_retention_policy"."root_name_prefix" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_retention_policy`("id", "kind", "cache_id", "root_name_prefix", "default_ttl_seconds", "created_at") SELECT "id", "kind", "cache_id", "root_name_prefix", "default_ttl_seconds", "created_at" FROM `retention_policy`;--> statement-breakpoint
DROP TABLE `retention_policy`;--> statement-breakpoint
ALTER TABLE `__new_retention_policy` RENAME TO `retention_policy`;--> statement-breakpoint
CREATE UNIQUE INDEX `retention_policy_cache_idx` ON `retention_policy` (`cache_id`) WHERE "retention_policy"."kind" = 'cache';--> statement-breakpoint
CREATE UNIQUE INDEX `retention_policy_root_name_prefix_idx` ON `retention_policy` (`root_name_prefix`) WHERE "retention_policy"."kind" = 'root-name-prefix';--> statement-breakpoint
CREATE TABLE `__new_narinfo` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`store_path` text NOT NULL,
	`nar_hash` text NOT NULL,
	`nar_size` integer NOT NULL,
	`references_json` text NOT NULL,
	`deriver` text,
	`ca` text,
	`sigs_json` text DEFAULT '[]' NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`signature_generation` integer DEFAULT 0 NOT NULL,
	`pending_signature_generation` integer,
	`created_at` text NOT NULL,
	PRIMARY KEY(`cache_id`, `store_path_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_narinfo`("cache_id", "store_path_hash", "store_path", "nar_hash", "nar_size", "references_json", "deriver", "ca", "sigs_json", "generation", "signature_generation", "pending_signature_generation", "created_at") SELECT "cache_id", "store_path_hash", "store_path", "nar_hash", "nar_size", "references_json", "deriver", "ca", "sigs_json", "generation", "signature_generation", "pending_signature_generation", "created_at" FROM `narinfo`;--> statement-breakpoint
DROP TABLE `narinfo`;--> statement-breakpoint
ALTER TABLE `__new_narinfo` RENAME TO `narinfo`;--> statement-breakpoint
CREATE INDEX `narinfo_store_path_hash_cache_idx` ON `narinfo` (`store_path_hash`,`cache_id`);--> statement-breakpoint
CREATE INDEX `narinfo_pending_signature_generation_idx` ON `narinfo` (`pending_signature_generation`,`signature_generation`,`cache_id`,`store_path_hash`);--> statement-breakpoint
CREATE INDEX `narinfo_signature_generation_idx` ON `narinfo` (`signature_generation`);--> statement-breakpoint
CREATE TABLE `__new_retention_root` (
	`cache_id` integer NOT NULL,
	`name` text NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`cache_id`, `name`)
);
--> statement-breakpoint
INSERT INTO `__new_retention_root`("cache_id", "name", "expires_at", "created_at", "updated_at") SELECT "cache_id", "name", "expires_at", "created_at", "updated_at" FROM `retention_root`;--> statement-breakpoint
DROP TABLE `retention_root`;--> statement-breakpoint
ALTER TABLE `__new_retention_root` RENAME TO `retention_root`;--> statement-breakpoint
CREATE INDEX `retention_root_expires_at_idx` ON `retention_root` (`expires_at`);--> statement-breakpoint
CREATE INDEX `retention_root_cache_expires_at_name_idx` ON `retention_root` (`cache_id`,`expires_at`,`name`);--> statement-breakpoint
CREATE TABLE `__new_garbage_collection_frontier` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	PRIMARY KEY(`cache_id`, `store_path_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_garbage_collection_frontier`("cache_id", "store_path_hash") SELECT "cache_id", "store_path_hash" FROM `garbage_collection_frontier`;--> statement-breakpoint
DROP TABLE `garbage_collection_frontier`;--> statement-breakpoint
ALTER TABLE `__new_garbage_collection_frontier` RENAME TO `garbage_collection_frontier`;--> statement-breakpoint
CREATE TABLE `__new_garbage_collection_mark` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	PRIMARY KEY(`cache_id`, `store_path_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_garbage_collection_mark`("cache_id", "store_path_hash") SELECT "cache_id", "store_path_hash" FROM `garbage_collection_mark`;--> statement-breakpoint
DROP TABLE `garbage_collection_mark`;--> statement-breakpoint
ALTER TABLE `__new_garbage_collection_mark` RENAME TO `garbage_collection_mark`;--> statement-breakpoint
CREATE TABLE `__new_generation_seq` (
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`store_path_hash` text NOT NULL,
	`next_generation` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "generation_seq_cache_identity_check" CHECK(("__new_generation_seq"."cache_kind" = 'default' AND "__new_generation_seq"."cache_name" IS NULL) OR ("__new_generation_seq"."cache_kind" = 'named' AND "__new_generation_seq"."cache_name" IS NOT NULL AND length("__new_generation_seq"."cache_name") BETWEEN 1 AND 63 AND substr("__new_generation_seq"."cache_name", 1, 1) GLOB '[a-z0-9]' AND "__new_generation_seq"."cache_name" NOT GLOB '*[^a-z0-9._-]*'))
);
--> statement-breakpoint
INSERT INTO `__new_generation_seq`("cache_kind", "cache_name", "store_path_hash", "next_generation") SELECT "cache_kind", "cache_name", "store_path_hash", "next_generation" FROM `generation_seq`;--> statement-breakpoint
DROP TABLE `generation_seq`;--> statement-breakpoint
ALTER TABLE `__new_generation_seq` RENAME TO `generation_seq`;--> statement-breakpoint
CREATE UNIQUE INDEX `generation_seq_default_identity_idx` ON `generation_seq` (`store_path_hash`) WHERE "generation_seq"."cache_kind" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX `generation_seq_named_identity_idx` ON `generation_seq` (`cache_name`,`store_path_hash`) WHERE "generation_seq"."cache_kind" = 'named';--> statement-breakpoint
CREATE TABLE `__new_narinfo_deletion` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`nar_hash` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`writer_epoch` text DEFAULT 'legacy-cache-identity' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`cache_id`, `store_path_hash`, `generation`)
);
--> statement-breakpoint
INSERT INTO `__new_narinfo_deletion`("cache_id", "store_path_hash", "nar_hash", "generation", "writer_epoch", "created_at") SELECT "cache_id", "store_path_hash", "nar_hash", "generation", "writer_epoch", "created_at" FROM `narinfo_deletion`;--> statement-breakpoint
DROP TABLE `narinfo_deletion`;--> statement-breakpoint
ALTER TABLE `__new_narinfo_deletion` RENAME TO `narinfo_deletion`;--> statement-breakpoint
CREATE TABLE `__new_retention_grace` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`retain_until` text NOT NULL,
	PRIMARY KEY(`cache_id`, `store_path_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_retention_grace`("cache_id", "store_path_hash", "retain_until") SELECT "cache_id", "store_path_hash", "retain_until" FROM `retention_grace`;--> statement-breakpoint
DROP TABLE `retention_grace`;--> statement-breakpoint
ALTER TABLE `__new_retention_grace` RENAME TO `retention_grace`;--> statement-breakpoint
CREATE INDEX `retention_grace_retain_until_idx` ON `retention_grace` (`retain_until`);--> statement-breakpoint
CREATE TABLE `__new_retention_root_target` (
	`cache_id` integer NOT NULL,
	`root_name` text NOT NULL,
	`store_path_hash` text NOT NULL,
	`store_path` text NOT NULL,
	PRIMARY KEY(`cache_id`, `root_name`, `store_path_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_retention_root_target`("cache_id", "root_name", "store_path_hash", "store_path") SELECT "cache_id", "root_name", "store_path_hash", "store_path" FROM `retention_root_target`;--> statement-breakpoint
DROP TABLE `retention_root_target`;--> statement-breakpoint
ALTER TABLE `__new_retention_root_target` RENAME TO `retention_root_target`;--> statement-breakpoint
CREATE TABLE `__new_garbage_collection_revision` (
	`cache_id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_garbage_collection_revision`("cache_id", "revision") SELECT "cache_id", "revision" FROM `garbage_collection_revision`;--> statement-breakpoint
DROP TABLE `garbage_collection_revision`;--> statement-breakpoint
ALTER TABLE `__new_garbage_collection_revision` RENAME TO `garbage_collection_revision`;--> statement-breakpoint
CREATE TABLE `__new_garbage_collection_scan` (
	`cache_id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`phase` text NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`mark_store_path_hash` text,
	`reference_cursor` integer DEFAULT -1 NOT NULL,
	`allow_empty_collection` integer DEFAULT false NOT NULL,
	`writer_epoch` text DEFAULT 'legacy-cache-identity' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_garbage_collection_scan`("cache_id", "revision", "phase", "cursor", "mark_store_path_hash", "reference_cursor", "allow_empty_collection", "writer_epoch") SELECT "cache_id", "revision", "phase", "cursor", "mark_store_path_hash", "reference_cursor", "allow_empty_collection", "writer_epoch" FROM `garbage_collection_scan`;--> statement-breakpoint
DROP TABLE `garbage_collection_scan`;--> statement-breakpoint
ALTER TABLE `__new_garbage_collection_scan` RENAME TO `garbage_collection_scan`;--> statement-breakpoint
CREATE TABLE `__new_garbage_collection_tenant_run` (
	`id` integer PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_garbage_collection_tenant_run`("id", "cache_id") SELECT "id", "cache_id" FROM `garbage_collection_tenant_run`;--> statement-breakpoint
DROP TABLE `garbage_collection_tenant_run`;--> statement-breakpoint
ALTER TABLE `__new_garbage_collection_tenant_run` RENAME TO `garbage_collection_tenant_run`;--> statement-breakpoint
CREATE TABLE `__new_pending_attestation` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`digest` text NOT NULL,
	`predicate_type` text,
	`r2_key` text NOT NULL,
	`writer_epoch` text DEFAULT 'legacy-cache-identity' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_pending_attestation`("id", "cache_id", "store_path_hash", "digest", "predicate_type", "r2_key", "writer_epoch", "created_at", "expires_at") SELECT "id", "cache_id", "store_path_hash", "digest", "predicate_type", "r2_key", "writer_epoch", "created_at", "expires_at" FROM `pending_attestation`;--> statement-breakpoint
DROP TABLE `pending_attestation`;--> statement-breakpoint
ALTER TABLE `__new_pending_attestation` RENAME TO `pending_attestation`;--> statement-breakpoint
CREATE INDEX `pending_attestation_expires_at_idx` ON `pending_attestation` (`expires_at`);--> statement-breakpoint
CREATE INDEX `pending_attestation_r2_key_idx` ON `pending_attestation` (`r2_key`);--> statement-breakpoint
CREATE TABLE `__new_pending_upload` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`nar_hash` text NOT NULL,
	`r2_key` text NOT NULL,
	`metadata_json` text NOT NULL,
	`writer_epoch` text DEFAULT 'legacy-cache-identity' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`verdict` text,
	`session_id` text,
	`claimed_at` text,
	`claim_owner` text,
	`grace_decision_json` text,
	`attach_root_name` text,
	`recorded_verdict_json` text
);
--> statement-breakpoint
INSERT INTO `__new_pending_upload`("id", "cache_id", "nar_hash", "r2_key", "metadata_json", "writer_epoch", "created_at", "expires_at", "verdict", "session_id", "claimed_at", "claim_owner", "grace_decision_json", "attach_root_name", "recorded_verdict_json") SELECT "id", "cache_id", "nar_hash", "r2_key", "metadata_json", "writer_epoch", "created_at", "expires_at", "verdict", "session_id", "claimed_at", "claim_owner", "grace_decision_json", "attach_root_name", "recorded_verdict_json" FROM `pending_upload`;--> statement-breakpoint
DROP TABLE `pending_upload`;--> statement-breakpoint
ALTER TABLE `__new_pending_upload` RENAME TO `pending_upload`;--> statement-breakpoint
CREATE INDEX `pending_upload_expires_at_idx` ON `pending_upload` (`expires_at`);--> statement-breakpoint
CREATE INDEX `pending_upload_terminal_expires_at_idx` ON `pending_upload` (`expires_at`,`id`) WHERE "pending_upload"."verdict" IS NULL OR "pending_upload"."verdict" = 'servable' OR "pending_upload"."verdict" = 'mismatch' OR "pending_upload"."verdict" = 'over-quota';--> statement-breakpoint
CREATE INDEX `pending_upload_verdict_idx` ON `pending_upload` (`verdict`);--> statement-breakpoint
CREATE INDEX `pending_upload_r2_key_idx` ON `pending_upload` (`r2_key`);--> statement-breakpoint
CREATE INDEX `pending_upload_recorded_verdict_idx` ON `pending_upload` (`id`) WHERE "pending_upload"."recorded_verdict_json" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_reuse_view` (
	`name` text PRIMARY KEY NOT NULL,
	`access` text NOT NULL,
	`revision` integer NOT NULL,
	`priority` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "reuse_view_name_check" CHECK(length("__new_reuse_view"."name") BETWEEN 1 AND 63 AND substr("__new_reuse_view"."name", 1, 1) GLOB '[a-z0-9]' AND "__new_reuse_view"."name" NOT GLOB '*[^a-z0-9._-]*'),
	CONSTRAINT "reuse_view_access_check" CHECK("__new_reuse_view"."access" IN ('public', 'private'))
);
--> statement-breakpoint
INSERT INTO `__new_reuse_view`("name", "access", "revision", "priority", "created_at", "updated_at") SELECT "name", "access", "revision", "priority", "created_at", "updated_at" FROM `reuse_view`;--> statement-breakpoint
DROP TABLE `reuse_view`;--> statement-breakpoint
ALTER TABLE `__new_reuse_view` RENAME TO `reuse_view`;--> statement-breakpoint
CREATE TABLE `__new_verification_cursor` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`last_store_path_hash` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_verification_cursor`("id", "cache_id", "last_store_path_hash", "updated_at") SELECT "id", "cache_id", "last_store_path_hash", "updated_at" FROM `verification_cursor`;--> statement-breakpoint
DROP TABLE `verification_cursor`;--> statement-breakpoint
ALTER TABLE `__new_verification_cursor` RENAME TO `verification_cursor`;

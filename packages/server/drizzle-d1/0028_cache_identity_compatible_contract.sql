-- Custom SQL migration file, put your code below! --
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_blob_ref` (
	`tenant` text NOT NULL,
	`cache` text,
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`store_path_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`nar_hash` text NOT NULL,
	`cache_generation` integer NOT NULL,
	PRIMARY KEY(`tenant`, `cache`, `store_path_hash`, `generation`),
	CONSTRAINT "blob_ref_cache_identity_check" CHECK(("__new_blob_ref"."cache_kind" = 'default' AND "__new_blob_ref"."cache_name" IS NULL) OR ("__new_blob_ref"."cache_kind" = 'named' AND "__new_blob_ref"."cache_name" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_blob_ref`("tenant", "cache", "cache_kind", "cache_name", "store_path_hash", "generation", "nar_hash", "cache_generation") SELECT "tenant", "cache", "cache_kind", "cache_name", "store_path_hash", "generation", "nar_hash", "cache_generation" FROM `blob_ref`;--> statement-breakpoint
DROP TABLE `blob_ref`;--> statement-breakpoint
ALTER TABLE `__new_blob_ref` RENAME TO `blob_ref`;--> statement-breakpoint
CREATE UNIQUE INDEX `blob_ref_default_identity_idx` ON `blob_ref` (`tenant`,`store_path_hash`,`generation`) WHERE "blob_ref"."cache_kind" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX `blob_ref_named_identity_idx` ON `blob_ref` (`tenant`,`cache_name`,`store_path_hash`,`generation`) WHERE "blob_ref"."cache_kind" = 'named';--> statement-breakpoint
CREATE INDEX `blob_ref_nar_hash_idx` ON `blob_ref` (`nar_hash`);--> statement-breakpoint
CREATE INDEX `blob_ref_tenant_nar_hash_cache_idx` ON `blob_ref` (`tenant`,`nar_hash`,`cache`,`cache_generation`);--> statement-breakpoint
CREATE INDEX `blob_ref_tenant_nar_hash_native_idx` ON `blob_ref` (`tenant`,`nar_hash`,`cache_kind`,`cache_name`,`cache_generation`);--> statement-breakpoint
CREATE TABLE `__new_attestation_ref` (
	`tenant` text NOT NULL,
	`cache` text,
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`store_path_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`predicate_type` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`tenant`, `cache`, `store_path_hash`, `generation`, `predicate_type`, `digest`),
	CONSTRAINT "attestation_ref_cache_identity_check" CHECK(("__new_attestation_ref"."cache_kind" = 'default' AND "__new_attestation_ref"."cache_name" IS NULL) OR ("__new_attestation_ref"."cache_kind" = 'named' AND "__new_attestation_ref"."cache_name" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_attestation_ref`("tenant", "cache", "cache_kind", "cache_name", "store_path_hash", "generation", "predicate_type", "digest") SELECT "tenant", "cache", "cache_kind", "cache_name", "store_path_hash", "generation", "predicate_type", "digest" FROM `attestation_ref`;--> statement-breakpoint
DROP TABLE `attestation_ref`;--> statement-breakpoint
ALTER TABLE `__new_attestation_ref` RENAME TO `attestation_ref`;--> statement-breakpoint
CREATE UNIQUE INDEX `attestation_ref_default_identity_idx` ON `attestation_ref` (`tenant`,`store_path_hash`,`generation`,`predicate_type`,`digest`) WHERE "attestation_ref"."cache_kind" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX `attestation_ref_named_identity_idx` ON `attestation_ref` (`tenant`,`cache_name`,`store_path_hash`,`generation`,`predicate_type`,`digest`) WHERE "attestation_ref"."cache_kind" = 'named';--> statement-breakpoint
CREATE INDEX `attestation_ref_digest_idx` ON `attestation_ref` (`digest`);--> statement-breakpoint
CREATE TABLE `__new_cache_lifecycle` (
	`tenant` text NOT NULL,
	`cache` text,
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`access` text NOT NULL,
	`generation` integer NOT NULL,
	`read_revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `cache`),
	CONSTRAINT "cache_lifecycle_identity_check" CHECK(("__new_cache_lifecycle"."cache_kind" = 'default' AND "__new_cache_lifecycle"."cache_name" IS NULL) OR ("__new_cache_lifecycle"."cache_kind" = 'named' AND "__new_cache_lifecycle"."cache_name" IS NOT NULL)),
	CONSTRAINT "cache_lifecycle_access_check" CHECK("__new_cache_lifecycle"."access" IN ('public', 'private'))
);
--> statement-breakpoint
INSERT INTO `__new_cache_lifecycle`("tenant", "cache", "cache_kind", "cache_name", "access", "generation", "read_revision", "deleted_at", "updated_at") SELECT "tenant", "cache", "cache_kind", "cache_name", "access", "generation", "read_revision", "deleted_at", "updated_at" FROM `cache_lifecycle`;--> statement-breakpoint
DROP TABLE `cache_lifecycle`;--> statement-breakpoint
ALTER TABLE `__new_cache_lifecycle` RENAME TO `cache_lifecycle`;--> statement-breakpoint
CREATE UNIQUE INDEX `cache_lifecycle_default_identity_idx` ON `cache_lifecycle` (`tenant`) WHERE "cache_lifecycle"."cache_kind" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX `cache_lifecycle_named_identity_idx` ON `cache_lifecycle` (`tenant`,`cache_name`) WHERE "cache_lifecycle"."cache_kind" = 'named';--> statement-breakpoint
CREATE INDEX `cache_lifecycle_native_identity_idx` ON `cache_lifecycle` (`tenant`,`cache_kind`,`cache_name`);--> statement-breakpoint
CREATE TABLE `__new_tenant_cache_read_credential` (
	`tenant` text NOT NULL,
	`cache` text,
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`read_user` text NOT NULL,
	`read_password_hash` text NOT NULL,
	`read_password_salt` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `cache`),
	CONSTRAINT "tenant_cache_read_credential_identity_check" CHECK(("__new_tenant_cache_read_credential"."cache_kind" = 'default' AND "__new_tenant_cache_read_credential"."cache_name" IS NULL) OR ("__new_tenant_cache_read_credential"."cache_kind" = 'named' AND "__new_tenant_cache_read_credential"."cache_name" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_tenant_cache_read_credential`("tenant", "cache", "cache_kind", "cache_name", "read_user", "read_password_hash", "read_password_salt", "created_at") SELECT "tenant", "cache", "cache_kind", "cache_name", "read_user", "read_password_hash", "read_password_salt", "created_at" FROM `tenant_cache_read_credential`;--> statement-breakpoint
DROP TABLE `tenant_cache_read_credential`;--> statement-breakpoint
ALTER TABLE `__new_tenant_cache_read_credential` RENAME TO `tenant_cache_read_credential`;--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_cache_read_credential_default_identity_idx` ON `tenant_cache_read_credential` (`tenant`) WHERE "tenant_cache_read_credential"."cache_kind" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_cache_read_credential_named_identity_idx` ON `tenant_cache_read_credential` (`tenant`,`cache_name`) WHERE "tenant_cache_read_credential"."cache_kind" = 'named';--> statement-breakpoint
CREATE TABLE `__new_tenant` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`read_mode` text,
	`owner_issuer` text NOT NULL,
	`owner_subject` text NOT NULL,
	`owner_audience` text NOT NULL,
	`config_version` integer NOT NULL,
	`cache_catalogue_version` integer,
	`created_at` text NOT NULL,
	`read_user` text,
	`read_password_hash` text,
	`read_password_salt` text,
	`last_maintained_at` text,
	`local_step` integer
);
--> statement-breakpoint
INSERT INTO `__new_tenant`("id", "status", "read_mode", "owner_issuer", "owner_subject", "owner_audience", "config_version", "cache_catalogue_version", "created_at", "read_user", "read_password_hash", "read_password_salt", "last_maintained_at", "local_step") SELECT "id", "status", "read_mode", "owner_issuer", "owner_subject", "owner_audience", "config_version", "cache_catalogue_version", "created_at", "read_user", "read_password_hash", "read_password_salt", "last_maintained_at", "local_step" FROM `tenant`;--> statement-breakpoint
DROP TABLE `tenant`;--> statement-breakpoint
ALTER TABLE `__new_tenant` RENAME TO `tenant`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tenant_maintenance_idx` ON `tenant` (`status`,`last_maintained_at`);

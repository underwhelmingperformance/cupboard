CREATE TABLE `attestation_ref` (
	`tenant` text NOT NULL,
	`cache` text NOT NULL,
	`store_path_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`predicate_type` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`tenant`, `cache`, `store_path_hash`, `generation`, `predicate_type`, `digest`)
);
--> statement-breakpoint
CREATE INDEX `attestation_ref_digest_idx` ON `attestation_ref` (`digest`);--> statement-breakpoint
CREATE TABLE `cas_object` (
	`digest` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`stored_at` text NOT NULL,
	`delete_after` text
);
--> statement-breakpoint
CREATE INDEX `cas_object_delete_after_idx` ON `cas_object` (`delete_after`);--> statement-breakpoint
CREATE TABLE `tenant_cas_blob` (
	`tenant` text NOT NULL,
	`digest` text NOT NULL,
	`size` integer NOT NULL,
	PRIMARY KEY(`tenant`, `digest`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenant_usage` (
	`tenant` text PRIMARY KEY NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`narinfos` integer DEFAULT 0 NOT NULL,
	`blobs` integer DEFAULT 0 NOT NULL,
	`cas_bytes` integer DEFAULT 0 NOT NULL,
	`cas_blobs` integer DEFAULT 0 NOT NULL,
	`quota_bytes` integer,
	`updated_at` text NOT NULL,
	CONSTRAINT "tenant_usage_bytes_nonnegative" CHECK("__new_tenant_usage"."bytes" >= 0),
	CONSTRAINT "tenant_usage_narinfos_nonnegative" CHECK("__new_tenant_usage"."narinfos" >= 0),
	CONSTRAINT "tenant_usage_blobs_nonnegative" CHECK("__new_tenant_usage"."blobs" >= 0),
	CONSTRAINT "tenant_usage_cas_bytes_nonnegative" CHECK("__new_tenant_usage"."cas_bytes" >= 0),
	CONSTRAINT "tenant_usage_cas_blobs_nonnegative" CHECK("__new_tenant_usage"."cas_blobs" >= 0),
	CONSTRAINT "tenant_usage_within_quota" CHECK("__new_tenant_usage"."quota_bytes" IS NULL OR "__new_tenant_usage"."bytes" + "__new_tenant_usage"."cas_bytes" <= "__new_tenant_usage"."quota_bytes")
);
--> statement-breakpoint
INSERT INTO `__new_tenant_usage`("tenant", "bytes", "narinfos", "blobs", "cas_bytes", "cas_blobs", "quota_bytes", "updated_at") SELECT "tenant", "bytes", "narinfos", "blobs", 0, 0, "quota_bytes", "updated_at" FROM `tenant_usage`;--> statement-breakpoint
DROP TABLE `tenant_usage`;--> statement-breakpoint
ALTER TABLE `__new_tenant_usage` RENAME TO `tenant_usage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

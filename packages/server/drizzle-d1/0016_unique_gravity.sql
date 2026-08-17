CREATE TABLE `s3_multipart_part` (
	`tenant` text NOT NULL,
	`upload_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`reserved_size` integer NOT NULL,
	`etag` text,
	`reservation_token` text NOT NULL,
	PRIMARY KEY(`tenant`, `upload_id`, `part_number`)
);
--> statement-breakpoint
CREATE TABLE `s3_multipart_upload` (
	`tenant` text NOT NULL,
	`upload_id` text NOT NULL,
	`cache` text NOT NULL,
	`r2_key` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`completion_token` text,
	`completion_lease_expires_at` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`tenant`, `upload_id`)
);
--> statement-breakpoint
CREATE INDEX `s3_multipart_upload_expiry_idx` ON `s3_multipart_upload` (`tenant`,`expires_at`);--> statement-breakpoint
CREATE TABLE `s3_staged_object` (
	`tenant` text NOT NULL,
	`r2_key` text NOT NULL,
	`cache` text NOT NULL,
	`size` integer NOT NULL,
	`expires_at` text NOT NULL,
	`deleting` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`tenant`, `r2_key`)
);
--> statement-breakpoint
CREATE INDEX `s3_staged_object_expiry_idx` ON `s3_staged_object` (`tenant`,`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenant_usage` (
	`tenant` text PRIMARY KEY NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`narinfos` integer DEFAULT 0 NOT NULL,
	`blobs` integer DEFAULT 0 NOT NULL,
	`cas_bytes` integer DEFAULT 0 NOT NULL,
	`cas_blobs` integer DEFAULT 0 NOT NULL,
	`staged_bytes` integer DEFAULT 0 NOT NULL,
	`multipart_bytes` integer DEFAULT 0 NOT NULL,
	`quota_bytes` integer,
	`updated_at` text NOT NULL,
	CONSTRAINT "tenant_usage_bytes_nonnegative" CHECK("__new_tenant_usage"."bytes" >= 0),
	CONSTRAINT "tenant_usage_narinfos_nonnegative" CHECK("__new_tenant_usage"."narinfos" >= 0),
	CONSTRAINT "tenant_usage_blobs_nonnegative" CHECK("__new_tenant_usage"."blobs" >= 0),
	CONSTRAINT "tenant_usage_cas_bytes_nonnegative" CHECK("__new_tenant_usage"."cas_bytes" >= 0),
	CONSTRAINT "tenant_usage_cas_blobs_nonnegative" CHECK("__new_tenant_usage"."cas_blobs" >= 0),
	CONSTRAINT "tenant_usage_staged_bytes_nonnegative" CHECK("__new_tenant_usage"."staged_bytes" >= 0),
	CONSTRAINT "tenant_usage_multipart_bytes_nonnegative" CHECK("__new_tenant_usage"."multipart_bytes" >= 0),
	CONSTRAINT "tenant_usage_within_quota" CHECK("__new_tenant_usage"."quota_bytes" IS NULL OR "__new_tenant_usage"."bytes" + "__new_tenant_usage"."cas_bytes" + "__new_tenant_usage"."staged_bytes" + "__new_tenant_usage"."multipart_bytes" <= "__new_tenant_usage"."quota_bytes")
);
--> statement-breakpoint
INSERT INTO `__new_tenant_usage`("tenant", "bytes", "narinfos", "blobs", "cas_bytes", "cas_blobs", "staged_bytes", "multipart_bytes", "quota_bytes", "updated_at") SELECT "tenant", "bytes", "narinfos", "blobs", "cas_bytes", "cas_blobs", 0, 0, "quota_bytes", "updated_at" FROM `tenant_usage`;--> statement-breakpoint
DROP TABLE `tenant_usage`;--> statement-breakpoint
ALTER TABLE `__new_tenant_usage` RENAME TO `tenant_usage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

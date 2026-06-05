CREATE TABLE `tenant_usage` (
	`tenant` text PRIMARY KEY NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`narinfos` integer DEFAULT 0 NOT NULL,
	`blobs` integer DEFAULT 0 NOT NULL,
	`quota_bytes` integer,
	`updated_at` text NOT NULL,
	CONSTRAINT "tenant_usage_bytes_nonnegative" CHECK("tenant_usage"."bytes" >= 0),
	CONSTRAINT "tenant_usage_within_quota" CHECK("tenant_usage"."quota_bytes" IS NULL OR "tenant_usage"."bytes" <= "tenant_usage"."quota_bytes")
);

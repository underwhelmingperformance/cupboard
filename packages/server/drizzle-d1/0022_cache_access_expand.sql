ALTER TABLE `attestation_ref` ADD `cache_kind` text;--> statement-breakpoint
ALTER TABLE `attestation_ref` ADD `cache_name` text;--> statement-breakpoint
ALTER TABLE `blob_ref` ADD `cache_kind` text;--> statement-breakpoint
ALTER TABLE `blob_ref` ADD `cache_name` text;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `cache_kind` text;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `cache_name` text;--> statement-breakpoint
ALTER TABLE `cache_lifecycle` ADD `access` text;--> statement-breakpoint
ALTER TABLE `tenant` ADD `cache_catalogue_version` integer;--> statement-breakpoint
ALTER TABLE `tenant_cache_read_credential` ADD `cache_kind` text;--> statement-breakpoint
ALTER TABLE `tenant_cache_read_credential` ADD `cache_name` text;

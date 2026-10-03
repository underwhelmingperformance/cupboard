CREATE TABLE `path_read_revocation` (
	`tenant` text NOT NULL,
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`store_path_hash` text NOT NULL,
	`cache_generation` integer NOT NULL,
	`generation` integer NOT NULL,
	`is_pending` integer DEFAULT true NOT NULL,
	CONSTRAINT "path_read_revocation_cache_identity_check" CHECK(("path_read_revocation"."cache_kind" = 'default' AND "path_read_revocation"."cache_name" IS NULL) OR ("path_read_revocation"."cache_kind" = 'named' AND "path_read_revocation"."cache_name" IS NOT NULL))
);

--> statement-breakpoint
CREATE UNIQUE INDEX `path_read_revocation_default_identity_idx` ON `path_read_revocation` (`tenant`,`store_path_hash`) WHERE "path_read_revocation"."cache_kind" = 'default';
--> statement-breakpoint
CREATE UNIQUE INDEX `path_read_revocation_named_identity_idx` ON `path_read_revocation` (`tenant`,`cache_name`,`store_path_hash`) WHERE "path_read_revocation"."cache_kind" = 'named';
--> statement-breakpoint
CREATE INDEX `path_read_revocation_pending_idx` ON `path_read_revocation` (`tenant`,`cache_kind`,`cache_name`,`store_path_hash`) WHERE "path_read_revocation"."is_pending" = true;
--> statement-breakpoint
CREATE INDEX `path_read_revocation_native_identity_idx` ON `path_read_revocation` (`tenant`,`cache_kind`,`cache_name`,`store_path_hash`);
--> statement-breakpoint
ALTER TABLE `attestation_ref` ADD `readable` integer DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE INDEX `attestation_ref_readable_path_idx` ON `attestation_ref` (`tenant`,`cache_kind`,`cache_name`,`store_path_hash`,`generation`,`predicate_type`,`digest`) WHERE "attestation_ref"."readable" = true;
--> statement-breakpoint
CREATE INDEX `attestation_ref_readable_digest_idx` ON `attestation_ref` (`tenant`,`cache_kind`,`cache_name`,`digest`,`store_path_hash`,`generation`) WHERE "attestation_ref"."readable" = true;
--> statement-breakpoint
ALTER TABLE `blob_ref` ADD `readable` integer DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE INDEX `blob_ref_readable_path_idx` ON `blob_ref` (`tenant`,`cache_kind`,`cache_name`,`store_path_hash`,`cache_generation`,`generation`) WHERE "blob_ref"."readable" = true;
--> statement-breakpoint
CREATE INDEX `blob_ref_readable_nar_idx` ON `blob_ref` (`tenant`,`nar_hash`,`cache_kind`,`cache_name`,`cache_generation`) WHERE "blob_ref"."readable" = true;
--> statement-breakpoint
CREATE INDEX `blob_ref_path_lifecycle_generation_idx` ON `blob_ref` (`tenant`,`cache_kind`,`cache_name`,`store_path_hash`,`cache_generation`,`generation`);

--> statement-breakpoint
CREATE VIEW `blob_ref_storage` AS SELECT * FROM `blob_ref`;
--> statement-breakpoint
CREATE VIEW `attestation_ref_storage` AS SELECT * FROM `attestation_ref`;
--> statement-breakpoint
CREATE VIEW `cache_lifecycle_storage` AS SELECT * FROM `cache_lifecycle`;

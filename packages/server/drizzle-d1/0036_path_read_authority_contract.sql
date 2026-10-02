DROP VIEW `blob_ref_storage`;
--> statement-breakpoint
DROP VIEW `attestation_ref_storage`;
--> statement-breakpoint
ALTER TABLE `blob_ref` RENAME TO `blob_ref_storage`;
--> statement-breakpoint
ALTER TABLE `attestation_ref` RENAME TO `attestation_ref_storage`;
--> statement-breakpoint
CREATE VIEW `blob_ref` AS select "tenant", "cache_kind", "cache_name", "store_path_hash", "generation", "nar_hash", "readable", "cache_generation" from "blob_ref_storage" where "blob_ref_storage"."readable" = true AND NOT EXISTS (
		SELECT 1 FROM path_read_revocation AS fence
		WHERE fence.tenant = "blob_ref_storage"."tenant"
		 AND fence.cache_kind = "blob_ref_storage"."cache_kind"
		 AND fence.cache_name IS "blob_ref_storage"."cache_name"
		 AND fence.store_path_hash = "blob_ref_storage"."store_path_hash"
		 AND fence.cache_generation = "blob_ref_storage"."cache_generation"
		 AND fence.generation >= "blob_ref_storage"."generation"
	);
--> statement-breakpoint
CREATE VIEW `attestation_ref` AS select "tenant", "cache_kind", "cache_name", "store_path_hash", "generation", "predicate_type", "digest", "readable" from "attestation_ref_storage" where "attestation_ref_storage"."readable" = true AND EXISTS (
		SELECT 1 FROM "blob_ref"
		WHERE "blob_ref"."tenant" = "attestation_ref_storage"."tenant"
		 AND "blob_ref"."cache_kind" = "attestation_ref_storage"."cache_kind"
		 AND "blob_ref"."cache_name" IS "attestation_ref_storage"."cache_name"
		 AND "blob_ref"."store_path_hash" = "attestation_ref_storage"."store_path_hash"
		 AND "blob_ref"."generation" = "attestation_ref_storage"."generation"
	);
--> statement-breakpoint
DROP VIEW `cache_lifecycle_storage`;
--> statement-breakpoint
ALTER TABLE `cache_lifecycle` RENAME TO `cache_lifecycle_storage`;
--> statement-breakpoint
CREATE VIEW `cache_lifecycle` AS select "tenant", "cache_kind", "cache_name", "access", "generation", "read_revision", "deleted_at", "updated_at" from "cache_lifecycle_storage" where false;

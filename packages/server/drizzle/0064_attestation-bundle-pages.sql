PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pending_attestation` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`store_path_hash` text,
	`validated_bundle_json` text,
	`digest` text NOT NULL,
	`predicate_type` text,
	`r2_key` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_pending_attestation`("id", "cache_id", "store_path_hash", "validated_bundle_json", "digest", "predicate_type", "r2_key", "created_at", "expires_at") SELECT "id", "cache_id", "store_path_hash", NULL, "digest", "predicate_type", "r2_key", "created_at", "expires_at" FROM `pending_attestation`;--> statement-breakpoint
DROP TABLE `pending_attestation`;--> statement-breakpoint
ALTER TABLE `__new_pending_attestation` RENAME TO `pending_attestation`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `pending_attestation_cache_id_idx` ON `pending_attestation` (`cache_id`);--> statement-breakpoint
CREATE INDEX `pending_attestation_expires_at_idx` ON `pending_attestation` (`expires_at`);--> statement-breakpoint
CREATE INDEX `pending_attestation_r2_key_idx` ON `pending_attestation` (`r2_key`);
--> statement-breakpoint
CREATE TABLE `pending_attestation_subject` (
	`upload_id` text NOT NULL,
	`subject_name` text NOT NULL,
	`nar_digest` text NOT NULL,
	PRIMARY KEY(`upload_id`, `subject_name`, `nar_digest`)
);

--> statement-breakpoint
CREATE TRIGGER `pending_attestation_delete_subjects` AFTER DELETE ON `pending_attestation` BEGIN DELETE FROM `pending_attestation_subject` WHERE `upload_id` = OLD.`id`; END;--> statement-breakpoint
CREATE TRIGGER `managed_retirement_pending_attestation_delete` AFTER DELETE ON `pending_attestation`
WHEN EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
  AND NOT EXISTS (SELECT 1 FROM `pending_attestation` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;

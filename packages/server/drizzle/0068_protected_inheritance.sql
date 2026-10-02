CREATE TABLE `work_sequence` (`id` integer PRIMARY KEY NOT NULL,
	`value` integer DEFAULT 0 NOT NULL);
--> statement-breakpoint
INSERT INTO `work_sequence` (`id`, `value`) VALUES (1, 0);
--> statement-breakpoint
CREATE TABLE `__new_pending_upload` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_id` integer NOT NULL,
	`nar_hash` text NOT NULL,
	`r2_key` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`verdict` text,
	`session_id` text,
	`claimed_at` text,
	`claim_owner` text,
	`grace_decision_json` text,
	`attach_root_name` text,
	`recorded_verdict_json` text,
 `settle_failures` integer DEFAULT 0 NOT NULL,
	`settle_retry_after` text,
	`last_settle_error` text,
	`nar_refresh_pending` integer DEFAULT false NOT NULL,
	`accepted_sequence` integer DEFAULT 0 NOT NULL,
	`accepted_expires_at` text,
	`commit_started_sequence` integer);
--> statement-breakpoint
INSERT INTO `__new_pending_upload` (`rowid`, `id`, `cache_id`, `nar_hash`, `r2_key`, `metadata_json`, `created_at`, `expires_at`, `verdict`, `session_id`, `claimed_at`, `claim_owner`, `grace_decision_json`, `attach_root_name`, `recorded_verdict_json`, `settle_failures`, `settle_retry_after`, `last_settle_error`, `nar_refresh_pending`, `accepted_sequence`, `accepted_expires_at`, `commit_started_sequence`) SELECT `rowid`, `id`, `cache_id`, `nar_hash`, `r2_key`, `metadata_json`, `created_at`, `expires_at`, `verdict`, `session_id`, `claimed_at`, `claim_owner`, `grace_decision_json`, `attach_root_name`, `recorded_verdict_json`, `settle_failures`, `settle_retry_after`, `last_settle_error`, `nar_refresh_pending`, 0, `expires_at`, CASE WHEN `verdict` = 'committing' THEN 0 ELSE NULL END FROM `pending_upload`;
--> statement-breakpoint
DROP TRIGGER `managed_retirement_pending_upload_delete`;
--> statement-breakpoint
DROP TABLE `pending_upload`;
--> statement-breakpoint
ALTER TABLE `__new_pending_upload` RENAME TO `pending_upload`;
--> statement-breakpoint
CREATE INDEX `pending_upload_expires_at_idx` ON `pending_upload` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `pending_upload_gc_path_idx` ON `pending_upload` (`cache_id`, json_extract(`metadata_json`, '$.storePathHash'), `verdict`);
--> statement-breakpoint
CREATE INDEX `pending_upload_inheritance_cutoff_idx` ON `pending_upload` (json_extract(`metadata_json`, '$.storePathHash'), `nar_hash`, `accepted_sequence`, `cache_id`, `commit_started_sequence`, `accepted_expires_at`, `expires_at`, `verdict`);
--> statement-breakpoint
CREATE INDEX `pending_upload_inheritance_path_idx` ON `pending_upload` (json_extract(`metadata_json`, '$.storePathHash'), `nar_hash`, `cache_id`, `verdict`, `expires_at`);
--> statement-breakpoint
CREATE INDEX `pending_upload_r2_key_idx` ON `pending_upload` (`r2_key`);
--> statement-breakpoint
CREATE INDEX `pending_upload_recorded_verdict_idx` ON `pending_upload` (`id`) WHERE "pending_upload"."recorded_verdict_json" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `pending_upload_settle_retry_after_idx` ON `pending_upload` (`settle_retry_after`) WHERE "pending_upload"."verdict" = 'pending' OR "pending_upload"."verdict" = 'committing';
--> statement-breakpoint
CREATE INDEX `pending_upload_terminal_expires_at_idx` ON `pending_upload` (`expires_at`,`id`) WHERE "pending_upload"."verdict" IS NULL OR "pending_upload"."verdict" = 'servable' OR "pending_upload"."verdict" = 'mismatch' OR "pending_upload"."verdict" = 'over-quota';
--> statement-breakpoint
CREATE INDEX `pending_upload_verdict_idx` ON `pending_upload` (`verdict`);
--> statement-breakpoint
CREATE TRIGGER `managed_retirement_pending_upload_delete` AFTER DELETE ON `pending_upload`
WHEN EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
  AND NOT EXISTS (SELECT 1 FROM `pending_upload` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;
--> statement-breakpoint
CREATE TABLE `__new_attestation_inheritance` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`nar_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`not_before` text NOT NULL,
	`source_predicate_type` text,
	`source_digest` text,
	`accepted_upload_id` text,
	`accepted_sequence` integer DEFAULT 0 NOT NULL,
	`accepted_expires_at` text,
	`commit_started_sequence` integer,
	`queued_sequence` integer DEFAULT 0 NOT NULL,
	`source_end_cache_id` integer,
	`source_end_generation` integer,
	`source_cache_id` integer default 0 not null,
	`source_generation` integer default -1 not null,
	`source_reference_generation` integer default -1 not null,
	`source_reference_complete` integer default false not null,
	`source_reference_cache_id` integer default 0 not null,
	`source_reference_end_generation` integer,
	PRIMARY KEY(`cache_id`,
	`store_path_hash`,
	`generation`)
);
--> statement-breakpoint
INSERT INTO `__new_attestation_inheritance` (`rowid`, `cache_id`, `store_path_hash`, `generation`, `nar_hash`, `attempts`, `not_before`, `source_predicate_type`, `source_digest`, `accepted_upload_id`, `accepted_sequence`, `accepted_expires_at`, `commit_started_sequence`, `queued_sequence`, `source_end_cache_id`, `source_end_generation`, `source_cache_id`, `source_generation`, `source_reference_generation`, `source_reference_complete`, `source_reference_cache_id`, `source_reference_end_generation`) SELECT `rowid`, `cache_id`, `store_path_hash`, `generation`, `nar_hash`, `attempts`, `not_before`, `source_predicate_type`, `source_digest`, NULL, 0, NULL, NULL, 0, NULL, NULL, 0, -1, -1, false, 0, NULL FROM `attestation_inheritance`;
--> statement-breakpoint
DROP TABLE `attestation_inheritance`;
--> statement-breakpoint
ALTER TABLE `__new_attestation_inheritance` RENAME TO `attestation_inheritance`;
--> statement-breakpoint
CREATE INDEX `attestation_inheritance_cutoff_idx` ON `attestation_inheritance` (`store_path_hash`,`nar_hash`,`accepted_sequence`,`cache_id`,`generation`,`queued_sequence`,`accepted_expires_at`,`commit_started_sequence`);
--> statement-breakpoint
CREATE INDEX `attestation_inheritance_not_before_idx` ON `attestation_inheritance` (`not_before`);
--> statement-breakpoint
CREATE INDEX `attestation_inheritance_path_nar_idx` ON `attestation_inheritance` (`store_path_hash`,`nar_hash`,`cache_id`,`generation`);
--> statement-breakpoint
CREATE TABLE `__new_narinfo_deletion` (
	`cache_id` integer NOT NULL,
	`store_path_hash` text NOT NULL,
	`nar_hash` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`withdrawn` integer DEFAULT false NOT NULL,
	`explicit` integer DEFAULT false NOT NULL,
	`protection_cutoff` integer,
	`protection_captured_at` text,
	PRIMARY KEY(`cache_id`,
	`store_path_hash`,
	`generation`)
);
--> statement-breakpoint
INSERT INTO `__new_narinfo_deletion` (`rowid`, `cache_id`, `store_path_hash`, `nar_hash`, `generation`, `created_at`, `withdrawn`, `explicit`, `protection_cutoff`, `protection_captured_at`) SELECT `rowid`, `cache_id`, `store_path_hash`, `nar_hash`, `generation`, `created_at`, `withdrawn`, false, NULL, NULL FROM `narinfo_deletion`;
--> statement-breakpoint
DROP TRIGGER `managed_retirement_narinfo_deletion_delete`;
--> statement-breakpoint
DROP TABLE `narinfo_deletion`;
--> statement-breakpoint
ALTER TABLE `__new_narinfo_deletion` RENAME TO `narinfo_deletion`;
--> statement-breakpoint
CREATE INDEX `narinfo_deletion_inheritance_source_idx` ON `narinfo_deletion` (`store_path_hash`, `nar_hash`, `cache_id`, `generation`);
--> statement-breakpoint
CREATE INDEX `narinfo_deletion_path_nar_idx` ON `narinfo_deletion` (`store_path_hash`,`nar_hash`,`explicit`,`cache_id`,`generation`);
--> statement-breakpoint
CREATE INDEX `narinfo_deletion_reference_cutoff_idx` ON `narinfo_deletion` (`store_path_hash`, `cache_id`, `explicit`, `generation`);
--> statement-breakpoint
CREATE TRIGGER `managed_retirement_narinfo_deletion_delete` AFTER DELETE ON `narinfo_deletion`
WHEN EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
  AND NOT EXISTS (SELECT 1 FROM `narinfo_deletion` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;
--> statement-breakpoint
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
	PRIMARY KEY(`cache_id`,
	`store_path_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_narinfo` (`rowid`, `cache_id`, `store_path_hash`, `store_path`, `nar_hash`, `nar_size`, `references_json`, `deriver`, `ca`, `sigs_json`, `generation`, `signature_generation`, `pending_signature_generation`, `created_at`) SELECT `rowid`, `cache_id`, `store_path_hash`, `store_path`, `nar_hash`, `nar_size`, `references_json`, `deriver`, `ca`, `sigs_json`, `generation`, `signature_generation`, `pending_signature_generation`, `created_at` FROM `narinfo`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_barrier_narinfo_insert`;
--> statement-breakpoint
DROP TRIGGER `garbage_collection_barrier_narinfo_update`;
--> statement-breakpoint
DROP TRIGGER `cache_narinfo_count_insert`;
--> statement-breakpoint
DROP TRIGGER `cache_narinfo_count_delete`;
--> statement-breakpoint
DROP TRIGGER `cache_narinfo_count_update_cache`;
--> statement-breakpoint
DROP TRIGGER `managed_retirement_narinfo_delete`;
--> statement-breakpoint
DROP TABLE `narinfo`;
--> statement-breakpoint
ALTER TABLE `__new_narinfo` RENAME TO `narinfo`;
--> statement-breakpoint
CREATE INDEX `narinfo_inheritance_source_idx` ON `narinfo` (`store_path_hash`, `nar_hash`, `cache_id`, `generation`);
--> statement-breakpoint
CREATE INDEX `narinfo_nar_hash_cache_id_store_path_hash_idx` ON `narinfo` (`nar_hash`,`cache_id`,`store_path_hash`);
--> statement-breakpoint
CREATE INDEX `narinfo_pending_signature_generation_idx` ON `narinfo` (`pending_signature_generation`,`signature_generation`,`cache_id`,`store_path_hash`);
--> statement-breakpoint
CREATE INDEX `narinfo_signature_generation_idx` ON `narinfo` (`signature_generation`);
--> statement-breakpoint
CREATE INDEX `narinfo_store_path_hash_cache_idx` ON `narinfo` (`store_path_hash`,`cache_id`);
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_narinfo_insert`
AFTER INSERT ON `narinfo`
WHEN EXISTS (
	SELECT 1 FROM `garbage_collection_mark`
	WHERE `cache_id` = NEW.`cache_id` AND `store_path_hash` = NEW.`store_path_hash`
)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_barrier_narinfo_update`
AFTER UPDATE OF `cache_id`, `store_path_hash`, `references_json` ON `narinfo`
WHEN EXISTS (
	SELECT 1 FROM `garbage_collection_mark`
	WHERE `cache_id` = NEW.`cache_id` AND `store_path_hash` = NEW.`store_path_hash`
)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `cache_narinfo_count_insert`
AFTER INSERT ON `narinfo`
WHEN NEW.`cache_id` IS NOT NULL AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`narinfo_complete`
		OR NEW.rowid <= `narinfo_cursor`
		OR NEW.rowid > `narinfo_initial_rowid_high_water`
	)
)
BEGIN
	INSERT INTO `cache_narinfo_count` (`cache_id`, `count`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `count` = `count` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `cache_narinfo_count_delete`
AFTER DELETE ON `narinfo`
WHEN OLD.`cache_id` IS NOT NULL AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`narinfo_complete`
		OR OLD.rowid <= `narinfo_cursor`
		OR OLD.rowid > `narinfo_initial_rowid_high_water`
	)
)
BEGIN
	UPDATE `cache_narinfo_count`
	SET `count` = `count` - 1
	WHERE `cache_id` = OLD.`cache_id`;
	DELETE FROM `cache_narinfo_count`
	WHERE `cache_id` = OLD.`cache_id` AND `count` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER `cache_narinfo_count_update_cache`
AFTER UPDATE OF `cache_id` ON `narinfo`
WHEN OLD.`cache_id` IS NOT NEW.`cache_id` AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`narinfo_complete`
		OR NEW.rowid <= `narinfo_cursor`
		OR NEW.rowid > `narinfo_initial_rowid_high_water`
	)
)
BEGIN
	UPDATE `cache_narinfo_count`
	SET `count` = `count` - 1
	WHERE OLD.`cache_id` IS NOT NULL AND `cache_id` = OLD.`cache_id`;
	DELETE FROM `cache_narinfo_count`
	WHERE OLD.`cache_id` IS NOT NULL AND `cache_id` = OLD.`cache_id` AND `count` = 0;
	INSERT INTO `cache_narinfo_count` (`cache_id`, `count`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` IS NOT NULL
	ON CONFLICT (`cache_id`) DO UPDATE SET `count` = `count` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `managed_retirement_narinfo_delete` AFTER DELETE ON `narinfo`
WHEN EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
  AND NOT EXISTS (SELECT 1 FROM `narinfo` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;

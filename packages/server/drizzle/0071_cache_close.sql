ALTER TABLE cache_identity ADD COLUMN retention_epoch INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE cache_identity ADD COLUMN close_history_cursor INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE managed_cache_retirement ADD COLUMN retirement_started_at TEXT;
--> statement-breakpoint
CREATE TABLE cache_close_event(cache_id INTEGER NOT NULL, epoch INTEGER NOT NULL, closed_at TEXT NOT NULL, grace_until TEXT NOT NULL, PRIMARY KEY(cache_id, epoch));
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
	`commit_started_sequence` integer,
	`retry_started_active_ms` integer,
	`settle_exhaustion` text,
	`retention_epoch` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT OR REPLACE INTO `__new_pending_upload` (`rowid`, `id`, `cache_id`, `nar_hash`, `r2_key`, `metadata_json`, `created_at`, `expires_at`, `verdict`, `session_id`, `claimed_at`, `claim_owner`, `grace_decision_json`, `attach_root_name`, `recorded_verdict_json`, `settle_failures`, `settle_retry_after`, `last_settle_error`, `nar_refresh_pending`, `accepted_sequence`, `accepted_expires_at`, `commit_started_sequence`, `retry_started_active_ms`, `settle_exhaustion`) SELECT `rowid`, `id`, `cache_id`, `nar_hash`, `r2_key`, `metadata_json`, `created_at`, `expires_at`, `verdict`, `session_id`, `claimed_at`, `claim_owner`, `grace_decision_json`, `attach_root_name`, `recorded_verdict_json`, `settle_failures`, `settle_retry_after`, `last_settle_error`, `nar_refresh_pending`, `accepted_sequence`, `accepted_expires_at`, `commit_started_sequence`, `retry_started_active_ms`, `settle_exhaustion` FROM `pending_upload`;
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
CREATE INDEX `pending_upload_cache_retention_epoch_idx` ON `pending_upload` (`cache_id`, `retention_epoch`);
--> statement-breakpoint
CREATE INDEX `pending_upload_inheritance_cutoff_idx` ON `pending_upload` (json_extract(`metadata_json`, '$.storePathHash'), `nar_hash`, `accepted_sequence`, `cache_id`, `commit_started_sequence`, `accepted_expires_at`, `expires_at`, `verdict`);
--> statement-breakpoint
CREATE INDEX `pending_upload_inheritance_path_idx` ON `pending_upload` (json_extract(`metadata_json`, '$.storePathHash'), `nar_hash`, `cache_id`, `verdict`, `expires_at`);
--> statement-breakpoint
CREATE INDEX `pending_upload_recorded_retry_idx` ON `pending_upload` (COALESCE(`settle_retry_after`, ''),`id`) WHERE `recorded_verdict_json` IS NOT NULL AND `settle_exhaustion` IS NULL;
--> statement-breakpoint
CREATE INDEX `pending_upload_fresh_ready_idx` ON `pending_upload` (MAX(COALESCE(settle_retry_after, ''), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+360 seconds'), '')), id) WHERE (verdict = 'pending' OR verdict = 'committing') AND (recorded_verdict_json IS NULL OR claim_owner IS NULL) AND settle_exhaustion IS NULL;
--> statement-breakpoint
CREATE INDEX `pending_upload_recorded_ready_idx` ON `pending_upload` (CASE WHEN recorded_verdict_json IS NOT NULL THEN COALESCE(settle_retry_after, '') ELSE MAX(COALESCE(settle_retry_after, ''), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+360 seconds'), '')) END, id) WHERE recorded_verdict_json IS NOT NULL OR settle_exhaustion IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `pending_upload_exhausted_ready_idx` ON `pending_upload` (MAX(COALESCE(settle_retry_after, ''), COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+360 seconds'), '')), id) WHERE settle_exhaustion IS NOT NULL;
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
CREATE TABLE `__new_retention_root` (
	`cache_id` integer NOT NULL,
	`name` text NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`retention_epoch` integer DEFAULT 0 NOT NULL,
	`close_applied_epoch` integer DEFAULT 0 NOT NULL,
	`close_grace_until` text,
	PRIMARY KEY(`cache_id`, `name`)
);
--> statement-breakpoint
INSERT OR REPLACE INTO `__new_retention_root` (`rowid`, `cache_id`, `name`, `expires_at`, `created_at`, `updated_at`) SELECT `rowid`, `cache_id`, `name`, `expires_at`, `created_at`, `updated_at` FROM `retention_root`;
--> statement-breakpoint
DROP TABLE `retention_root`;
--> statement-breakpoint
ALTER TABLE `__new_retention_root` RENAME TO `retention_root`;
--> statement-breakpoint
CREATE INDEX `retention_root_cache_expires_at_name_idx` ON `retention_root` (`cache_id`,`expires_at`,`name`);
--> statement-breakpoint
CREATE INDEX `retention_root_expires_at_idx` ON `retention_root` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `retention_root_cache_retention_epoch_idx` ON `retention_root` (`cache_id`, `retention_epoch`, `name`);
--> statement-breakpoint
CREATE INDEX `retention_root_close_applied_epoch_idx` ON `retention_root` (`cache_id`, `close_applied_epoch`, `name`);
--> statement-breakpoint
ALTER TABLE narinfo ADD COLUMN retention_epoch INTEGER NOT NULL DEFAULT 0;

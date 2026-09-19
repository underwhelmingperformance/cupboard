ALTER TABLE `managed_cache_retirement` ADD `incarnation` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `managed_cache_retirement` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `managed_cache_retirement` ADD `next_check_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
UPDATE `managed_cache_retirement` SET `next_check_at` = `eligible_after`;--> statement-breakpoint
CREATE INDEX `managed_cache_retirement_next_check_at_idx` ON `managed_cache_retirement` (`next_check_at`);--> statement-breakpoint
CREATE TRIGGER `managed_retirement_pending_upload_delete` AFTER DELETE ON `pending_upload`
WHEN EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
  AND NOT EXISTS (SELECT 1 FROM `pending_upload` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;--> statement-breakpoint
CREATE TRIGGER `managed_retirement_pending_attestation_delete` AFTER DELETE ON `pending_attestation`
WHEN EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
  AND NOT EXISTS (SELECT 1 FROM `pending_attestation` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;--> statement-breakpoint
CREATE TRIGGER `managed_retirement_narinfo_delete` AFTER DELETE ON `narinfo`
WHEN EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
  AND NOT EXISTS (SELECT 1 FROM `narinfo` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;--> statement-breakpoint
CREATE TRIGGER `managed_retirement_narinfo_deletion_delete` AFTER DELETE ON `narinfo_deletion`
WHEN EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
  AND NOT EXISTS (SELECT 1 FROM `narinfo_deletion` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;--> statement-breakpoint
CREATE TRIGGER `managed_retirement_verification_cursor_delete` AFTER DELETE ON `verification_cursor`
WHEN EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;--> statement-breakpoint
CREATE TRIGGER `managed_retirement_verification_cursor_move` AFTER UPDATE OF `cache_id` ON `verification_cursor`
WHEN OLD.`cache_id` <> NEW.`cache_id`
  AND EXISTS (SELECT 1 FROM `managed_cache_retirement` WHERE `cache_id` = OLD.`cache_id`)
BEGIN
  UPDATE `managed_cache_retirement`
  SET `revision` = `revision` + 1, `next_check_at` = `eligible_after`
  WHERE `cache_id` = OLD.`cache_id`;
END;

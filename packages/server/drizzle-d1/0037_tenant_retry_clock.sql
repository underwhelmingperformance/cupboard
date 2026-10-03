ALTER TABLE `tenant` ADD `retry_active_elapsed_ms` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tenant` ADD `retry_active_since_ms` integer;
--> statement-breakpoint
CREATE TRIGGER `tenant_retry_clock_insert`
AFTER INSERT ON `tenant`
WHEN NEW.`status` = 'active'
BEGIN
	UPDATE `tenant`
	SET `retry_active_since_ms` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
	WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_retry_clock_status`
AFTER UPDATE OF `status` ON `tenant`
WHEN OLD.`status` <> NEW.`status`
BEGIN
	UPDATE `tenant`
	SET `retry_active_elapsed_ms` = OLD.`retry_active_elapsed_ms` + CASE
		WHEN OLD.`status` = 'active' AND OLD.`retry_active_since_ms` IS NOT NULL
		THEN MAX(0, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER) - OLD.`retry_active_since_ms`)
		ELSE 0
	END,
	`retry_active_since_ms` = CASE
		WHEN NEW.`status` = 'active'
		THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
		ELSE NULL
	END
	WHERE `id` = NEW.`id`;
END;

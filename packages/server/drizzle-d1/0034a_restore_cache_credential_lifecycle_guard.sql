CREATE TRIGGER `tenant_cache_read_credential_live_cache_insert`
BEFORE INSERT ON `tenant_cache_read_credential`
WHEN NOT EXISTS (
	SELECT 1
	FROM `cache_lifecycle`
	WHERE `cache_lifecycle`.`tenant` = NEW.`tenant`
		AND `cache_lifecycle`.`cache_kind` = NEW.`cache_kind`
		AND `cache_lifecycle`.`cache_name` IS NEW.`cache_name`
		AND `cache_lifecycle`.`deleted_at` IS NULL
		AND `cache_lifecycle`.`state` = 'active'
		AND `cache_lifecycle`.`management_kind` = 'durable'
)
BEGIN
	SELECT RAISE(ABORT, 'cache credential requires a live durable cache');
END;--> statement-breakpoint
CREATE TRIGGER `cache_lifecycle_delete_credential_on_tombstone`
AFTER UPDATE OF `deleted_at` ON `cache_lifecycle`
WHEN NEW.`deleted_at` IS NOT NULL OR NEW.`state` <> 'active' OR NEW.`management_kind` <> 'durable'
BEGIN
	DELETE FROM `tenant_cache_read_credential`
	WHERE `tenant` = NEW.`tenant`
		AND `cache_kind` = NEW.`cache_kind`
		AND `cache_name` IS NEW.`cache_name`;
END;--> statement-breakpoint
CREATE TRIGGER `cache_lifecycle_delete_credential_on_delete`
AFTER DELETE ON `cache_lifecycle`
BEGIN
	DELETE FROM `tenant_cache_read_credential`
	WHERE `tenant` = OLD.`tenant`
		AND `cache_kind` = OLD.`cache_kind`
		AND `cache_name` IS OLD.`cache_name`;
END;

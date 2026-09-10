DELETE FROM `tenant_cache_read_credential`
WHERE NOT EXISTS (
	SELECT 1
	FROM `cache_lifecycle`
	WHERE `cache_lifecycle`.`tenant` = `tenant_cache_read_credential`.`tenant`
		AND `cache_lifecycle`.`cache_kind` = `tenant_cache_read_credential`.`cache_kind`
		AND `cache_lifecycle`.`cache_name` IS `tenant_cache_read_credential`.`cache_name`
		AND `cache_lifecycle`.`deleted_at` IS NULL
);--> statement-breakpoint
CREATE TRIGGER `tenant_cache_read_credential_live_cache_insert`
BEFORE INSERT ON `tenant_cache_read_credential`
WHEN NOT EXISTS (
	SELECT 1
	FROM `cache_lifecycle`
	WHERE `cache_lifecycle`.`tenant` = NEW.`tenant`
		AND `cache_lifecycle`.`cache_kind` = NEW.`cache_kind`
		AND `cache_lifecycle`.`cache_name` IS NEW.`cache_name`
		AND `cache_lifecycle`.`deleted_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'cache credential requires a live cache');
END;--> statement-breakpoint
CREATE TRIGGER `cache_lifecycle_delete_credential_on_tombstone`
AFTER UPDATE OF `deleted_at` ON `cache_lifecycle`
WHEN NEW.`deleted_at` IS NOT NULL
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

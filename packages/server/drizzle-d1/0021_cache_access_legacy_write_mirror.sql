CREATE TRIGGER `cache_access_mirror_blob_ref_insert`
AFTER INSERT ON `blob_ref`
WHEN NEW.`cache_kind` IS NULL
BEGIN
	UPDATE `blob_ref`
	SET
		`cache_kind` = CASE WHEN NEW.`cache` = '' THEN 'default' ELSE 'named' END,
		`cache_name` = CASE
			WHEN NEW.`cache` = '' THEN NULL
			WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9)
			ELSE NEW.`cache`
		END
	WHERE rowid = NEW.rowid;
END;--> statement-breakpoint
CREATE TRIGGER `cache_access_mirror_attestation_ref_insert`
AFTER INSERT ON `attestation_ref`
WHEN NEW.`cache_kind` IS NULL
BEGIN
	UPDATE `attestation_ref`
	SET
		`cache_kind` = CASE WHEN NEW.`cache` = '' THEN 'default' ELSE 'named' END,
		`cache_name` = CASE
			WHEN NEW.`cache` = '' THEN NULL
			WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9)
			ELSE NEW.`cache`
		END
	WHERE rowid = NEW.rowid;
END;--> statement-breakpoint
CREATE TRIGGER `cache_access_mirror_lifecycle_insert`
AFTER INSERT ON `cache_lifecycle`
WHEN NEW.`cache_kind` IS NULL OR NEW.`access` IS NULL
BEGIN
	UPDATE `cache_lifecycle`
	SET
		`cache_kind` = CASE WHEN NEW.`cache` = '' THEN 'default' ELSE 'named' END,
		`cache_name` = CASE
			WHEN NEW.`cache` = '' THEN NULL
			WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9)
			ELSE NEW.`cache`
		END,
		`access` = CASE
			WHEN NEW.`cache` LIKE 'private/%' THEN 'private'
			ELSE (SELECT `read_mode` FROM `tenant` WHERE `id` = NEW.`tenant`)
		END
	WHERE rowid = NEW.rowid;
END;--> statement-breakpoint
CREATE TRIGGER `cache_access_mirror_credential_insert`
AFTER INSERT ON `tenant_cache_read_credential`
WHEN NEW.`cache_kind` IS NULL
BEGIN
	UPDATE `tenant_cache_read_credential`
	SET
		`cache_kind` = 'named',
		`cache_name` = CASE
			WHEN NEW.`cache` LIKE 'private/%' THEN substr(NEW.`cache`, 9)
			ELSE NEW.`cache`
		END
	WHERE rowid = NEW.rowid;
END;--> statement-breakpoint
CREATE TRIGGER `cache_access_mirror_tenant_read_mode_update`
AFTER UPDATE OF `read_mode` ON `tenant`
BEGIN
	UPDATE `cache_lifecycle`
	SET `access` = NEW.`read_mode`
	WHERE `tenant` = NEW.`id`
		AND `cache` NOT LIKE 'private/%';
END;

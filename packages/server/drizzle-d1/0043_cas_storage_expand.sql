CREATE VIEW `cas_object_storage` AS SELECT `digest`, `size`, `incarnation`, `stored_at`, `delete_after` FROM `cas_object`;
--> statement-breakpoint
CREATE TRIGGER `cas_object_storage_insert` INSTEAD OF INSERT ON `cas_object_storage`
BEGIN
	INSERT INTO `cas_object` (`digest`, `size`, `incarnation`, `stored_at`, `delete_after`)
	VALUES (NEW.`digest`, NEW.`size`, COALESCE(NEW.`incarnation`, 1), NEW.`stored_at`, NEW.`delete_after`);
END;
--> statement-breakpoint
CREATE TRIGGER `cas_object_storage_update` INSTEAD OF UPDATE ON `cas_object_storage`
BEGIN
	UPDATE `cas_object` SET `digest` = NEW.`digest`, `size` = NEW.`size`, `incarnation` = NEW.`incarnation`, `stored_at` = NEW.`stored_at`, `delete_after` = NEW.`delete_after`
	WHERE `digest` = OLD.`digest`;
END;
--> statement-breakpoint
CREATE TRIGGER `cas_object_storage_delete` INSTEAD OF DELETE ON `cas_object_storage`
BEGIN
	DELETE FROM `cas_object` WHERE `digest` = OLD.`digest`;
END;
--> statement-breakpoint
CREATE VIEW `tenant_cas_blob_storage` AS SELECT `tenant`, `digest`, `size` FROM `tenant_cas_blob`;
--> statement-breakpoint
CREATE TRIGGER `tenant_cas_blob_storage_insert` INSTEAD OF INSERT ON `tenant_cas_blob_storage`
BEGIN
	INSERT INTO `tenant_cas_blob` (`tenant`, `digest`, `size`)
	VALUES (NEW.`tenant`, NEW.`digest`, NEW.`size`);
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_cas_blob_storage_update` INSTEAD OF UPDATE ON `tenant_cas_blob_storage`
BEGIN
	UPDATE `tenant_cas_blob` SET `tenant` = NEW.`tenant`, `digest` = NEW.`digest`, `size` = NEW.`size`
	WHERE `tenant` = OLD.`tenant` AND `digest` = OLD.`digest`;
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_cas_blob_storage_delete` INSTEAD OF DELETE ON `tenant_cas_blob_storage`
BEGIN
	DELETE FROM `tenant_cas_blob` WHERE `tenant` = OLD.`tenant` AND `digest` = OLD.`digest`;
END;

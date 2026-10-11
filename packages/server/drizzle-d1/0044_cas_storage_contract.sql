DROP VIEW `cas_object_storage`;
--> statement-breakpoint
DROP VIEW `tenant_cas_blob_storage`;
--> statement-breakpoint
ALTER TABLE `cas_object` RENAME TO `cas_object_storage`;
--> statement-breakpoint
ALTER TABLE `tenant_cas_blob` RENAME TO `tenant_cas_blob_storage`;
--> statement-breakpoint
CREATE VIEW `cas_object` AS SELECT `digest`, `size`, `incarnation`, `stored_at`, `delete_after` FROM `cas_object_storage`;
--> statement-breakpoint
CREATE VIEW `tenant_cas_blob` AS SELECT `tenant`, `digest`, `size` FROM `tenant_cas_blob_storage`;

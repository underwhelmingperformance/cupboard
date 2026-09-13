-- Custom SQL migration file, put your code below! --
CREATE INDEX `pending_upload_gc_path_idx`
ON `pending_upload` (`cache_id`, json_extract(`metadata_json`, '$.storePathHash'), `verdict`);--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_narinfo_insert`
AFTER INSERT ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_narinfo_update`
AFTER UPDATE ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` <> OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_narinfo_delete`
AFTER DELETE ON `narinfo`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_insert`
AFTER INSERT ON `retention_root`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_update`
AFTER UPDATE ON `retention_root`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` <> OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_delete`
AFTER DELETE ON `retention_root`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_target_insert`
AFTER INSERT ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_target_update`
AFTER UPDATE ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` <> OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_root_target_delete`
AFTER DELETE ON `retention_root_target`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_grace_insert`
AFTER INSERT ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_grace_update`
AFTER UPDATE ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` <> OLD.`cache_id`
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_revision_grace_delete`
AFTER DELETE ON `retention_grace`
BEGIN
	INSERT INTO `garbage_collection_revision` (`cache_id`, `revision`)
	VALUES (OLD.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `revision` = `revision` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `garbage_collection_cache_delete`
AFTER DELETE ON `cache_identity`
BEGIN
	DELETE FROM `garbage_collection_frontier` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_mark` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_scan` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_revision` WHERE `cache_id` = OLD.`id`;
	DELETE FROM `garbage_collection_tenant_run` WHERE `cache_id` = OLD.`id`;
END;

--> statement-breakpoint
CREATE TABLE `grant_contraction` (
 `id` integer PRIMARY KEY NOT NULL,
 `complete` integer DEFAULT false NOT NULL,
 CONSTRAINT "grant_contraction_singleton_check" CHECK (id = 1)
);
--> statement-breakpoint
INSERT INTO grant_contraction (id, complete) VALUES (1, false);

--> statement-breakpoint
CREATE TRIGGER oidc_trust_native_grants_insert
BEFORE INSERT ON oidc_trust
WHEN (SELECT complete FROM grant_contraction WHERE id = 1) = 1
 AND EXISTS (
  SELECT 1 FROM json_each(NEW.permitted_grants_json) AS grant
  WHERE json_extract(grant.value, '$.type') = 'cupboard_cache'
   AND json_extract(grant.value, '$.resources.cache.kind') IS NULL
 )
BEGIN
 SELECT RAISE(ABORT, 'cache grants require scope spelling after contraction');
END;

--> statement-breakpoint
CREATE TRIGGER oidc_trust_native_grants_update
BEFORE UPDATE ON oidc_trust
WHEN (SELECT complete FROM grant_contraction WHERE id = 1) = 1
 AND EXISTS (
  SELECT 1 FROM json_each(NEW.permitted_grants_json) AS grant
  WHERE json_extract(grant.value, '$.type') = 'cupboard_cache'
   AND json_extract(grant.value, '$.resources.cache.kind') IS NULL
 )
BEGIN
 SELECT RAISE(ABORT, 'cache grants require scope spelling after contraction');
END;

--> statement-breakpoint
CREATE TRIGGER refresh_token_family_native_grants_insert
BEFORE INSERT ON refresh_token_family
WHEN (SELECT complete FROM grant_contraction WHERE id = 1) = 1
 AND EXISTS (
  SELECT 1 FROM json_each(NEW.grants_json) AS grant
  WHERE json_extract(grant.value, '$.type') = 'cupboard_cache'
   AND json_extract(grant.value, '$.cache.kind') IS NULL
 )
BEGIN
 SELECT RAISE(ABORT, 'cache grants require scope spelling after contraction');
END;

--> statement-breakpoint
CREATE TRIGGER refresh_token_family_native_grants_update
BEFORE UPDATE ON refresh_token_family
WHEN (SELECT complete FROM grant_contraction WHERE id = 1) = 1
 AND EXISTS (
  SELECT 1 FROM json_each(NEW.grants_json) AS grant
  WHERE json_extract(grant.value, '$.type') = 'cupboard_cache'
   AND json_extract(grant.value, '$.cache.kind') IS NULL
 )
BEGIN
 SELECT RAISE(ABORT, 'cache grants require scope spelling after contraction');
END;

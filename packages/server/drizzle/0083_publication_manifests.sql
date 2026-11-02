CREATE TABLE `publication_manifest_cardinality` (
 `kind` text NOT NULL,
 `id` text NOT NULL,
 `member_count` integer DEFAULT 0 NOT NULL,
 `valid` integer DEFAULT true NOT NULL,
 PRIMARY KEY(`kind`,`id`)
);
--> statement-breakpoint
CREATE TABLE `publication_manifest_work_hold` (
 `operation_id` text NOT NULL,
 `publication_id` text NOT NULL,
 `cache_id` integer NOT NULL,
 `cache_generation` integer NOT NULL,
 `store_path_hash` text NOT NULL,
 `store_path` text NOT NULL,
 `nar_hash` text NOT NULL,
 `generation` integer NOT NULL,
 PRIMARY KEY(`operation_id`,`publication_id`)
);
--> statement-breakpoint
CREATE INDEX `publication_manifest_work_hold_path_idx` ON `publication_manifest_work_hold` (`cache_id`,`store_path_hash`,`generation`,`operation_id`);
--> statement-breakpoint
CREATE TABLE `publication_manifest_admission` (
 `operation_id` text PRIMARY KEY NOT NULL,
 `destination_kind` text NOT NULL,
 `destination_name` text,
 `cache_generation` integer NOT NULL,
 `cache_id` integer,
 `canonical_json` text NOT NULL,
 `push_id` text NOT NULL,
 `expires_at` text NOT NULL,
 `prune_after` text NOT NULL,
 CONSTRAINT "publication_manifest_admission_destination_check" CHECK(("publication_manifest_admission"."destination_kind" = 'default' AND "publication_manifest_admission"."destination_name" IS NULL) OR ("publication_manifest_admission"."destination_kind" = 'named' AND "publication_manifest_admission"."destination_name" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `publication_manifest_admission_prune_idx` ON `publication_manifest_admission` (`prune_after`,`operation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_manifest_admission_push_idx` ON `publication_manifest_admission` (`push_id`);
--> statement-breakpoint
CREATE TABLE `publication_manifest_member` (
	`digest` text NOT NULL,
	`ordinal` integer NOT NULL,
	`store_path` text NOT NULL,
	`store_path_hash` text NOT NULL,
	`nar_hash` text NOT NULL,
	PRIMARY KEY(`digest`, `ordinal`),
	CONSTRAINT "publication_manifest_member_ordinal_check" CHECK("publication_manifest_member"."ordinal" BETWEEN 0 AND 99999)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_manifest_member_path_idx` ON `publication_manifest_member` (`digest`,`store_path`);--> statement-breakpoint
CREATE TABLE `publication_manifest_operation_page` (
	`operation_id` text NOT NULL,
	`page` integer NOT NULL,
	`payload_digest` text NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`operation_id`, `page`),
	CONSTRAINT "publication_manifest_operation_page_check" CHECK("publication_manifest_operation_page"."page" >= 0)
);
--> statement-breakpoint
CREATE TABLE `publication_manifest_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`cache_id` integer NOT NULL,
	`cache_generation` integer NOT NULL,
	`canonical_json` text NOT NULL,
	`result_identity_json` text NOT NULL,
	`source_json` text,
	`origin` text NOT NULL,
	`expected_count` integer NOT NULL,
	`next_page` integer DEFAULT 0 NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`phase` text DEFAULT 'intake' NOT NULL,
	`candidate_digest` text,
	`progress_json` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`result_json` text,
	`failure_json` text,
	CONSTRAINT "publication_manifest_operation_phase_check" CHECK("publication_manifest_operation"."phase" IN ('intake', 'sealing', 'publishing')),
	CONSTRAINT "publication_manifest_operation_count_check" CHECK("publication_manifest_operation"."expected_count" BETWEEN 1 AND 100000),
	CONSTRAINT "publication_manifest_operation_progress_check" CHECK("publication_manifest_operation"."next_page" >= 0 AND "publication_manifest_operation"."cursor" BETWEEN 0 AND "publication_manifest_operation"."expected_count")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_manifest_operation_request_idx` ON `publication_manifest_operation` (`cache_id`,`cache_generation`,`kind`,`request_id`);--> statement-breakpoint
CREATE INDEX `publication_manifest_operation_expiry_idx` ON `publication_manifest_operation` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `publication_manifest_operation_candidate_digest_idx` ON `publication_manifest_operation` (`candidate_digest`,`state`,`id`);--> statement-breakpoint
CREATE TABLE `publication_manifest` (
	`digest` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`member_count` integer NOT NULL,
	CONSTRAINT "publication_manifest_version_check" CHECK("publication_manifest"."version" = 1),
	CONSTRAINT "publication_manifest_count_check" CHECK("publication_manifest"."member_count" BETWEEN 1 AND 100000)
);
--> statement-breakpoint
CREATE TABLE `result_publication_member` (
	`cache_id` integer NOT NULL,
	`cache_generation` integer NOT NULL,
	`result_hash` text NOT NULL,
	`result_generation` integer NOT NULL,
	`materialisation_id` text NOT NULL,
	`member_hash` text NOT NULL,
	`member_path` text NOT NULL,
	`member_nar_hash` text NOT NULL,
	`member_generation` integer NOT NULL,
 `availability_revision` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`cache_id`, `cache_generation`, `result_hash`, `result_generation`, `materialisation_id`, `member_hash`)
);
--> statement-breakpoint
CREATE INDEX `result_publication_member_reverse_idx` ON `result_publication_member` (`cache_id`,`cache_generation`,`member_hash`,`member_generation`,`member_path`,`member_nar_hash`,`materialisation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `result_publication_member_candidate_path_idx` ON `result_publication_member` (`materialisation_id`,`member_path`);--> statement-breakpoint
CREATE TABLE `result_publication` (
	`cache_id` integer NOT NULL,
	`cache_generation` integer NOT NULL,
	`result_hash` text NOT NULL,
	`result_path` text NOT NULL,
	`result_generation` integer NOT NULL,
	`result_nar_hash` text NOT NULL,
	`digest` text NOT NULL,
	`materialisation_id` text NOT NULL,
	`origin` text NOT NULL,
	`complete` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`cache_id`, `cache_generation`, `result_hash`, `result_generation`),
	CONSTRAINT "result_publication_origin_check" CHECK("result_publication"."origin" IN ('build-selection', 'legacy-selection'))
);
--> statement-breakpoint
CREATE INDEX `result_publication_digest_idx` ON `result_publication` (`digest`);
--> statement-breakpoint
CREATE INDEX `result_publication_materialisation_idx` ON `result_publication` (`materialisation_id`);
--> statement-breakpoint
CREATE TABLE `publication_manifest_retirement` (
	`materialisation_id` text PRIMARY KEY NOT NULL,
	`digest` text
);
--> statement-breakpoint
ALTER TABLE `garbage_collection_scan` ADD `mark_edge_phase` text DEFAULT 'references' NOT NULL;
--> statement-breakpoint
ALTER TABLE `garbage_collection_scan` ADD `association_member_cursor` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `garbage_collection_scan` ADD `association_materialisation_id` text;
--> statement-breakpoint
ALTER TABLE `garbage_collection_scan` ADD `association_cache_generation` integer;
--> statement-breakpoint
ALTER TABLE `garbage_collection_scan` ADD `association_result_generation` integer;
--> statement-breakpoint
-- Exact local mutations install constant-size fences, never reverse fan-out.
-- The mirror survives REPLACE's implicit delete, with either trigger setting.
-- A deleted identity remains only until its bounded intent is reclaimed.
-- AFTER INSERT excludes ignored conflicts and identical/ordinary publication.
-- Legacy rows need no startup backfill. Preparation copies at most one real
-- old identity and never advances a proof fence, even on an ignored conflict.
CREATE TRIGGER `result_publication_narinfo_prepare_insert`
BEFORE INSERT ON `narinfo`
BEGIN
 INSERT INTO `publication_manifest_local_identity` (`cache_id`,`store_path_hash`,`generation`,`store_path`,`nar_hash`)
 SELECT n.`cache_id`,n.`store_path_hash`,n.`generation`,n.`store_path`,n.`nar_hash`
 FROM `narinfo` AS n
 WHERE n.`cache_id` = NEW.`cache_id` AND n.`store_path_hash` = NEW.`store_path_hash`
 AND NOT EXISTS (SELECT 1 FROM `publication_manifest_local_identity` AS v
  WHERE v.`cache_id` = NEW.`cache_id` AND v.`store_path_hash` = NEW.`store_path_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `result_publication_narinfo_prepare_update`
BEFORE UPDATE OF `cache_id`,`store_path_hash`,`store_path`,`nar_hash`,`generation` ON `narinfo`
BEGIN
 INSERT INTO `publication_manifest_local_identity` (`cache_id`,`store_path_hash`,`generation`,`store_path`,`nar_hash`)
 SELECT n.`cache_id`,n.`store_path_hash`,n.`generation`,n.`store_path`,n.`nar_hash`
 FROM `narinfo` AS n
 WHERE n.`cache_id` = NEW.`cache_id` AND n.`store_path_hash` = NEW.`store_path_hash`
 AND NOT EXISTS (SELECT 1 FROM `publication_manifest_local_identity` AS v
  WHERE v.`cache_id` = NEW.`cache_id` AND v.`store_path_hash` = NEW.`store_path_hash`);
END;
--> statement-breakpoint
-- Ignore only full-row replays before REPLACE can delete the accepted result.
-- Metadata-changing writes must still reach normal conflict handling.
CREATE TRIGGER `result_publication_narinfo_identical_insert`
BEFORE INSERT ON `narinfo`
WHEN EXISTS (
 SELECT 1 FROM `narinfo`
 WHERE `cache_id` IS NEW.`cache_id`
 AND `store_path_hash` IS NEW.`store_path_hash`
 AND `store_path` IS NEW.`store_path`
 AND `nar_hash` IS NEW.`nar_hash`
 AND `nar_size` IS NEW.`nar_size`
 AND `references_json` IS NEW.`references_json`
 AND `deriver` IS NEW.`deriver`
 AND `ca` IS NEW.`ca`
 AND `sigs_json` IS NEW.`sigs_json`
 AND `generation` IS NEW.`generation`
 AND `signature_generation` IS NEW.`signature_generation`
 AND `pending_signature_generation` IS NEW.`pending_signature_generation`
 AND `created_at` IS NEW.`created_at`
 AND `retention_epoch` IS NEW.`retention_epoch`
 AND `inheritance_exhausted` IS NEW.`inheritance_exhausted`
)
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER `result_publication_narinfo_delete`
AFTER DELETE ON `narinfo`
BEGIN
 UPDATE `publication_manifest_availability_clock` SET `revision` = `revision` + 1
 WHERE `id` = 1 AND EXISTS (SELECT 1 FROM (SELECT OLD.`cache_id` AS `cache_id`,OLD.`store_path_hash` AS `store_path_hash`,OLD.`generation` AS `generation`,OLD.`store_path` AS `store_path`,OLD.`nar_hash` AS `nar_hash`) AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE 1);
 INSERT INTO `publication_manifest_availability_revision` (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`,`revision`)
 SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash`,(SELECT `revision` FROM `publication_manifest_availability_clock` WHERE `id` = 1) FROM (SELECT OLD.`cache_id` AS `cache_id`,OLD.`store_path_hash` AS `store_path_hash`,OLD.`generation` AS `generation`,OLD.`store_path` AS `store_path`,OLD.`nar_hash` AS `nar_hash`) AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE 1
 ON CONFLICT (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`) DO UPDATE SET `revision` = excluded.`revision`;
 INSERT INTO `publication_manifest_availability_intent` (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`,`revision`,`kind`,`remote_pending`)
 SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash`,(SELECT `revision` FROM `publication_manifest_availability_clock` WHERE `id` = 1),'local',0 FROM (SELECT OLD.`cache_id` AS `cache_id`,OLD.`store_path_hash` AS `store_path_hash`,OLD.`generation` AS `generation`,OLD.`store_path` AS `store_path`,OLD.`nar_hash` AS `nar_hash`) AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE 1;
 DELETE FROM `result_publication`
 WHERE (`cache_id`,`cache_generation`,`result_hash`,`result_generation`,`result_path`,`result_nar_hash`) =
 (SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash` FROM (SELECT OLD.`cache_id` AS `cache_id`,OLD.`store_path_hash` AS `store_path_hash`,OLD.`generation` AS `generation`,OLD.`store_path` AS `store_path`,OLD.`nar_hash` AS `nar_hash`) AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE 1);
END;
--> statement-breakpoint
-- AFTER UPDATE excludes ignored conflicts and also observes UPDATE OR REPLACE.
CREATE TRIGGER `result_publication_narinfo_update`
AFTER UPDATE OF `cache_id`,`store_path_hash`,`store_path`,`nar_hash`,`generation` ON `narinfo`
WHEN OLD.`cache_id` IS NOT NEW.`cache_id` OR OLD.`store_path_hash` IS NOT NEW.`store_path_hash` OR OLD.`store_path` IS NOT NEW.`store_path` OR OLD.`nar_hash` IS NOT NEW.`nar_hash` OR OLD.`generation` IS NOT NEW.`generation`
BEGIN
 UPDATE `publication_manifest_availability_clock` SET `revision` = `revision` + 1
 WHERE `id` = 1 AND EXISTS (SELECT 1 FROM (SELECT OLD.`cache_id` AS `cache_id`,OLD.`store_path_hash` AS `store_path_hash`,OLD.`generation` AS `generation`,OLD.`store_path` AS `store_path`,OLD.`nar_hash` AS `nar_hash`) AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE 1);
 INSERT INTO `publication_manifest_availability_revision` (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`,`revision`)
 SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash`,(SELECT `revision` FROM `publication_manifest_availability_clock` WHERE `id` = 1) FROM (SELECT OLD.`cache_id` AS `cache_id`,OLD.`store_path_hash` AS `store_path_hash`,OLD.`generation` AS `generation`,OLD.`store_path` AS `store_path`,OLD.`nar_hash` AS `nar_hash`) AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE 1
 ON CONFLICT (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`) DO UPDATE SET `revision` = excluded.`revision`;
 INSERT INTO `publication_manifest_availability_intent` (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`,`revision`,`kind`,`remote_pending`)
 SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash`,(SELECT `revision` FROM `publication_manifest_availability_clock` WHERE `id` = 1),'local',0 FROM (SELECT OLD.`cache_id` AS `cache_id`,OLD.`store_path_hash` AS `store_path_hash`,OLD.`generation` AS `generation`,OLD.`store_path` AS `store_path`,OLD.`nar_hash` AS `nar_hash`) AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE 1;
 DELETE FROM `result_publication`
 WHERE (`cache_id`,`cache_generation`,`result_hash`,`result_generation`,`result_path`,`result_nar_hash`) =
 (SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash` FROM (SELECT OLD.`cache_id` AS `cache_id`,OLD.`store_path_hash` AS `store_path_hash`,OLD.`generation` AS `generation`,OLD.`store_path` AS `store_path`,OLD.`nar_hash` AS `nar_hash`) AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE 1);
 DELETE FROM `publication_manifest_local_identity` WHERE `cache_id` = OLD.`cache_id` AND `store_path_hash` = OLD.`store_path_hash`;
 UPDATE `publication_manifest_availability_clock` SET `revision` = `revision` + 1
 WHERE `id` = 1 AND EXISTS (SELECT 1 FROM `publication_manifest_local_identity` AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE v.`cache_id` = NEW.`cache_id` AND v.`store_path_hash` = NEW.`store_path_hash` AND (v.`generation` IS NOT NEW.`generation` OR v.`store_path` IS NOT NEW.`store_path` OR v.`nar_hash` IS NOT NEW.`nar_hash`));
 INSERT INTO `publication_manifest_availability_revision` (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`,`revision`)
 SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash`,(SELECT `revision` FROM `publication_manifest_availability_clock` WHERE `id` = 1) FROM `publication_manifest_local_identity` AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE v.`cache_id` = NEW.`cache_id` AND v.`store_path_hash` = NEW.`store_path_hash` AND (v.`generation` IS NOT NEW.`generation` OR v.`store_path` IS NOT NEW.`store_path` OR v.`nar_hash` IS NOT NEW.`nar_hash`)
 ON CONFLICT (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`) DO UPDATE SET `revision` = excluded.`revision`;
 INSERT INTO `publication_manifest_availability_intent` (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`,`revision`,`kind`,`remote_pending`,`replacement_generation`,`replacement_path`,`replacement_nar_hash`)
 SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash`,(SELECT `revision` FROM `publication_manifest_availability_clock` WHERE `id` = 1),'local-replace',0,NEW.`generation`,NEW.`store_path`,NEW.`nar_hash` FROM `publication_manifest_local_identity` AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE v.`cache_id` = NEW.`cache_id` AND v.`store_path_hash` = NEW.`store_path_hash` AND (v.`generation` IS NOT NEW.`generation` OR v.`store_path` IS NOT NEW.`store_path` OR v.`nar_hash` IS NOT NEW.`nar_hash`);
 DELETE FROM `result_publication`
 WHERE (`cache_id`,`cache_generation`,`result_hash`,`result_generation`,`result_path`,`result_nar_hash`) =
 (SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash` FROM `publication_manifest_local_identity` AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE v.`cache_id` = NEW.`cache_id` AND v.`store_path_hash` = NEW.`store_path_hash` AND (v.`generation` IS NOT NEW.`generation` OR v.`store_path` IS NOT NEW.`store_path` OR v.`nar_hash` IS NOT NEW.`nar_hash`));
 INSERT INTO `publication_manifest_local_identity` (`cache_id`,`store_path_hash`,`generation`,`store_path`,`nar_hash`)
 VALUES (NEW.`cache_id`,NEW.`store_path_hash`,NEW.`generation`,NEW.`store_path`,NEW.`nar_hash`)
 ON CONFLICT (`cache_id`,`store_path_hash`) DO UPDATE SET `generation` = excluded.`generation`,`store_path` = excluded.`store_path`,`nar_hash` = excluded.`nar_hash`;
END;
--> statement-breakpoint
CREATE TRIGGER `result_publication_narinfo_insert`
AFTER INSERT ON `narinfo`
BEGIN
 UPDATE `publication_manifest_availability_clock` SET `revision` = `revision` + 1
 WHERE `id` = 1 AND EXISTS (SELECT 1 FROM `publication_manifest_local_identity` AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE v.`cache_id` = NEW.`cache_id` AND v.`store_path_hash` = NEW.`store_path_hash` AND (v.`generation` IS NOT NEW.`generation` OR v.`store_path` IS NOT NEW.`store_path` OR v.`nar_hash` IS NOT NEW.`nar_hash`));
 INSERT INTO `publication_manifest_availability_revision` (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`,`revision`)
 SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash`,(SELECT `revision` FROM `publication_manifest_availability_clock` WHERE `id` = 1) FROM `publication_manifest_local_identity` AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE v.`cache_id` = NEW.`cache_id` AND v.`store_path_hash` = NEW.`store_path_hash` AND (v.`generation` IS NOT NEW.`generation` OR v.`store_path` IS NOT NEW.`store_path` OR v.`nar_hash` IS NOT NEW.`nar_hash`)
 ON CONFLICT (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`) DO UPDATE SET `revision` = excluded.`revision`;
 INSERT INTO `publication_manifest_availability_intent` (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`,`revision`,`kind`,`remote_pending`,`replacement_generation`,`replacement_path`,`replacement_nar_hash`)
 SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash`,(SELECT `revision` FROM `publication_manifest_availability_clock` WHERE `id` = 1),'local-replace',0,NEW.`generation`,NEW.`store_path`,NEW.`nar_hash` FROM `publication_manifest_local_identity` AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE v.`cache_id` = NEW.`cache_id` AND v.`store_path_hash` = NEW.`store_path_hash` AND (v.`generation` IS NOT NEW.`generation` OR v.`store_path` IS NOT NEW.`store_path` OR v.`nar_hash` IS NOT NEW.`nar_hash`);
 DELETE FROM `result_publication`
 WHERE (`cache_id`,`cache_generation`,`result_hash`,`result_generation`,`result_path`,`result_nar_hash`) =
 (SELECT v.`cache_id`,c.`generation`,v.`store_path_hash`,v.`generation`,v.`store_path`,v.`nar_hash` FROM `publication_manifest_local_identity` AS v JOIN `cache_identity` AS c ON c.`id` = v.`cache_id` WHERE v.`cache_id` = NEW.`cache_id` AND v.`store_path_hash` = NEW.`store_path_hash` AND (v.`generation` IS NOT NEW.`generation` OR v.`store_path` IS NOT NEW.`store_path` OR v.`nar_hash` IS NOT NEW.`nar_hash`));
 INSERT INTO `publication_manifest_local_identity` (`cache_id`,`store_path_hash`,`generation`,`store_path`,`nar_hash`)
 VALUES (NEW.`cache_id`,NEW.`store_path_hash`,NEW.`generation`,NEW.`store_path`,NEW.`nar_hash`)
 ON CONFLICT (`cache_id`,`store_path_hash`) DO UPDATE SET `generation` = excluded.`generation`,`store_path` = excluded.`store_path`,`nar_hash` = excluded.`nar_hash`;
END;
--> statement-breakpoint
CREATE TRIGGER `result_publication_delete`
AFTER DELETE ON `result_publication`
BEGIN
	INSERT OR IGNORE INTO `publication_manifest_retirement` (`materialisation_id`, `digest`)
	VALUES (OLD.`materialisation_id`, OLD.`digest`);
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	SELECT OLD.`cache_id`, 1, NULL
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
-- Retiring a replaced selection is constant work, like association deletion.
-- The selected pointer index lets bounded cleanup protect live selections.
CREATE TRIGGER `result_publication_materialisation_update`
AFTER UPDATE OF `materialisation_id` ON `result_publication`
WHEN OLD.`materialisation_id` IS NOT NEW.`materialisation_id`
BEGIN
	INSERT OR IGNORE INTO `publication_manifest_retirement` (`materialisation_id`, `digest`)
	VALUES (OLD.`materialisation_id`, OLD.`digest`);
END;
--> statement-breakpoint
-- BEFORE also runs when OR IGNORE discards the row update.
CREATE TRIGGER `result_publication_cache_identity_update`
AFTER UPDATE OF `generation`,`deleted_at` ON `cache_identity`
WHEN OLD.`generation` IS NOT NEW.`generation` OR (OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL)
BEGIN
 UPDATE `publication_manifest_availability_clock`
 SET `lifecycle_revision` = `revision` + 1, `revision` = `revision` + 1 WHERE `id` = 1;
 INSERT INTO `publication_manifest_lifecycle_intent` (`revision`,`cache_id`,`cache_generation`)
 VALUES ((SELECT `revision` FROM `publication_manifest_availability_clock` WHERE `id` = 1),OLD.`id`,OLD.`generation`);
END;
--> statement-breakpoint
CREATE TRIGGER `result_publication_cache_identity_delete`
BEFORE DELETE ON `cache_identity`
BEGIN
 UPDATE `publication_manifest_availability_clock`
 SET `lifecycle_revision` = `revision` + 1, `revision` = `revision` + 1 WHERE `id` = 1;
 INSERT INTO `publication_manifest_lifecycle_intent` (`revision`,`cache_id`,`cache_generation`)
 VALUES ((SELECT `revision` FROM `publication_manifest_availability_clock` WHERE `id` = 1),OLD.`id`,OLD.`generation`);
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_result_publication_insert`
AFTER INSERT ON `result_publication`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	SELECT NEW.`cache_id`, 1, NULL
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_result_publication_update`
AFTER UPDATE ON `result_publication`
WHEN OLD.`cache_id` IS NOT NEW.`cache_id` OR
	OLD.`cache_generation` IS NOT NEW.`cache_generation` OR
	OLD.`result_hash` IS NOT NEW.`result_hash` OR
	OLD.`result_generation` IS NOT NEW.`result_generation` OR
	OLD.`materialisation_id` IS NOT NEW.`materialisation_id` OR
	OLD.`result_path` IS NOT NEW.`result_path` OR
	OLD.`result_nar_hash` IS NOT NEW.`result_nar_hash` OR
	OLD.`complete` IS NOT NEW.`complete`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	SELECT NEW.`cache_id`, 1, NULL
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_result_publication_member_insert`
AFTER INSERT ON `result_publication_member`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	SELECT NEW.`cache_id`, 1, NULL WHERE EXISTS (SELECT 1 FROM `result_publication` AS r
	JOIN `cache_identity` AS c ON c.`id` = r.`cache_id` AND c.`generation` = r.`cache_generation` AND c.`deleted_at` IS NULL
	JOIN `narinfo` AS owner ON owner.`cache_id` = r.`cache_id` AND owner.`store_path_hash` = r.`result_hash`
		AND owner.`store_path` = r.`result_path` AND owner.`nar_hash` = r.`result_nar_hash` AND owner.`generation` = r.`result_generation`
	WHERE r.`cache_id` = NEW.`cache_id` AND r.`cache_generation` = NEW.`cache_generation` AND r.`result_hash` = NEW.`result_hash` AND r.`result_generation` = NEW.`result_generation` AND r.`materialisation_id` = NEW.`materialisation_id`)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_result_publication_member_update`
AFTER UPDATE ON `result_publication_member`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	SELECT NEW.`cache_id`, 1, NULL WHERE EXISTS (SELECT 1 FROM `result_publication` AS r
	JOIN `cache_identity` AS c ON c.`id` = r.`cache_id` AND c.`generation` = r.`cache_generation` AND c.`deleted_at` IS NULL
	JOIN `narinfo` AS owner ON owner.`cache_id` = r.`cache_id` AND owner.`store_path_hash` = r.`result_hash`
		AND owner.`store_path` = r.`result_path` AND owner.`nar_hash` = r.`result_nar_hash` AND owner.`generation` = r.`result_generation`
	WHERE r.`cache_id` = NEW.`cache_id` AND r.`cache_generation` = NEW.`cache_generation` AND r.`result_hash` = NEW.`result_hash` AND r.`result_generation` = NEW.`result_generation` AND r.`materialisation_id` = NEW.`materialisation_id`)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	SELECT OLD.`cache_id`, 1, NULL WHERE EXISTS (SELECT 1 FROM `result_publication` AS r
	JOIN `cache_identity` AS c ON c.`id` = r.`cache_id` AND c.`generation` = r.`cache_generation` AND c.`deleted_at` IS NULL
	JOIN `narinfo` AS owner ON owner.`cache_id` = r.`cache_id` AND owner.`store_path_hash` = r.`result_hash`
		AND owner.`store_path` = r.`result_path` AND owner.`nar_hash` = r.`result_nar_hash` AND owner.`generation` = r.`result_generation`
	WHERE r.`cache_id` = OLD.`cache_id` AND r.`cache_generation` = OLD.`cache_generation` AND r.`result_hash` = OLD.`result_hash` AND r.`result_generation` = OLD.`result_generation` AND r.`materialisation_id` = OLD.`materialisation_id`) AND (OLD.`cache_id` IS NOT NEW.`cache_id` OR NOT EXISTS (SELECT 1 FROM `result_publication` AS r
	JOIN `cache_identity` AS c ON c.`id` = r.`cache_id` AND c.`generation` = r.`cache_generation` AND c.`deleted_at` IS NULL
	JOIN `narinfo` AS owner ON owner.`cache_id` = r.`cache_id` AND owner.`store_path_hash` = r.`result_hash`
		AND owner.`store_path` = r.`result_path` AND owner.`nar_hash` = r.`result_nar_hash` AND owner.`generation` = r.`result_generation`
	WHERE r.`cache_id` = NEW.`cache_id` AND r.`cache_generation` = NEW.`cache_generation` AND r.`result_hash` = NEW.`result_hash` AND r.`result_generation` = NEW.`result_generation` AND r.`materialisation_id` = NEW.`materialisation_id`))
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `garbage_collection_input_result_publication_member_delete`
AFTER DELETE ON `result_publication_member`
BEGIN
	INSERT INTO `garbage_collection_input` (`cache_id`, `inputs_changed`, `scan_completed_at`)
	SELECT OLD.`cache_id`, 1, NULL WHERE EXISTS (SELECT 1 FROM `result_publication` AS r
	JOIN `cache_identity` AS c ON c.`id` = r.`cache_id` AND c.`generation` = r.`cache_generation` AND c.`deleted_at` IS NULL
	JOIN `narinfo` AS owner ON owner.`cache_id` = r.`cache_id` AND owner.`store_path_hash` = r.`result_hash`
		AND owner.`store_path` = r.`result_path` AND owner.`nar_hash` = r.`result_nar_hash` AND owner.`generation` = r.`result_generation`
	WHERE r.`cache_id` = OLD.`cache_id` AND r.`cache_generation` = OLD.`cache_generation` AND r.`result_hash` = OLD.`result_hash` AND r.`result_generation` = OLD.`result_generation` AND r.`materialisation_id` = OLD.`materialisation_id`)
	ON CONFLICT (`cache_id`) DO UPDATE SET `inputs_changed` = 1 WHERE NOT `inputs_changed`;
END;
--> statement-breakpoint
CREATE TRIGGER `result_publication_barrier_member_insert`
AFTER INSERT ON `result_publication_member`
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	SELECT r.`cache_id`, NEW.`member_hash`
	FROM `result_publication` AS r
	JOIN `cache_identity` AS c ON c.`id` = r.`cache_id` AND c.`generation` = r.`cache_generation` AND c.`deleted_at` IS NULL
	JOIN `narinfo` AS owner ON owner.`cache_id` = r.`cache_id` AND owner.`store_path_hash` = r.`result_hash`
		AND owner.`store_path` = r.`result_path` AND owner.`nar_hash` = r.`result_nar_hash` AND owner.`generation` = r.`result_generation`
	JOIN `narinfo` AS member ON member.`cache_id` = NEW.`cache_id` AND member.`store_path_hash` = NEW.`member_hash`
		AND member.`store_path` = NEW.`member_path` AND member.`nar_hash` = NEW.`member_nar_hash` AND member.`generation` = NEW.`member_generation`
	WHERE r.`cache_id` = NEW.`cache_id` AND r.`cache_generation` = NEW.`cache_generation` AND r.`result_hash` = NEW.`result_hash` AND r.`result_generation` = NEW.`result_generation` AND r.`materialisation_id` = NEW.`materialisation_id`
		AND EXISTS (SELECT 1 FROM `garbage_collection_scan` WHERE `cache_id` = r.`cache_id`)
		AND EXISTS (SELECT 1 FROM `garbage_collection_mark` WHERE `cache_id` = r.`cache_id` AND `store_path_hash` = r.`result_hash`)
		AND NOT EXISTS (SELECT 1 FROM `garbage_collection_mark` WHERE `cache_id` = r.`cache_id` AND `store_path_hash` = NEW.`member_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `result_publication_barrier_member_update`
AFTER UPDATE ON `result_publication_member`
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	SELECT r.`cache_id`, NEW.`member_hash`
	FROM `result_publication` AS r
	JOIN `cache_identity` AS c ON c.`id` = r.`cache_id` AND c.`generation` = r.`cache_generation` AND c.`deleted_at` IS NULL
	JOIN `narinfo` AS owner ON owner.`cache_id` = r.`cache_id` AND owner.`store_path_hash` = r.`result_hash`
		AND owner.`store_path` = r.`result_path` AND owner.`nar_hash` = r.`result_nar_hash` AND owner.`generation` = r.`result_generation`
	JOIN `narinfo` AS member ON member.`cache_id` = NEW.`cache_id` AND member.`store_path_hash` = NEW.`member_hash`
		AND member.`store_path` = NEW.`member_path` AND member.`nar_hash` = NEW.`member_nar_hash` AND member.`generation` = NEW.`member_generation`
	WHERE r.`cache_id` = NEW.`cache_id` AND r.`cache_generation` = NEW.`cache_generation` AND r.`result_hash` = NEW.`result_hash` AND r.`result_generation` = NEW.`result_generation` AND r.`materialisation_id` = NEW.`materialisation_id`
		AND EXISTS (SELECT 1 FROM `garbage_collection_scan` WHERE `cache_id` = r.`cache_id`)
		AND EXISTS (SELECT 1 FROM `garbage_collection_mark` WHERE `cache_id` = r.`cache_id` AND `store_path_hash` = r.`result_hash`)
		AND NOT EXISTS (SELECT 1 FROM `garbage_collection_mark` WHERE `cache_id` = r.`cache_id` AND `store_path_hash` = NEW.`member_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `result_publication_barrier_insert`
AFTER INSERT ON `result_publication`
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	SELECT r.`cache_id`, r.`result_hash`
	FROM `result_publication` AS r
	JOIN `cache_identity` AS c ON c.`id` = r.`cache_id` AND c.`generation` = r.`cache_generation` AND c.`deleted_at` IS NULL
	JOIN `narinfo` AS owner ON owner.`cache_id` = r.`cache_id` AND owner.`store_path_hash` = r.`result_hash`
		AND owner.`store_path` = r.`result_path` AND owner.`nar_hash` = r.`result_nar_hash` AND owner.`generation` = r.`result_generation`
	WHERE r.`cache_id` = NEW.`cache_id` AND r.`cache_generation` = NEW.`cache_generation` AND r.`result_hash` = NEW.`result_hash` AND r.`result_generation` = NEW.`result_generation` AND r.`materialisation_id` = NEW.`materialisation_id`
		AND EXISTS (SELECT 1 FROM `garbage_collection_scan` WHERE `cache_id` = r.`cache_id`)
		AND EXISTS (SELECT 1 FROM `garbage_collection_mark` WHERE `cache_id` = r.`cache_id` AND `store_path_hash` = r.`result_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `result_publication_barrier_update`
AFTER UPDATE ON `result_publication`
WHEN OLD.`cache_id` IS NOT NEW.`cache_id` OR
	OLD.`cache_generation` IS NOT NEW.`cache_generation` OR
	OLD.`result_hash` IS NOT NEW.`result_hash` OR
	OLD.`result_generation` IS NOT NEW.`result_generation` OR
	OLD.`materialisation_id` IS NOT NEW.`materialisation_id` OR
	OLD.`result_path` IS NOT NEW.`result_path` OR
	OLD.`result_nar_hash` IS NOT NEW.`result_nar_hash` OR (NEW.`complete` AND NOT OLD.`complete`)
BEGIN
	INSERT OR IGNORE INTO `garbage_collection_frontier` (`cache_id`, `store_path_hash`)
	SELECT r.`cache_id`, r.`result_hash`
	FROM `result_publication` AS r
	JOIN `cache_identity` AS c ON c.`id` = r.`cache_id` AND c.`generation` = r.`cache_generation` AND c.`deleted_at` IS NULL
	JOIN `narinfo` AS owner ON owner.`cache_id` = r.`cache_id` AND owner.`store_path_hash` = r.`result_hash`
		AND owner.`store_path` = r.`result_path` AND owner.`nar_hash` = r.`result_nar_hash` AND owner.`generation` = r.`result_generation`
	WHERE r.`cache_id` = NEW.`cache_id` AND r.`cache_generation` = NEW.`cache_generation` AND r.`result_hash` = NEW.`result_hash` AND r.`result_generation` = NEW.`result_generation` AND r.`materialisation_id` = NEW.`materialisation_id`
		AND EXISTS (SELECT 1 FROM `garbage_collection_scan` WHERE `cache_id` = r.`cache_id`)
		AND EXISTS (SELECT 1 FROM `garbage_collection_mark` WHERE `cache_id` = r.`cache_id` AND `store_path_hash` = r.`result_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER `publication_manifest_immutable_update`
BEFORE UPDATE ON `publication_manifest`
BEGIN
	SELECT RAISE(ABORT, 'publication manifest content is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `publication_manifest_member_immutable_update`
BEFORE UPDATE ON `publication_manifest_member`
BEGIN
	SELECT RAISE(ABORT, 'publication manifest content is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `publication_manifest_operation_page_immutable_update`
BEFORE UPDATE ON `publication_manifest_operation_page`
BEGIN
	SELECT RAISE(ABORT, 'publication manifest content is immutable');
END;
--> statement-breakpoint
-- Immutable payloads must also reject changed REPLACE writes. Identical
-- inserts may use normal conflict handling; changed replays fail explicitly.
CREATE TRIGGER `publication_manifest_immutable_insert`
BEFORE INSERT ON `publication_manifest`
WHEN EXISTS (
	SELECT 1 FROM `publication_manifest` WHERE `digest` = NEW.`digest`
		AND (`version` IS NOT NEW.`version` OR `member_count` IS NOT NEW.`member_count`)
)
BEGIN
	SELECT RAISE(ABORT, 'publication manifest content is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `publication_manifest_member_immutable_insert`
BEFORE INSERT ON `publication_manifest_member`
WHEN EXISTS (
	SELECT 1 FROM `publication_manifest_member` WHERE `digest` = NEW.`digest` AND `ordinal` = NEW.`ordinal`
		AND (`store_path` IS NOT NEW.`store_path` OR `store_path_hash` IS NOT NEW.`store_path_hash` OR `nar_hash` IS NOT NEW.`nar_hash`)
) OR EXISTS (
	SELECT 1 FROM `publication_manifest_member` WHERE `digest` = NEW.`digest` AND `store_path` = NEW.`store_path`
		AND `ordinal` IS NOT NEW.`ordinal`
)
BEGIN
	SELECT RAISE(ABORT, 'publication manifest content is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `publication_manifest_operation_page_immutable_insert`
BEFORE INSERT ON `publication_manifest_operation_page`
WHEN EXISTS (
	SELECT 1 FROM `publication_manifest_operation_page` WHERE `operation_id` = NEW.`operation_id` AND `page` = NEW.`page`
		AND (`payload_digest` IS NOT NEW.`payload_digest` OR `payload_json` IS NOT NEW.`payload_json`)
)
BEGIN
	SELECT RAISE(ABORT, 'publication manifest content is immutable');
END;

--> statement-breakpoint
CREATE TRIGGER `publication_manifest_operation_cardinality_insert`
AFTER INSERT ON `publication_manifest_operation`
BEGIN
 INSERT INTO `publication_manifest_cardinality` (`kind`,`id`) VALUES ('candidate',NEW.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `publication_manifest_operation_cardinality_delete`
AFTER DELETE ON `publication_manifest_operation`
BEGIN
 DELETE FROM `publication_manifest_cardinality` WHERE `kind` = 'candidate' AND `id` = OLD.`id`;
END;

--> statement-breakpoint
CREATE TRIGGER `publication_manifest_cardinality_insert`
AFTER INSERT ON `publication_manifest`
BEGIN
 INSERT INTO `publication_manifest_cardinality` (`kind`,`id`) VALUES ('portable',NEW.`digest`);
END;
--> statement-breakpoint
CREATE TRIGGER `publication_manifest_cardinality_delete`
AFTER DELETE ON `publication_manifest`
BEGIN
 DELETE FROM `publication_manifest_cardinality` WHERE `kind` = 'portable' AND `id` = OLD.`digest`;
END;

--> statement-breakpoint
CREATE TRIGGER `result_publication_member_cardinality_insert`
AFTER INSERT ON `result_publication_member`
BEGIN
 UPDATE `publication_manifest_cardinality` SET `member_count` = `member_count` + 1
 WHERE `kind` = 'candidate' AND `id` = NEW.`materialisation_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `result_publication_member_cardinality_delete`
AFTER DELETE ON `result_publication_member`
BEGIN
 UPDATE `publication_manifest_cardinality` SET `member_count` = `member_count` - 1, `valid` = 0
 WHERE `kind` = 'candidate' AND `id` = OLD.`materialisation_id`;
END;

--> statement-breakpoint
CREATE TRIGGER `publication_manifest_member_cardinality_insert`
AFTER INSERT ON `publication_manifest_member`
BEGIN
 UPDATE `publication_manifest_cardinality` SET `member_count` = `member_count` + 1
 WHERE `kind` = 'portable' AND `id` = NEW.`digest`;
END;
--> statement-breakpoint
CREATE TRIGGER `publication_manifest_member_cardinality_delete`
AFTER DELETE ON `publication_manifest_member`
BEGIN
 UPDATE `publication_manifest_cardinality` SET `member_count` = `member_count` - 1, `valid` = 0
 WHERE `kind` = 'portable' AND `id` = OLD.`digest`;
END;

--> statement-breakpoint
CREATE TRIGGER `result_publication_member_cardinality_update`
AFTER UPDATE ON `result_publication_member`
BEGIN
 UPDATE `publication_manifest_cardinality` SET `member_count` = `member_count` - 1, `valid` = 0
 WHERE `kind` = 'candidate' AND `id` = OLD.`materialisation_id`;
 UPDATE `publication_manifest_cardinality` SET `member_count` = `member_count` + 1, `valid` = 0
 WHERE `kind` = 'candidate' AND `id` = NEW.`materialisation_id`;
END;

--> statement-breakpoint
CREATE TRIGGER `publication_manifest_identical_insert`
BEFORE INSERT ON `publication_manifest`
WHEN EXISTS (SELECT 1 FROM `publication_manifest` WHERE `digest` = NEW.`digest` AND `version` = NEW.`version` AND `member_count` = NEW.`member_count`)
BEGIN
 SELECT RAISE(IGNORE);
END;

--> statement-breakpoint
CREATE TRIGGER `publication_manifest_member_identical_insert`
BEFORE INSERT ON `publication_manifest_member`
WHEN EXISTS (SELECT 1 FROM `publication_manifest_member` WHERE `digest` = NEW.`digest` AND `ordinal` = NEW.`ordinal` AND `store_path` = NEW.`store_path` AND `store_path_hash` = NEW.`store_path_hash` AND `nar_hash` = NEW.`nar_hash`)
BEGIN
 SELECT RAISE(IGNORE);
END;

--> statement-breakpoint
CREATE TRIGGER `result_publication_member_identical_insert`
BEFORE INSERT ON `result_publication_member`
WHEN EXISTS (SELECT 1 FROM `result_publication_member` WHERE `cache_id` = NEW.`cache_id` AND `cache_generation` = NEW.`cache_generation` AND `result_hash` = NEW.`result_hash` AND `result_generation` = NEW.`result_generation` AND `materialisation_id` = NEW.`materialisation_id` AND `member_hash` = NEW.`member_hash` AND `member_path` = NEW.`member_path` AND `member_nar_hash` = NEW.`member_nar_hash` AND `member_generation` = NEW.`member_generation` AND `availability_revision` = NEW.`availability_revision`)
BEGIN
 SELECT RAISE(IGNORE);
END;

--> statement-breakpoint
-- A changed REPLACE must not silently remove a proof with recursive triggers off.
CREATE TRIGGER `result_publication_member_immutable_insert`
BEFORE INSERT ON `result_publication_member`
WHEN EXISTS (SELECT 1 FROM `result_publication_member`
 WHERE `materialisation_id` = NEW.`materialisation_id`
 AND `member_path` = NEW.`member_path`
 AND (`cache_id` IS NOT NEW.`cache_id` OR `cache_generation` IS NOT NEW.`cache_generation`
 OR `result_hash` IS NOT NEW.`result_hash` OR `result_generation` IS NOT NEW.`result_generation`
 OR `member_hash` IS NOT NEW.`member_hash` OR `member_path` IS NOT NEW.`member_path`
 OR `member_nar_hash` IS NOT NEW.`member_nar_hash` OR `member_generation` IS NOT NEW.`member_generation` OR `availability_revision` IS NOT NEW.`availability_revision`))
OR EXISTS (SELECT 1 FROM `result_publication_member`
 WHERE `cache_id` = NEW.`cache_id` AND `cache_generation` = NEW.`cache_generation`
 AND `result_hash` = NEW.`result_hash` AND `result_generation` = NEW.`result_generation`
 AND `materialisation_id` = NEW.`materialisation_id` AND `member_hash` = NEW.`member_hash`
 AND (`member_path` IS NOT NEW.`member_path` OR `member_nar_hash` IS NOT NEW.`member_nar_hash`
 OR `member_generation` IS NOT NEW.`member_generation` OR `availability_revision` IS NOT NEW.`availability_revision`))
BEGIN
 SELECT RAISE(ABORT, 'publication manifest proof is immutable');
END;

--> statement-breakpoint
CREATE TRIGGER `result_publication_member_certificate_delete`
AFTER DELETE ON `result_publication_member`
BEGIN
 UPDATE `result_publication` SET `complete` = 0 WHERE `materialisation_id` = OLD.`materialisation_id` AND `complete`;
END;

--> statement-breakpoint
CREATE TRIGGER `result_publication_member_certificate_update`
AFTER UPDATE ON `result_publication_member`
BEGIN
 UPDATE `result_publication` SET `complete` = 0 WHERE `materialisation_id` IN (OLD.`materialisation_id`,NEW.`materialisation_id`) AND `complete`;
END;

--> statement-breakpoint
CREATE TRIGGER `publication_manifest_member_certificate_delete`
AFTER DELETE ON `publication_manifest_member`
BEGIN
 UPDATE `result_publication` SET `complete` = 0 WHERE `digest` = OLD.`digest` AND `complete`;
END;

--> statement-breakpoint
CREATE TABLE `publication_manifest_availability_clock` (
 `id` integer PRIMARY KEY NOT NULL,
 `revision` integer DEFAULT 0 NOT NULL,
 `lifecycle_revision` integer DEFAULT 0 NOT NULL,
 CONSTRAINT `publication_manifest_availability_clock_check` CHECK (`id` = 1 AND `revision` BETWEEN 0 AND 9007199254740991 AND `lifecycle_revision` BETWEEN 0 AND `revision`)
);
--> statement-breakpoint
INSERT INTO `publication_manifest_availability_clock` (`id`,`revision`) VALUES (1,0);
--> statement-breakpoint
CREATE TABLE `publication_manifest_availability_revision` (
 `cache_id` integer NOT NULL,
 `cache_generation` integer NOT NULL,
 `store_path_hash` text NOT NULL,
 `generation` integer NOT NULL,
 `store_path` text NOT NULL,
 `nar_hash` text NOT NULL,
 `revision` integer NOT NULL,
 PRIMARY KEY (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`)
);
--> statement-breakpoint
CREATE TABLE `publication_manifest_availability_intent` (
 `revision` integer PRIMARY KEY NOT NULL,
 `cache_id` integer NOT NULL,
 `cache_generation` integer NOT NULL,
 `store_path_hash` text NOT NULL,
 `generation` integer NOT NULL,
 `store_path` text NOT NULL,
 `nar_hash` text NOT NULL,
 `kind` text NOT NULL,
 `remote_pending` integer DEFAULT true NOT NULL,
 `cursor_materialisation_id` text,
 `cursor_member_generation` integer,
 `cursor_member_path` text,
 `cursor_member_nar_hash` text,
 `cursor_owner_generation` integer,
 `phase` text DEFAULT 'proofs' NOT NULL,
 `replacement_generation` integer,
 `replacement_path` text,
 `replacement_nar_hash` text,
 CONSTRAINT `publication_manifest_availability_intent_kind_check` CHECK ((`kind` IN ('demote','revoke') AND `remote_pending` IN (0,1)) OR (`kind` IN ('local','local-replace') AND `remote_pending` = 0))
);
--> statement-breakpoint
CREATE INDEX `publication_manifest_availability_intent_version_idx` ON `publication_manifest_availability_intent` (`cache_id`,`cache_generation`,`store_path_hash`,`generation`,`store_path`,`nar_hash`,`remote_pending`,`revision`);
--> statement-breakpoint
CREATE INDEX `publication_manifest_availability_intent_pending_idx` ON `publication_manifest_availability_intent` (`remote_pending`,`revision`);

--> statement-breakpoint
-- A mirror of actual accepted local identity, not a generation allocator.
CREATE TABLE `publication_manifest_local_identity` (
 `cache_id` integer NOT NULL,
 `store_path_hash` text NOT NULL,
 `generation` integer NOT NULL,
 `store_path` text NOT NULL,
 `nar_hash` text NOT NULL,
 PRIMARY KEY (`cache_id`,`store_path_hash`)
);
--> statement-breakpoint
CREATE TABLE `publication_manifest_lifecycle_intent` (
 `revision` integer PRIMARY KEY NOT NULL,
 `cache_id` integer NOT NULL,
 `cache_generation` integer NOT NULL,
 `cursor_result_hash` text,
 `cursor_result_generation` integer,
 `cursor_operation_id` text,
 `phase` text DEFAULT 'associations' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `publication_manifest_lifecycle_intent_scope_idx` ON `publication_manifest_lifecycle_intent` (`cache_id`,`cache_generation`,`revision`);
--> statement-breakpoint
CREATE INDEX `publication_manifest_operation_scope_idx` ON `publication_manifest_operation` (`cache_id`,`cache_generation`,`id`);

--> statement-breakpoint
ALTER TABLE `publication_operation` ADD `manifest_operation_id` text;

CREATE TABLE `cache_listing_projection_migration` (
	`id` integer PRIMARY KEY NOT NULL,
	`narinfo_initial_rowid_high_water` integer NOT NULL,
	`narinfo_cursor` integer NOT NULL,
	`narinfo_complete` integer DEFAULT false NOT NULL,
	`grace_initial_rowid_high_water` integer NOT NULL,
	`grace_cursor` integer NOT NULL,
	`grace_complete` integer DEFAULT false NOT NULL,
	CONSTRAINT "cache_listing_projection_migration_id_check" CHECK("cache_listing_projection_migration"."id" = 1),
	CONSTRAINT "cache_listing_projection_narinfo_cursor_check" CHECK("cache_listing_projection_migration"."narinfo_cursor" BETWEEN 0 AND "cache_listing_projection_migration"."narinfo_initial_rowid_high_water"),
	CONSTRAINT "cache_listing_projection_grace_cursor_check" CHECK("cache_listing_projection_migration"."grace_cursor" BETWEEN 0 AND "cache_listing_projection_migration"."grace_initial_rowid_high_water")
);
--> statement-breakpoint
CREATE TABLE `cache_narinfo_count` (
	`cache_id` integer PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	CONSTRAINT "cache_narinfo_count_nonnegative_check" CHECK("cache_narinfo_count"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `retention_grace_by_deadline` (
	`cache_id` integer NOT NULL,
	`retain_until` text NOT NULL,
	`store_path_hash` text NOT NULL,
	PRIMARY KEY(`cache_id`, `retain_until`, `store_path_hash`)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `cache_listing_projection_migration` (
	`id`,
	`narinfo_initial_rowid_high_water`,
	`narinfo_cursor`,
	`narinfo_complete`,
	`grace_initial_rowid_high_water`,
	`grace_cursor`,
	`grace_complete`
)
SELECT
	1,
	coalesce((SELECT max(rowid) FROM `narinfo`), 0),
	0,
	(SELECT max(rowid) IS NULL FROM `narinfo`),
	coalesce((SELECT max(rowid) FROM `retention_grace`), 0),
	0,
	(SELECT max(rowid) IS NULL FROM `retention_grace`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `cache_narinfo_count_insert`
AFTER INSERT ON `narinfo`
WHEN NEW.`cache_id` IS NOT NULL AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`narinfo_complete`
		OR NEW.rowid <= `narinfo_cursor`
		OR NEW.rowid > `narinfo_initial_rowid_high_water`
	)
)
BEGIN
	INSERT INTO `cache_narinfo_count` (`cache_id`, `count`)
	VALUES (NEW.`cache_id`, 1)
	ON CONFLICT (`cache_id`) DO UPDATE SET `count` = `count` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `cache_narinfo_count_delete`
AFTER DELETE ON `narinfo`
WHEN OLD.`cache_id` IS NOT NULL AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`narinfo_complete`
		OR OLD.rowid <= `narinfo_cursor`
		OR OLD.rowid > `narinfo_initial_rowid_high_water`
	)
)
BEGIN
	UPDATE `cache_narinfo_count`
	SET `count` = `count` - 1
	WHERE `cache_id` = OLD.`cache_id`;
	DELETE FROM `cache_narinfo_count`
	WHERE `cache_id` = OLD.`cache_id` AND `count` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `cache_narinfo_count_update_cache`
AFTER UPDATE OF `cache_id` ON `narinfo`
WHEN OLD.`cache_id` IS NOT NEW.`cache_id` AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`narinfo_complete`
		OR NEW.rowid <= `narinfo_cursor`
		OR NEW.rowid > `narinfo_initial_rowid_high_water`
	)
)
BEGIN
	UPDATE `cache_narinfo_count`
	SET `count` = `count` - 1
	WHERE OLD.`cache_id` IS NOT NULL AND `cache_id` = OLD.`cache_id`;
	DELETE FROM `cache_narinfo_count`
	WHERE OLD.`cache_id` IS NOT NULL AND `cache_id` = OLD.`cache_id` AND `count` = 0;
	INSERT INTO `cache_narinfo_count` (`cache_id`, `count`)
	SELECT NEW.`cache_id`, 1 WHERE NEW.`cache_id` IS NOT NULL
	ON CONFLICT (`cache_id`) DO UPDATE SET `count` = `count` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `retention_grace_by_deadline_insert`
AFTER INSERT ON `retention_grace`
WHEN NEW.`cache_id` IS NOT NULL AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`grace_complete`
		OR NEW.rowid <= `grace_cursor`
		OR NEW.rowid > `grace_initial_rowid_high_water`
	)
)
BEGIN
	INSERT OR REPLACE INTO `retention_grace_by_deadline` (`cache_id`, `retain_until`, `store_path_hash`)
	VALUES (NEW.`cache_id`, NEW.`retain_until`, NEW.`store_path_hash`);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `retention_grace_by_deadline_delete`
AFTER DELETE ON `retention_grace`
WHEN OLD.`cache_id` IS NOT NULL AND EXISTS (
	SELECT 1 FROM `cache_listing_projection_migration`
	WHERE `id` = 1 AND (
		`grace_complete`
		OR OLD.rowid <= `grace_cursor`
		OR OLD.rowid > `grace_initial_rowid_high_water`
	)
)
BEGIN
	DELETE FROM `retention_grace_by_deadline`
	WHERE `cache_id` = OLD.`cache_id`
		AND `retain_until` = OLD.`retain_until`
		AND `store_path_hash` = OLD.`store_path_hash`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `retention_grace_by_deadline_update`
AFTER UPDATE OF `cache_id`, `retain_until`, `store_path_hash` ON `retention_grace`
BEGIN
	DELETE FROM `retention_grace_by_deadline`
	WHERE `cache_id` = OLD.`cache_id`
		AND `retain_until` = OLD.`retain_until`
		AND `store_path_hash` = OLD.`store_path_hash`
		AND OLD.`cache_id` IS NOT NULL
		AND EXISTS (
			SELECT 1 FROM `cache_listing_projection_migration`
			WHERE `id` = 1 AND (
				`grace_complete`
				OR OLD.rowid <= `grace_cursor`
				OR OLD.rowid > `grace_initial_rowid_high_water`
			)
		);
	INSERT OR REPLACE INTO `retention_grace_by_deadline` (`cache_id`, `retain_until`, `store_path_hash`)
	SELECT NEW.`cache_id`, NEW.`retain_until`, NEW.`store_path_hash`
	WHERE NEW.`cache_id` IS NOT NULL AND EXISTS (
		SELECT 1 FROM `cache_listing_projection_migration`
		WHERE `id` = 1 AND (
			`grace_complete`
			OR NEW.rowid <= `grace_cursor`
			OR NEW.rowid > `grace_initial_rowid_high_water`
		)
	);
END;

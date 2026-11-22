CREATE TABLE `access_key_ancestor` (
	`ancestor_kind` text NOT NULL,
	`ancestor_id` text NOT NULL,
	`descendant_id` text NOT NULL,
	PRIMARY KEY(`ancestor_kind`, `ancestor_id`, `descendant_id`)
);
--> statement-breakpoint
CREATE INDEX `access_key_ancestor_descendant_idx` ON `access_key_ancestor` (`descendant_id`);--> statement-breakpoint
ALTER TABLE `refresh_session_family` ADD `replayed_at` text;--> statement-breakpoint
ALTER TABLE `refresh_session_family` ADD `retained_by_keys` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `refresh_session_family_collectable_idx` ON `refresh_session_family` (`expires_at`,`id`) WHERE "refresh_session_family"."retained_by_keys" = 0;--> statement-breakpoint
CREATE INDEX `refresh_session_family_retained_idx` ON `refresh_session_family` (`id`) WHERE "refresh_session_family"."retained_by_keys" = 1;--> statement-breakpoint
CREATE TABLE `access_key` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`grants_json` text NOT NULL,
	`parent_kind` text,
	`parent_id` text,
	`root_identity_json` text NOT NULL,
	`root_rule` text,
	`creator_subject` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text,
	`session_above` integer DEFAULT false NOT NULL,
	CONSTRAINT "access_key_parent_check" CHECK(("access_key"."parent_kind" IS NULL) = ("access_key"."parent_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `access_key_expires_at_idx` ON `access_key` (`expires_at`,`id`) WHERE "access_key"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `access_key_subject_origin_idx` ON `access_key` (`creator_subject`) WHERE "access_key"."session_above" = 0;--> statement-breakpoint
CREATE TABLE `access_key_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`key_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `access_key_state_insert`
AFTER INSERT ON `access_key`
BEGIN
	INSERT INTO `access_key_state` (`id`, `key_count`)
	VALUES (1, 1)
	ON CONFLICT (`id`) DO UPDATE SET `key_count` = `key_count` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `access_key_state_delete`
AFTER DELETE ON `access_key`
BEGIN
	UPDATE `access_key_state` SET `key_count` = `key_count` - 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TABLE `oidc_trust_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `oidc_trust_revision_insert`
AFTER INSERT ON `oidc_trust`
BEGIN
	INSERT INTO `oidc_trust_revision` (`id`, `revision`)
	VALUES (1, 1)
	ON CONFLICT (`id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `oidc_trust_revision_update`
AFTER UPDATE ON `oidc_trust`
BEGIN
	INSERT INTO `oidc_trust_revision` (`id`, `revision`)
	VALUES (1, 1)
	ON CONFLICT (`id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `oidc_trust_revision_delete`
AFTER DELETE ON `oidc_trust`
BEGIN
	INSERT INTO `oidc_trust_revision` (`id`, `revision`)
	VALUES (1, 1)
	ON CONFLICT (`id`) DO UPDATE SET `revision` = `revision` + 1;
END;

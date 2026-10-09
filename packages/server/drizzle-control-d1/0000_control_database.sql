CREATE TABLE `control_auth_key` (
	`id` text PRIMARY KEY NOT NULL,
	`kid` text NOT NULL,
	`public_jwk_json` text NOT NULL,
	`wrapped_private_jwk` text NOT NULL,
	`created_at` text NOT NULL,
	`scheduled_retire_at` text,
	`retired_at` text
);
--> statement-breakpoint
CREATE TABLE `control_consumed_subject_nonce` (
	`nonce` text PRIMARY KEY NOT NULL,
	`family_id` text,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `control_consumed_subject_nonce_expires_at_idx` ON `control_consumed_subject_nonce` (`expires_at`);--> statement-breakpoint
CREATE TABLE `control_database_ready` (
	`id` text PRIMARY KEY NOT NULL,
	`source_database_id` text NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `control_refresh_session_family` (
	`id` text PRIMARY KEY NOT NULL,
	`active_member_id` text NOT NULL,
	`generation` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`rule` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_refresh_session_family_active_member_unique` ON `control_refresh_session_family` (`active_member_id`);--> statement-breakpoint
CREATE INDEX `control_refresh_session_family_expires_at_idx` ON `control_refresh_session_family` (`expires_at`,`id`);--> statement-breakpoint
CREATE TABLE `control_refresh_session_member` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`generation` integer NOT NULL,
	`credential_hash` text NOT NULL,
	`successor_envelope` text,
	`successor_expires_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_refresh_session_member_family_generation_unique` ON `control_refresh_session_member` (`family_id`,`generation`);--> statement-breakpoint
CREATE INDEX `control_refresh_session_member_successor_expiry_idx` ON `control_refresh_session_member` (`successor_expires_at`,`id`) WHERE "control_refresh_session_member"."successor_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `control_trust` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`audience` text NOT NULL,
	`claims_json` text DEFAULT '{}' NOT NULL,
	`permitted_grants_json` text DEFAULT '[{"type":"cupboard_wildcard"}]' NOT NULL,
	`display_json` text,
	`created_at` text NOT NULL,
	`disabled_at` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deployment_transition` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	`contracted_at` text
);
--> statement-breakpoint
CREATE TABLE `global_admin` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`audience` text DEFAULT '' NOT NULL,
	`claimed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tenant_maintenance_failure` (
	`tenant` text NOT NULL,
	`pass` text NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_failed_at` text,
	`last_success_at` text,
	PRIMARY KEY(`tenant`, `pass`)
);

--> statement-breakpoint
CREATE TRIGGER control_trust_native_grants_insert
BEFORE INSERT ON control_trust
WHEN EXISTS (
 SELECT 1 FROM json_each(NEW.permitted_grants_json) AS grant
 WHERE json_extract(grant.value, '$.type') = 'cupboard_cache'
  AND json_extract(grant.value, '$.resources.cache.kind') IS NULL
)
BEGIN
 SELECT RAISE(ABORT, 'cache grants require scope spelling after contraction');
END;

--> statement-breakpoint
CREATE TRIGGER control_trust_native_grants_update
BEFORE UPDATE ON control_trust
WHEN EXISTS (
 SELECT 1 FROM json_each(NEW.permitted_grants_json) AS grant
 WHERE json_extract(grant.value, '$.type') = 'cupboard_cache'
  AND json_extract(grant.value, '$.resources.cache.kind') IS NULL
)
BEGIN
 SELECT RAISE(ABORT, 'cache grants require scope spelling after contraction');
END;

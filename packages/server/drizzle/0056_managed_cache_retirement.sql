CREATE TABLE `managed_cache_retirement` (
	`cache_id` integer PRIMARY KEY NOT NULL,
	`eligible_after` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cache_identity_live_id_idx` ON `cache_identity` (`id`) WHERE "cache_identity"."deleted_at" IS NULL;
CREATE TABLE `attestation_list_revision` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant` text NOT NULL,
	`cache_kind` text NOT NULL,
	`cache_name` text,
	`store_path_hash` text NOT NULL,
	`generation` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`published_revision` integer,
	`published_cache_generation` integer,
	`published_nar_hash` text,
	`published_key` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "attestation_list_revision_cache_identity_check" CHECK(("attestation_list_revision"."cache_kind" = 'default' AND "attestation_list_revision"."cache_name" IS NULL) OR ("attestation_list_revision"."cache_kind" = 'named' AND "attestation_list_revision"."cache_name" IS NOT NULL)),
	CONSTRAINT "attestation_list_revision_number_check" CHECK("attestation_list_revision"."revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "attestation_list_revision_publication_check" CHECK(("attestation_list_revision"."published_revision" IS NULL AND "attestation_list_revision"."published_cache_generation" IS NULL AND "attestation_list_revision"."published_nar_hash" IS NULL AND "attestation_list_revision"."published_key" IS NULL) OR ("attestation_list_revision"."published_revision" IS NOT NULL AND "attestation_list_revision"."published_revision" BETWEEN 1 AND "attestation_list_revision"."revision" AND "attestation_list_revision"."published_cache_generation" >= 1 AND "attestation_list_revision"."published_cache_generation" IS NOT NULL AND "attestation_list_revision"."published_nar_hash" IS NOT NULL))
);

--> statement-breakpoint
CREATE UNIQUE INDEX `attestation_list_revision_default_idx` ON `attestation_list_revision` (`tenant`,`store_path_hash`,`generation`) WHERE "attestation_list_revision"."cache_kind" = 'default';
--> statement-breakpoint
CREATE UNIQUE INDEX `attestation_list_revision_named_idx` ON `attestation_list_revision` (`tenant`,`cache_name`,`store_path_hash`,`generation`) WHERE "attestation_list_revision"."cache_kind" = 'named';
--> statement-breakpoint
CREATE INDEX `attestation_list_revision_pending_idx` ON `attestation_list_revision` (`tenant`,`id`) WHERE "attestation_list_revision"."published_revision" IS NULL OR "attestation_list_revision"."published_revision" != "attestation_list_revision"."revision";

--> statement-breakpoint
CREATE TRIGGER attestation_list_revision_insert
AFTER INSERT ON attestation_ref_storage
BEGIN
INSERT INTO attestation_list_revision (tenant, cache_kind, cache_name, store_path_hash, generation, revision, updated_at)
VALUES (NEW.tenant, NEW.cache_kind, NEW.cache_name, NEW.store_path_hash, NEW.generation, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT DO UPDATE SET
revision = attestation_list_revision.revision + 1,
updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER attestation_list_revision_delete
AFTER DELETE ON attestation_ref_storage
BEGIN
INSERT INTO attestation_list_revision (tenant, cache_kind, cache_name, store_path_hash, generation, revision, updated_at)
VALUES (OLD.tenant, OLD.cache_kind, OLD.cache_name, OLD.store_path_hash, OLD.generation, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT DO UPDATE SET
revision = attestation_list_revision.revision + 1,
updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER attestation_list_revision_update
AFTER UPDATE ON attestation_ref_storage
WHEN OLD.tenant IS NOT NEW.tenant OR OLD.cache_kind IS NOT NEW.cache_kind OR OLD.cache_name IS NOT NEW.cache_name OR OLD.store_path_hash IS NOT NEW.store_path_hash OR OLD.generation IS NOT NEW.generation OR OLD.predicate_type IS NOT NEW.predicate_type OR OLD.digest IS NOT NEW.digest OR OLD.readable IS NOT NEW.readable
BEGIN
INSERT INTO attestation_list_revision (tenant, cache_kind, cache_name, store_path_hash, generation, revision, updated_at)
VALUES (OLD.tenant, OLD.cache_kind, OLD.cache_name, OLD.store_path_hash, OLD.generation, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT DO UPDATE SET
revision = attestation_list_revision.revision + 1,
updated_at = excluded.updated_at;
INSERT INTO attestation_list_revision (tenant, cache_kind, cache_name, store_path_hash, generation, revision, updated_at)
SELECT NEW.tenant, NEW.cache_kind, NEW.cache_name, NEW.store_path_hash, NEW.generation, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE OLD.tenant IS NOT NEW.tenant OR OLD.cache_kind IS NOT NEW.cache_kind OR OLD.cache_name IS NOT NEW.cache_name OR OLD.store_path_hash IS NOT NEW.store_path_hash OR OLD.generation IS NOT NEW.generation
ON CONFLICT DO UPDATE SET
revision = attestation_list_revision.revision + 1,
updated_at = excluded.updated_at;
END;

--> statement-breakpoint
CREATE TRIGGER attestation_list_parent_insert
AFTER INSERT ON blob_ref_storage
BEGIN
INSERT INTO attestation_list_revision (tenant, cache_kind, cache_name, store_path_hash, generation, revision, updated_at)
VALUES (NEW.tenant, NEW.cache_kind, NEW.cache_name, NEW.store_path_hash, NEW.generation, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT DO NOTHING;
END;

--> statement-breakpoint
CREATE TRIGGER attestation_list_parent_delete
AFTER DELETE ON blob_ref_storage
BEGIN
INSERT INTO attestation_list_revision (tenant, cache_kind, cache_name, store_path_hash, generation, revision, updated_at)
VALUES (OLD.tenant, OLD.cache_kind, OLD.cache_name, OLD.store_path_hash, OLD.generation, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT DO UPDATE SET revision = attestation_list_revision.revision + 1, updated_at = excluded.updated_at;
END;

--> statement-breakpoint
CREATE TRIGGER attestation_list_parent_update
AFTER UPDATE ON blob_ref_storage
WHEN OLD.tenant IS NOT NEW.tenant OR OLD.cache_kind IS NOT NEW.cache_kind OR OLD.cache_name IS NOT NEW.cache_name OR OLD.store_path_hash IS NOT NEW.store_path_hash OR OLD.generation IS NOT NEW.generation OR OLD.nar_hash IS NOT NEW.nar_hash OR OLD.cache_generation IS NOT NEW.cache_generation OR OLD.readable IS NOT NEW.readable
BEGIN
INSERT INTO attestation_list_revision (tenant, cache_kind, cache_name, store_path_hash, generation, revision, updated_at)
VALUES (OLD.tenant, OLD.cache_kind, OLD.cache_name, OLD.store_path_hash, OLD.generation, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT DO UPDATE SET revision = attestation_list_revision.revision + 1, updated_at = excluded.updated_at;
INSERT INTO attestation_list_revision (tenant, cache_kind, cache_name, store_path_hash, generation, revision, updated_at)
SELECT NEW.tenant, NEW.cache_kind, NEW.cache_name, NEW.store_path_hash, NEW.generation, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE OLD.tenant IS NOT NEW.tenant OR OLD.cache_kind IS NOT NEW.cache_kind OR OLD.cache_name IS NOT NEW.cache_name OR OLD.store_path_hash IS NOT NEW.store_path_hash OR OLD.generation IS NOT NEW.generation
ON CONFLICT DO UPDATE SET revision = attestation_list_revision.revision + 1, updated_at = excluded.updated_at;
END;

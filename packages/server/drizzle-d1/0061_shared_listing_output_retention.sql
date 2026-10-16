CREATE TABLE `shared_listing_output_cleanup` (
	`nar_hash` text PRIMARY KEY NOT NULL,
	`epoch` text DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`cursor` text,
	`owner` text,
	`lease_expires_at` text,
	`next_attempt_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	CONSTRAINT "shared_listing_output_cleanup_epoch_check" CHECK(length("shared_listing_output_cleanup"."epoch") = 32 AND "shared_listing_output_cleanup"."epoch" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "shared_listing_output_cleanup_owner_check" CHECK(("shared_listing_output_cleanup"."owner" IS NULL AND "shared_listing_output_cleanup"."lease_expires_at" IS NULL) OR ("shared_listing_output_cleanup"."owner" IS NOT NULL AND "shared_listing_output_cleanup"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `shared_listing_output_cleanup_due_idx` ON `shared_listing_output_cleanup` (`next_attempt_at`,`nar_hash`);--> statement-breakpoint
CREATE TABLE `shared_listing_output_ref` (
	`nar_hash` text NOT NULL,
	`generator_revision` text NOT NULL,
	`epoch` text NOT NULL,
	`source_incarnation` integer NOT NULL,
	`computation_generation` integer NOT NULL,
	`digest` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`nar_hash`, `generator_revision`),
	CONSTRAINT "shared_listing_output_ref_generation_check" CHECK(typeof("shared_listing_output_ref"."source_incarnation") = 'integer' AND "shared_listing_output_ref"."source_incarnation" BETWEEN 1 AND 9007199254740991
  AND typeof("shared_listing_output_ref"."computation_generation") = 'integer' AND "shared_listing_output_ref"."computation_generation" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "shared_listing_output_ref_size_check" CHECK(typeof("shared_listing_output_ref"."size") = 'integer' AND "shared_listing_output_ref"."size" BETWEEN 1 AND 67108864)
);
--> statement-breakpoint
CREATE INDEX `shared_listing_output_ref_digest_idx` ON `shared_listing_output_ref` (`digest`);
--> statement-breakpoint
CREATE TRIGGER shared_listing_output_guard_arm BEFORE UPDATE OF delete_after ON cas_object_storage
WHEN NEW.delete_after IS NOT NULL AND EXISTS (SELECT 1 FROM shared_listing_output_ref WHERE digest = OLD.digest)
BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_output_guard_delete BEFORE DELETE ON cas_object_storage
WHEN EXISTS (SELECT 1 FROM shared_listing_output_ref WHERE digest = OLD.digest)
BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_output_guard_retire BEFORE UPDATE OF state ON object_incarnation
WHEN OLD.kind = 'cas' AND OLD.state = 'live' AND NEW.state = 'absent'
AND EXISTS (SELECT 1 FROM shared_listing_output_ref WHERE digest = OLD.object_id)
BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_output_guard_registry_delete BEFORE DELETE ON object_incarnation
WHEN OLD.kind = 'cas' AND EXISTS (SELECT 1 FROM shared_listing_output_ref WHERE digest = OLD.object_id)
BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_output_parent_retired AFTER DELETE ON blob_ref_storage
WHEN NOT EXISTS (SELECT 1 FROM blob_ref_storage WHERE nar_hash = OLD.nar_hash)
AND EXISTS (SELECT 1 FROM shared_listing_output_ref WHERE nar_hash = OLD.nar_hash)
BEGIN
 INSERT INTO shared_listing_output_cleanup (nar_hash) VALUES (OLD.nar_hash)
 ON CONFLICT(nar_hash) DO UPDATE SET epoch = lower(hex(randomblob(16))), cursor = NULL, owner = NULL,
 lease_expires_at = NULL, next_attempt_at = '1970-01-01T00:00:00.000Z';
END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_output_fact_insert BEFORE INSERT ON listing_fact
WHEN EXISTS (SELECT 1 FROM shared_listing_output_ref
 WHERE nar_hash = NEW.nar_hash AND generator_revision = NEW.generator_revision
 AND (digest <> NEW.digest OR size <> NEW.size))
BEGIN SELECT RAISE(ABORT, 'shared listing output conflicts with listing fact'); END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_output_fact_update BEFORE UPDATE ON listing_fact
WHEN EXISTS (SELECT 1 FROM shared_listing_output_ref
 WHERE nar_hash = NEW.nar_hash AND generator_revision = NEW.generator_revision
 AND (digest <> NEW.digest OR size <> NEW.size))
BEGIN SELECT RAISE(ABORT, 'shared listing output conflicts with listing fact'); END;

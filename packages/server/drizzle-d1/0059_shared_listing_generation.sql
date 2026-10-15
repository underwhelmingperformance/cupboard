CREATE TABLE `shared_listing_generation` (
	`nar_hash` text NOT NULL,
	`generator_revision` text NOT NULL,
	`source_incarnation` integer NOT NULL,
	`generation` integer NOT NULL,
	`job_id` text NOT NULL,
	`job_generation` integer NOT NULL,
	`task_id` text NOT NULL,
	`task_generation` integer NOT NULL,
	`owner` text,
	`lease_expires_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`nar_hash`, `generator_revision`),
	CONSTRAINT "shared_listing_generation_integer_check" CHECK(typeof("shared_listing_generation"."generation") = 'integer' AND "shared_listing_generation"."generation" BETWEEN 1 AND 9007199254740991
		AND typeof("shared_listing_generation"."source_incarnation") = 'integer' AND "shared_listing_generation"."source_incarnation" BETWEEN 1 AND 9007199254740991
		AND typeof("shared_listing_generation"."job_generation") = 'integer' AND "shared_listing_generation"."job_generation" BETWEEN 1 AND 9007199254740991
		AND typeof("shared_listing_generation"."task_generation") = 'integer' AND "shared_listing_generation"."task_generation" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "shared_listing_generation_ownership_check" CHECK(("shared_listing_generation"."owner" IS NULL AND "shared_listing_generation"."lease_expires_at" IS NULL) OR ("shared_listing_generation"."owner" IS NOT NULL AND "shared_listing_generation"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TRIGGER `tenant_listing_generation_exclude_insert` BEFORE INSERT ON `listing_generation`
WHEN NEW.owner IS NOT NULL AND EXISTS (
 SELECT 1 FROM shared_listing_generation AS competing
 WHERE competing.nar_hash = NEW.nar_hash AND competing.generator_revision = NEW.generator_revision
  AND competing.source_incarnation = NEW.source_incarnation
  AND competing.owner IS NOT NULL AND competing.lease_expires_at > NEW.updated_at
  AND EXISTS (SELECT 1 FROM shared_listing_task AS task
    JOIN shared_listing_job AS job ON job.id = task.job_id
    WHERE task.id = competing.task_id AND task.job_id = competing.job_id
     AND task.state = 'running' AND task.claim_owner = competing.owner
     AND task.claim_generation = competing.task_generation
     AND task.claim_job_generation = competing.job_generation
     AND task.lease_expires_at > NEW.updated_at
     AND job.state = 'running' AND job.generation = competing.job_generation)
)
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER `global_listing_generation_exclude_insert` BEFORE INSERT ON `shared_listing_generation`
WHEN NEW.owner IS NOT NULL AND EXISTS (
 SELECT 1 FROM listing_generation AS competing
 WHERE competing.nar_hash = NEW.nar_hash AND competing.generator_revision = NEW.generator_revision
  AND competing.source_incarnation = NEW.source_incarnation
  AND competing.owner IS NOT NULL AND competing.lease_expires_at > NEW.updated_at
  AND EXISTS (SELECT 1 FROM tenant WHERE id = competing.tenant AND status = 'active')
)
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER `tenant_listing_generation_exclude_update` BEFORE UPDATE ON `listing_generation`
WHEN NEW.owner IS NOT NULL AND EXISTS (
 SELECT 1 FROM shared_listing_generation AS competing
 WHERE competing.nar_hash = NEW.nar_hash AND competing.generator_revision = NEW.generator_revision
  AND competing.source_incarnation = NEW.source_incarnation
  AND competing.owner IS NOT NULL AND competing.lease_expires_at > NEW.updated_at
  AND EXISTS (SELECT 1 FROM shared_listing_task AS task
    JOIN shared_listing_job AS job ON job.id = task.job_id
    WHERE task.id = competing.task_id AND task.job_id = competing.job_id
     AND task.state = 'running' AND task.claim_owner = competing.owner
     AND task.claim_generation = competing.task_generation
     AND task.claim_job_generation = competing.job_generation
     AND task.lease_expires_at > NEW.updated_at
     AND job.state = 'running' AND job.generation = competing.job_generation)
)
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER `global_listing_generation_exclude_update` BEFORE UPDATE ON `shared_listing_generation`
WHEN NEW.owner IS NOT NULL AND EXISTS (
 SELECT 1 FROM listing_generation AS competing
 WHERE competing.nar_hash = NEW.nar_hash AND competing.generator_revision = NEW.generator_revision
  AND competing.source_incarnation = NEW.source_incarnation
  AND competing.owner IS NOT NULL AND competing.lease_expires_at > NEW.updated_at
  AND EXISTS (SELECT 1 FROM tenant WHERE id = competing.tenant AND status = 'active')
)
BEGIN
 SELECT RAISE(IGNORE);
END;

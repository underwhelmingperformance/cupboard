CREATE TABLE `shared_listing_task_delivery` (
	`task_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`job_generation` integer NOT NULL,
	`state` text NOT NULL,
	`epoch` text DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`next_at` text NOT NULL,
	CONSTRAINT "shared_listing_task_delivery_generation_check" CHECK(typeof("shared_listing_task_delivery"."job_generation") = 'integer' AND "shared_listing_task_delivery"."job_generation" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "shared_listing_task_delivery_state_check" CHECK("shared_listing_task_delivery"."state" IN ('pending', 'running')),
	CONSTRAINT "shared_listing_task_delivery_epoch_check" CHECK(length("shared_listing_task_delivery"."epoch") = 32 AND "shared_listing_task_delivery"."epoch" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `shared_listing_task_delivery_due_idx` ON `shared_listing_task_delivery` (`job_id`,`state`,`next_at`,`task_id`);--> statement-breakpoint
CREATE INDEX `shared_listing_task_delivery_generation_idx` ON `shared_listing_task_delivery` (`job_id`,`state`,`job_generation`,`next_at`,`task_id`);--> statement-breakpoint
CREATE TRIGGER shared_listing_task_delivery_insert
AFTER INSERT ON shared_listing_task
WHEN NEW.state IN ('pending', 'running')
BEGIN
 INSERT INTO shared_listing_task_delivery (task_id, job_id, job_generation, state, next_at)
 SELECT NEW.id, NEW.job_id,
  CASE WHEN NEW.state = 'running' THEN NEW.claim_job_generation ELSE generation END,
  NEW.state, CASE WHEN NEW.state = 'running' THEN NEW.lease_expires_at ELSE NEW.ready_at END
 FROM shared_listing_job WHERE id = NEW.job_id;
END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_task_delivery_update
AFTER UPDATE OF id, job_id, nar_hash, state, claim_generation, claim_job_generation, claim_owner, lease_expires_at, ready_at, source_incarnation, nar_size, file_size ON shared_listing_task
WHEN OLD.id IS NOT NEW.id OR OLD.job_id IS NOT NEW.job_id OR OLD.nar_hash IS NOT NEW.nar_hash
 OR OLD.state IS NOT NEW.state OR OLD.claim_generation IS NOT NEW.claim_generation
 OR OLD.claim_job_generation IS NOT NEW.claim_job_generation OR OLD.claim_owner IS NOT NEW.claim_owner
 OR OLD.lease_expires_at IS NOT NEW.lease_expires_at OR OLD.ready_at IS NOT NEW.ready_at
 OR OLD.source_incarnation IS NOT NEW.source_incarnation OR OLD.nar_size IS NOT NEW.nar_size OR OLD.file_size IS NOT NEW.file_size
BEGIN
 DELETE FROM shared_listing_task_delivery WHERE task_id = OLD.id AND (OLD.id IS NOT NEW.id OR NEW.state NOT IN ('pending', 'running'));
 INSERT INTO shared_listing_task_delivery (task_id, job_id, job_generation, state, next_at)
 SELECT NEW.id, NEW.job_id,
  CASE WHEN NEW.state = 'running' THEN NEW.claim_job_generation ELSE generation END,
  NEW.state, CASE WHEN NEW.state = 'running' THEN NEW.lease_expires_at ELSE NEW.ready_at END
 FROM shared_listing_job WHERE id = NEW.job_id AND NEW.state IN ('pending', 'running')
 ON CONFLICT(task_id) DO UPDATE SET job_id = excluded.job_id,
  job_generation = excluded.job_generation, state = excluded.state,
  next_at = excluded.next_at, epoch = lower(hex(randomblob(16)));
END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_task_delivery_delete
AFTER DELETE ON shared_listing_task
BEGIN
 DELETE FROM shared_listing_task_delivery WHERE task_id = OLD.id;
END;

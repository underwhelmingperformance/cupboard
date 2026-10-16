ALTER TABLE `shared_listing_task` ADD `state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `shared_listing_task` ADD `claim_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shared_listing_task` ADD `claim_job_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shared_listing_task` ADD `claim_owner` text;--> statement-breakpoint
ALTER TABLE `shared_listing_task` ADD `lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `shared_listing_task` ADD `ready_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE `shared_listing_task` ADD `updated_at` text;--> statement-breakpoint
CREATE INDEX `shared_listing_task_ready_idx` ON `shared_listing_task` (`job_id`,`state`,`ready_at`,`id`);--> statement-breakpoint
CREATE INDEX `shared_listing_task_lease_idx` ON `shared_listing_task` (`job_id`,`state`,`lease_expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `shared_listing_task_job_claim_idx` ON `shared_listing_task` (`job_id`,`state`,`claim_job_generation`,`id`);
--> statement-breakpoint
CREATE TRIGGER `shared_listing_task_claim_insert` BEFORE INSERT ON `shared_listing_task`
WHEN NEW.state NOT IN ('pending', 'running', 'completed', 'skipped', 'failed')
 OR typeof(NEW.claim_generation) <> 'integer' OR NEW.claim_generation NOT BETWEEN 0 AND 9007199254740991
 OR typeof(NEW.claim_job_generation) <> 'integer' OR NEW.claim_job_generation NOT BETWEEN 0 AND 9007199254740991
 OR (NEW.claim_generation = 0 AND (NEW.claim_job_generation <> 0 OR NEW.claim_owner IS NOT NULL))
 OR (NEW.claim_generation > 0 AND (NEW.claim_job_generation < 1 OR NEW.claim_owner IS NULL))
 OR (NEW.state <> 'pending' AND NEW.claim_generation < 1)
 OR (NEW.state = 'running' AND NEW.lease_expires_at IS NULL)
 OR (NEW.state <> 'running' AND NEW.lease_expires_at IS NOT NULL)
 OR typeof(NEW.source_incarnation) <> 'integer' OR NEW.source_incarnation NOT BETWEEN 1 AND 9007199254740991
 OR typeof(NEW.nar_size) <> 'integer' OR NEW.nar_size NOT BETWEEN 0 AND 9007199254740991
 OR typeof(NEW.file_size) <> 'integer' OR NEW.file_size NOT BETWEEN 0 AND 9007199254740991
BEGIN
 SELECT RAISE(ABORT, 'shared listing task ownership is outside the execution domain');
END;
--> statement-breakpoint
CREATE TRIGGER `shared_listing_task_claim_update` BEFORE UPDATE ON `shared_listing_task`
WHEN NEW.state NOT IN ('pending', 'running', 'completed', 'skipped', 'failed')
 OR typeof(NEW.claim_generation) <> 'integer' OR NEW.claim_generation NOT BETWEEN 0 AND 9007199254740991
 OR typeof(NEW.claim_job_generation) <> 'integer' OR NEW.claim_job_generation NOT BETWEEN 0 AND 9007199254740991
 OR (NEW.claim_generation = 0 AND (NEW.claim_job_generation <> 0 OR NEW.claim_owner IS NOT NULL))
 OR (NEW.claim_generation > 0 AND (NEW.claim_job_generation < 1 OR NEW.claim_owner IS NULL))
 OR (NEW.state <> 'pending' AND NEW.claim_generation < 1)
 OR (NEW.state = 'running' AND NEW.lease_expires_at IS NULL)
 OR (NEW.state <> 'running' AND NEW.lease_expires_at IS NOT NULL)
 OR typeof(NEW.source_incarnation) <> 'integer' OR NEW.source_incarnation NOT BETWEEN 1 AND 9007199254740991
 OR typeof(NEW.nar_size) <> 'integer' OR NEW.nar_size NOT BETWEEN 0 AND 9007199254740991
 OR typeof(NEW.file_size) <> 'integer' OR NEW.file_size NOT BETWEEN 0 AND 9007199254740991
BEGIN
 SELECT RAISE(ABORT, 'shared listing task ownership is outside the execution domain');
END;

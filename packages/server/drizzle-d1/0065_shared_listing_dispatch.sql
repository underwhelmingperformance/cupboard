CREATE TABLE `shared_listing_job_dispatch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`job_generation` integer NOT NULL,
	`next_delivery_at` text,
	`claim_generation` integer DEFAULT 0 NOT NULL,
	`owner` text,
	`lease_expires_at` text,
	`is_seeded` integer DEFAULT true NOT NULL,
	`seed_after` text,
	`seed_through` text,
	CONSTRAINT "shared_listing_job_dispatch_version_check" CHECK(typeof("shared_listing_job_dispatch"."id") = 'integer' AND "shared_listing_job_dispatch"."id" BETWEEN 1 AND 9007199254740991 AND typeof("shared_listing_job_dispatch"."job_generation") = 'integer' AND "shared_listing_job_dispatch"."job_generation" BETWEEN 1 AND 9007199254740991 AND typeof("shared_listing_job_dispatch"."claim_generation") = 'integer' AND "shared_listing_job_dispatch"."claim_generation" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "shared_listing_job_dispatch_owner_check" CHECK(("shared_listing_job_dispatch"."owner" IS NULL AND "shared_listing_job_dispatch"."lease_expires_at" IS NULL) OR ("shared_listing_job_dispatch"."owner" IS NOT NULL AND "shared_listing_job_dispatch"."lease_expires_at" IS NOT NULL AND "shared_listing_job_dispatch"."next_delivery_at" IS NOT NULL AND "shared_listing_job_dispatch"."claim_generation" >= 1 AND "shared_listing_job_dispatch"."next_delivery_at" = "shared_listing_job_dispatch"."lease_expires_at")),
	CONSTRAINT "shared_listing_job_dispatch_seed_check" CHECK("shared_listing_job_dispatch"."is_seeded" IN (0,1) AND ("shared_listing_job_dispatch"."seed_after" IS NULL OR ("shared_listing_job_dispatch"."seed_through" IS NOT NULL AND "shared_listing_job_dispatch"."seed_after" <= "shared_listing_job_dispatch"."seed_through")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_listing_job_dispatch_job_idx` ON `shared_listing_job_dispatch` (`job_id`);--> statement-breakpoint
CREATE INDEX `shared_listing_job_dispatch_due_idx` ON `shared_listing_job_dispatch` (`next_delivery_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER shared_listing_dispatch_job_insert AFTER INSERT ON shared_listing_job
BEGIN
 INSERT INTO shared_listing_job_dispatch(job_id,job_generation,next_delivery_at,is_seeded)
 VALUES (NEW.id,NEW.generation,CASE WHEN NEW.state = 'running' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,1);
END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_dispatch_job_lifecycle AFTER UPDATE OF state,generation ON shared_listing_job
WHEN OLD.state IS NOT NEW.state OR OLD.generation IS NOT NEW.generation
BEGIN
 INSERT INTO shared_listing_job_dispatch(job_id,job_generation,next_delivery_at,is_seeded)
 VALUES (NEW.id,NEW.generation,CASE WHEN NEW.state = 'running' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,0)
 ON CONFLICT(job_id) DO UPDATE SET id=excluded.id,job_generation=excluded.job_generation,
 next_delivery_at=excluded.next_delivery_at,owner=NULL,lease_expires_at=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_dispatch_job_delete AFTER DELETE ON shared_listing_job
BEGIN
 DELETE FROM shared_listing_job_dispatch WHERE job_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_dispatch_discovery AFTER UPDATE OF phase,owner,lease_expires_at ON shared_listing_job
WHEN OLD.phase IS NOT NEW.phase OR OLD.owner IS NOT NEW.owner OR OLD.lease_expires_at IS NOT NEW.lease_expires_at
BEGIN
 UPDATE shared_listing_job_dispatch SET next_delivery_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE job_id=NEW.id AND owner IS NULL AND (next_delivery_at IS NULL OR next_delivery_at>strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AND job_generation=NEW.generation AND NEW.state='running';
END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_dispatch_delivery_insert AFTER INSERT ON shared_listing_task_delivery
BEGIN
 UPDATE shared_listing_job_dispatch SET next_delivery_at=(
 CASE WHEN NEW.state='running' AND NEW.job_generation < job_generation
 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 ELSE max(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),NEW.next_at) END
 )
 WHERE job_id=NEW.job_id AND owner IS NULL AND (next_delivery_at IS NULL OR next_delivery_at>(
 CASE WHEN NEW.state='running' AND NEW.job_generation < job_generation
 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 ELSE max(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),NEW.next_at) END
 )) AND EXISTS (SELECT 1 FROM shared_listing_job WHERE id=job_id AND state='running');
END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_dispatch_delivery_update AFTER UPDATE ON shared_listing_task_delivery
BEGIN
 UPDATE shared_listing_job_dispatch SET next_delivery_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE job_id=OLD.job_id AND owner IS NULL AND (next_delivery_at IS NULL OR next_delivery_at>strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AND EXISTS (SELECT 1 FROM shared_listing_job WHERE id=job_id AND state='running') AND OLD.job_id IS NOT NEW.job_id;
 UPDATE shared_listing_job_dispatch SET next_delivery_at=(
 CASE WHEN NEW.state='running' AND NEW.job_generation < job_generation
 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 ELSE max(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),NEW.next_at) END
 )
 WHERE job_id=NEW.job_id AND owner IS NULL AND (next_delivery_at IS NULL OR next_delivery_at>(
 CASE WHEN NEW.state='running' AND NEW.job_generation < job_generation
 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 ELSE max(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),NEW.next_at) END
 )) AND EXISTS (SELECT 1 FROM shared_listing_job WHERE id=job_id AND state='running');
END;
--> statement-breakpoint
CREATE TRIGGER shared_listing_dispatch_delivery_delete AFTER DELETE ON shared_listing_task_delivery
BEGIN
 UPDATE shared_listing_job_dispatch SET next_delivery_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE job_id=OLD.job_id AND owner IS NULL AND (next_delivery_at IS NULL OR next_delivery_at>strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AND EXISTS (SELECT 1 FROM shared_listing_job WHERE id=job_id AND state='running');
END;

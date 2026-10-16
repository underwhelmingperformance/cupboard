CREATE TABLE `listing_adoption_task` (
	`id` text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`epoch` text DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`kind` text NOT NULL,
	`work_id` text,
	`parent_id` text,
	`generator_revision` text,
	`source` text NOT NULL,
	`available_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`retry_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`owner` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` text,
	`progress_revision` integer DEFAULT 0 NOT NULL,
	`window` text,
	`scanned` integer DEFAULT 0 NOT NULL,
	`enrolled` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "listing_adoption_task_identity_check" CHECK(length("listing_adoption_task"."id")=32 AND "listing_adoption_task"."id" NOT GLOB '*[^0-9a-f]*' AND length("listing_adoption_task"."epoch")=32 AND "listing_adoption_task"."epoch" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "listing_adoption_task_source_check" CHECK(coalesce(json_valid("listing_adoption_task"."source") AND json_extract("listing_adoption_task"."source",'$.kind')="listing_adoption_task"."kind" AND (("listing_adoption_task"."kind"='expand' AND "listing_adoption_task"."work_id" IS NOT NULL AND "listing_adoption_task"."parent_id" IS NULL AND "listing_adoption_task"."generator_revision" IS NULL AND json_extract("listing_adoption_task"."source",'$.work.id')="listing_adoption_task"."work_id") OR ("listing_adoption_task"."kind"='deliver' AND "listing_adoption_task"."work_id" IS NULL AND "listing_adoption_task"."parent_id" IS NOT NULL AND "listing_adoption_task"."generator_revision" IS NOT NULL AND "listing_adoption_task"."window" IS NULL AND json_extract("listing_adoption_task"."source",'$.target.parent.id')="listing_adoption_task"."parent_id" AND json_extract("listing_adoption_task"."source",'$.target.identity.generatorRevision')="listing_adoption_task"."generator_revision")),0)),
	CONSTRAINT "listing_adoption_task_claim_check" CHECK(typeof("listing_adoption_task"."generation")='integer' AND "listing_adoption_task"."generation" BETWEEN 0 AND 9007199254740991 AND ("listing_adoption_task"."owner" IS NULL)=("listing_adoption_task"."lease_expires_at" IS NULL) AND ("listing_adoption_task"."owner" IS NULL OR ("listing_adoption_task"."generation">=1 AND "listing_adoption_task"."completed_at" IS NULL))),
	CONSTRAINT "listing_adoption_task_progress_check" CHECK(typeof("listing_adoption_task"."progress_revision")='integer' AND "listing_adoption_task"."progress_revision" BETWEEN 0 AND 9007199254740991 AND typeof("listing_adoption_task"."scanned")='integer' AND "listing_adoption_task"."scanned" BETWEEN 0 AND 9007199254740991 AND typeof("listing_adoption_task"."enrolled")='integer' AND "listing_adoption_task"."enrolled" BETWEEN 0 AND "listing_adoption_task"."scanned")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_adoption_task_work_idx` ON `listing_adoption_task` (`work_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_adoption_task_target_idx` ON `listing_adoption_task` (`parent_id`,`generator_revision`) WHERE "listing_adoption_task"."kind"='deliver';--> statement-breakpoint
CREATE INDEX `listing_adoption_task_due_idx` ON `listing_adoption_task` (`available_at`,`id`) WHERE "listing_adoption_task"."completed_at" IS NULL;--> statement-breakpoint
CREATE TABLE `listing_adoption_task_seed` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` text DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`after` text,
	`through` text,
	`scanned` integer DEFAULT 0 NOT NULL,
	`is_complete` integer DEFAULT false NOT NULL,
	CONSTRAINT "listing_adoption_task_seed_id_check" CHECK("listing_adoption_task_seed"."id"=1),
	CONSTRAINT "listing_adoption_task_seed_epoch_check" CHECK(length("listing_adoption_task_seed"."epoch")=32 AND "listing_adoption_task_seed"."epoch" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "listing_adoption_task_seed_progress_check" CHECK(typeof("listing_adoption_task_seed"."scanned")='integer' AND "listing_adoption_task_seed"."scanned" BETWEEN 0 AND 9007199254740991 AND "listing_adoption_task_seed"."is_complete" IN (0,1) AND ("listing_adoption_task_seed"."after" IS NULL OR ("listing_adoption_task_seed"."through" IS NOT NULL AND "listing_adoption_task_seed"."after"<="listing_adoption_task_seed"."through")) AND ("listing_adoption_task_seed"."through" IS NOT NULL OR ("listing_adoption_task_seed"."is_complete"=1 AND "listing_adoption_task_seed"."after" IS NULL)))
);

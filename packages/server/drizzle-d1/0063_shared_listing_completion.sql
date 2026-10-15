CREATE TABLE `shared_listing_task_outcome` (
	`task_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`job_generation` integer NOT NULL,
	`task_generation` integer NOT NULL,
	`owner` text NOT NULL,
	`claim` text NOT NULL,
	`completion_id` text NOT NULL,
	`kind` text NOT NULL,
	`fact` text,
	`incarnation` integer,
	`reference_epoch` text,
	`computation_generation` integer,
	`stage_id` text,
	`reason` text,
	`completed_at` text NOT NULL,
	CONSTRAINT "shared_listing_task_outcome_generation_check" CHECK(typeof("shared_listing_task_outcome"."job_generation") = 'integer' AND "shared_listing_task_outcome"."job_generation" BETWEEN 1 AND 9007199254740991
 AND typeof("shared_listing_task_outcome"."task_generation") = 'integer' AND "shared_listing_task_outcome"."task_generation" BETWEEN 1 AND 9007199254740991
 AND ("shared_listing_task_outcome"."computation_generation" IS NULL OR (typeof("shared_listing_task_outcome"."computation_generation") = 'integer' AND "shared_listing_task_outcome"."computation_generation" BETWEEN 1 AND 9007199254740991))
 AND ("shared_listing_task_outcome"."incarnation" IS NULL OR (typeof("shared_listing_task_outcome"."incarnation") = 'integer' AND "shared_listing_task_outcome"."incarnation" BETWEEN 1 AND 9007199254740991))),
	CONSTRAINT "shared_listing_task_outcome_claim_check" CHECK(coalesce(json_valid("shared_listing_task_outcome"."claim") AND json_extract("shared_listing_task_outcome"."claim", '$.id') = "shared_listing_task_outcome"."task_id"
 AND json_extract("shared_listing_task_outcome"."claim", '$.job.id') = "shared_listing_task_outcome"."job_id" AND json_extract("shared_listing_task_outcome"."claim", '$.job.generation') = "shared_listing_task_outcome"."job_generation"
 AND json_extract("shared_listing_task_outcome"."claim", '$.generation') = "shared_listing_task_outcome"."task_generation" AND json_extract("shared_listing_task_outcome"."claim", '$.owner') = "shared_listing_task_outcome"."owner", 0)),
	CONSTRAINT "shared_listing_task_outcome_fact_check" CHECK("shared_listing_task_outcome"."fact" IS NULL OR coalesce(json_valid("shared_listing_task_outcome"."fact")
 AND json_extract("shared_listing_task_outcome"."fact", '$.narHash') = json_extract("shared_listing_task_outcome"."claim", '$.narHash')
 AND json_extract("shared_listing_task_outcome"."fact", '$.generatorRevision') = json_extract("shared_listing_task_outcome"."claim", '$.generatorRevision')
 AND json_extract("shared_listing_task_outcome"."fact", '$.format') = 1
 AND json_type("shared_listing_task_outcome"."fact", '$.size') = 'integer' AND json_extract("shared_listing_task_outcome"."fact", '$.size') BETWEEN 1 AND 9007199254740991
 AND length(json_extract("shared_listing_task_outcome"."fact", '$.digest')) = 64 AND json_extract("shared_listing_task_outcome"."fact", '$.digest') NOT GLOB '*[^0-9a-f]*', 0)),
	CONSTRAINT "shared_listing_task_outcome_kind_check" CHECK(coalesce(("shared_listing_task_outcome"."kind" = 'generated' AND "shared_listing_task_outcome"."fact" IS NOT NULL AND "shared_listing_task_outcome"."incarnation" IS NOT NULL AND "shared_listing_task_outcome"."reference_epoch" IS NOT NULL AND "shared_listing_task_outcome"."computation_generation" IS NOT NULL AND "shared_listing_task_outcome"."stage_id" IS NOT NULL AND "shared_listing_task_outcome"."reason" IS NULL)
 OR ("shared_listing_task_outcome"."kind" = 'reused' AND "shared_listing_task_outcome"."fact" IS NOT NULL AND "shared_listing_task_outcome"."incarnation" IS NOT NULL AND "shared_listing_task_outcome"."reference_epoch" IS NOT NULL AND "shared_listing_task_outcome"."stage_id" IS NULL AND "shared_listing_task_outcome"."reason" IS NULL)
 OR ("shared_listing_task_outcome"."kind" IN ('skipped','failed') AND "shared_listing_task_outcome"."fact" IS NULL AND "shared_listing_task_outcome"."incarnation" IS NULL AND "shared_listing_task_outcome"."reference_epoch" IS NULL AND "shared_listing_task_outcome"."computation_generation" IS NULL AND "shared_listing_task_outcome"."stage_id" IS NULL AND "shared_listing_task_outcome"."reason" IN ('source-unavailable','source-mismatch','unsupported-source','unsupported-generator-revision','resource-limit','generation-failed')), 0))
);
--> statement-breakpoint
CREATE INDEX `shared_listing_task_outcome_job_idx` ON `shared_listing_task_outcome` (`job_id`,`task_id`);

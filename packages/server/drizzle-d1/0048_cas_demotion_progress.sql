CREATE TABLE `cas_demotion_progress` (
	`digest` text PRIMARY KEY NOT NULL,
	`incarnation` integer NOT NULL,
	`after_tenant` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "cas_demotion_progress_incarnation_check" CHECK("cas_demotion_progress"."incarnation" >= 1),
	CONSTRAINT "cas_demotion_progress_revision_check" CHECK("cas_demotion_progress"."revision" >= 1)
);

--> statement-breakpoint
CREATE INDEX `cas_demotion_progress_ready_idx` ON `cas_demotion_progress` (`updated_at`,`revision`,`digest`);
--> statement-breakpoint
CREATE INDEX `attestation_ref_digest_tenant_idx` ON `attestation_ref_storage` (`digest`,`tenant`);

CREATE TABLE `deployment_runtime_control` (
	`id` text PRIMARY KEY NOT NULL,
	`retention_administration` text NOT NULL,
	`retention_revision` integer NOT NULL,
	`legacy_r2_writes` text NOT NULL,
	`legacy_r2_read_fallback` text NOT NULL,
	`legacy_r2_deletion` text NOT NULL,
	`tenant_local_contract_admission` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "deployment_runtime_control_singleton" CHECK(`id` = 'current'),
	CONSTRAINT "deployment_runtime_control_retention_revision_nonnegative" CHECK(`retention_revision` >= 0)
);
--> statement-breakpoint
CREATE TABLE `deployment_writer_cutover` (
	`artifact_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`cutover_at` text NOT NULL,
	`cohort_created_at` text NOT NULL,
	`maximum_legacy_deadline` text NOT NULL,
	`after_tenant` text,
	`scan_complete` integer DEFAULT false NOT NULL,
	`completed_at` text,
	PRIMARY KEY(`artifact_id`, `instance_id`)
);
--> statement-breakpoint
CREATE TABLE `deployment_writer_drain_tenant` (
	`artifact_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`tenant` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	`last_failure_json` text,
	PRIMARY KEY(`artifact_id`, `instance_id`, `tenant`),
	CONSTRAINT "deployment_writer_drain_tenant_attempts_nonnegative" CHECK(`attempts` >= 0)
);
--> statement-breakpoint
CREATE INDEX `deployment_writer_drain_tenant_work_idx` ON `deployment_writer_drain_tenant` (`artifact_id`,`instance_id`,`status`,`tenant`);
--> statement-breakpoint
CREATE TABLE `projection_repair_intent` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`fence_revision` integer NOT NULL,
	`status` text NOT NULL,
	`operation` text NOT NULL,
	`payload_json` text NOT NULL,
	`claim_id` text,
	`claim_expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_failure_json` text,
	CONSTRAINT "projection_repair_intent_fence_revision_nonnegative" CHECK(`fence_revision` >= 0)
);
--> statement-breakpoint
CREATE INDEX `projection_repair_intent_work_idx` ON `projection_repair_intent` (`status`,`writer_epoch`,`tenant`,`id`);
--> statement-breakpoint
CREATE TABLE `deployment_d1_recovery_point` (
	`artifact_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`transition_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`database_id` text NOT NULL,
	`bookmark` text NOT NULL,
	`envelope_key` text NOT NULL,
	`envelope_sha256` text NOT NULL,
	`captured_at` text NOT NULL,
	PRIMARY KEY(`artifact_id`, `instance_id`, `transition_id`)
);
--> statement-breakpoint
INSERT INTO `d1_application_mutation_fence` (`id`, `state`, `revision`, `updated_at`)
VALUES ('application', 'open', 0, CURRENT_TIMESTAMP)
ON CONFLICT (`id`) DO NOTHING;
--> statement-breakpoint
INSERT INTO `deployment_runtime_control` (
	`id`,
	`retention_administration`,
	`retention_revision`,
	`legacy_r2_writes`,
	`legacy_r2_read_fallback`,
	`legacy_r2_deletion`,
	`tenant_local_contract_admission`,
	`updated_at`
)
VALUES (
	'current',
	'open',
	0,
	'enabled',
	'enabled',
	'forbidden',
	'not-required',
	CURRENT_TIMESTAMP
)
ON CONFLICT (`id`) DO NOTHING;

CREATE TABLE `d1_application_mutation_fence` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "d1_application_mutation_fence_singleton" CHECK("d1_application_mutation_fence"."id" = 'application'),
	CONSTRAINT "d1_application_mutation_fence_revision_nonnegative" CHECK("d1_application_mutation_fence"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `deployment_head` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`state_id` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "deployment_head_singleton" CHECK("deployment_head"."id" = 'current'),
	CONSTRAINT "deployment_head_revision_nonnegative" CHECK("deployment_head"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `deployment_transition_execution` (
	`artifact_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`transition_id` text NOT NULL,
	`from_state_id` text NOT NULL,
	`to_state_id` text NOT NULL,
	`status` text NOT NULL,
	`attempt_id` text,
	`claim_revision` integer DEFAULT 0 NOT NULL,
	`claim_expires_at` text,
	`external_action` text DEFAULT 'not-required' NOT NULL,
	`started_at` text,
	`completed_at` text,
	`last_failure_json` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`artifact_id`, `instance_id`, `transition_id`),
	CONSTRAINT "deployment_transition_claim_revision_nonnegative" CHECK("deployment_transition_execution"."claim_revision" >= 0)
);
--> statement-breakpoint
CREATE INDEX `deployment_transition_status_idx` ON `deployment_transition_execution` (`artifact_id`,`instance_id`,`status`,`transition_id`);--> statement-breakpoint
CREATE TABLE `fresh_installation_bootstrap` (
	`database_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`intended_resources_json` text NOT NULL,
	`observed_resources_json` text NOT NULL,
	`instance_id` text,
	`topology_digest` text,
	`phase` text NOT NULL,
	`claim_id` text NOT NULL,
	`claim_revision` integer NOT NULL,
	`claim_owner` text NOT NULL,
	`claim_expires_at` text NOT NULL,
	`onboarding_challenge_hash` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "fresh_installation_claim_revision_nonnegative" CHECK("fresh_installation_bootstrap"."claim_revision" >= 0),
	CONSTRAINT "fresh_installation_topology_shape" CHECK(("fresh_installation_bootstrap"."phase" IN ('claimed', 'resources-created') AND "fresh_installation_bootstrap"."instance_id" IS NULL AND "fresh_installation_bootstrap"."topology_digest" IS NULL) OR ("fresh_installation_bootstrap"."phase" NOT IN ('claimed', 'resources-created') AND "fresh_installation_bootstrap"."instance_id" IS NOT NULL AND "fresh_installation_bootstrap"."topology_digest" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `global_data_migration` (
	`artifact_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`migration_id` text NOT NULL,
	`status` text NOT NULL,
	`cohort_created_at` text NOT NULL,
	`cohort_high_water` integer NOT NULL,
	`scan_high_water_json` text,
	`claim_id` text,
	`claim_revision` integer DEFAULT 0 NOT NULL,
	`claim_expires_at` text,
	`fleet_completion_revision` integer,
	`completed_at` text,
	`last_failure_json` text,
	PRIMARY KEY(`artifact_id`, `instance_id`, `migration_id`),
	CONSTRAINT "global_data_migration_cohort_high_water_nonnegative" CHECK("global_data_migration"."cohort_high_water" >= 0),
	CONSTRAINT "global_data_migration_claim_revision_nonnegative" CHECK("global_data_migration"."claim_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `local_contract_migration` (
	`artifact_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`tenant` text NOT NULL,
	`phase` text NOT NULL,
	`admission` text NOT NULL,
	`admission_revision` integer DEFAULT 0 NOT NULL,
	`pre_contract_bookmark` text,
	`restore_undo_bookmark` text,
	`claim_id` text,
	`claim_revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	`last_failure_json` text,
	PRIMARY KEY(`artifact_id`, `instance_id`, `tenant`),
	CONSTRAINT "local_contract_admission_revision_nonnegative" CHECK("local_contract_migration"."admission_revision" >= 0),
	CONSTRAINT "local_contract_claim_revision_nonnegative" CHECK("local_contract_migration"."claim_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `structural_migration_checksum` (
	`kind` text NOT NULL,
	`migration_id` text NOT NULL,
	`sha256` text NOT NULL,
	`applied_at` text NOT NULL,
	PRIMARY KEY(`kind`, `migration_id`),
	CONSTRAINT "structural_migration_checksum_sha256" CHECK(length("structural_migration_checksum"."sha256") = 64 AND "structural_migration_checksum"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `successor_deployment_preparation` (
	`predecessor_artifact_id` text NOT NULL,
	`predecessor_instance_id` text NOT NULL,
	`successor_artifact_id` text NOT NULL,
	`successor_instance_id` text NOT NULL,
	`predecessor_state_id` text NOT NULL,
	`predecessor_revision` integer NOT NULL,
	`transition_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`execution_snapshot_json` text NOT NULL,
	`status` text NOT NULL,
	`claim_expires_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`predecessor_artifact_id`, `predecessor_instance_id`, `successor_artifact_id`, `successor_instance_id`),
	CONSTRAINT "successor_preparation_revision_nonnegative" CHECK("successor_deployment_preparation"."predecessor_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `tenant_data_migration` (
	`artifact_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`migration_id` text NOT NULL,
	`implementation_revision` text NOT NULL,
	`tenant` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claim_id` text,
	`claim_revision` integer DEFAULT 0 NOT NULL,
	`claim_expires_at` text,
	`next_attempt_at` text,
	`started_at` text,
	`completed_at` text,
	`last_failure_json` text,
	PRIMARY KEY(`artifact_id`, `instance_id`, `migration_id`, `tenant`),
	CONSTRAINT "tenant_data_migration_attempts_nonnegative" CHECK("tenant_data_migration"."attempts" >= 0),
	CONSTRAINT "tenant_data_migration_claim_revision_nonnegative" CHECK("tenant_data_migration"."claim_revision" >= 0)
);
--> statement-breakpoint
CREATE INDEX `tenant_data_migration_work_idx` ON `tenant_data_migration` (`artifact_id`,`instance_id`,`migration_id`,`status`,`next_attempt_at`,`tenant`);

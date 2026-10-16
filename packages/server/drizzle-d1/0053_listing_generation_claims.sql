CREATE TABLE `listing_generation` (
	`nar_hash` text NOT NULL,
	`generator_revision` text NOT NULL,
	`source_incarnation` integer NOT NULL,
	`generation` integer NOT NULL,
	`tenant` text,
	`owner` text,
	`lease_expires_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`nar_hash`, `generator_revision`),
	CONSTRAINT "listing_generation_version_check" CHECK("listing_generation"."source_incarnation" >= 1 AND "listing_generation"."generation" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "listing_generation_ownership_check" CHECK(("listing_generation"."tenant" IS NULL AND "listing_generation"."owner" IS NULL AND "listing_generation"."lease_expires_at" IS NULL) OR ("listing_generation"."tenant" IS NOT NULL AND "listing_generation"."owner" IS NOT NULL AND "listing_generation"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `listing_generation_tenant_idx` ON `listing_generation` (`tenant`,`nar_hash`,`generator_revision`);

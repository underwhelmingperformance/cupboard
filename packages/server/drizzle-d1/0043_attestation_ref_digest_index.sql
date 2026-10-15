CREATE INDEX `attestation_ref_digest_tenant_idx` ON `attestation_ref_storage` (`digest`,`tenant`);--> statement-breakpoint
DROP INDEX `attestation_ref_digest_idx`;

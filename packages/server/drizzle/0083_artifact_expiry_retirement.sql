CREATE INDEX `artifact_active_expiry_idx` ON `artifact` (`expires_at`,`id`) WHERE "artifact"."state" != 'retired' AND "artifact"."expires_at" IS NOT NULL;

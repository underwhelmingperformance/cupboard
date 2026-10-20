DROP INDEX `publication_operation_deadline_idx`;--> statement-breakpoint
CREATE INDEX `publication_operation_deadline_idx` ON `publication_operation` (`state`,`recovery_deadline`,`id`);

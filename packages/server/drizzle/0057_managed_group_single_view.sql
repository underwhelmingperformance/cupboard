DROP INDEX `reuse_view_selector_managed_group_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `reuse_view_selector_managed_group_idx` ON `reuse_view_selector_native` (`managed_group_id`) WHERE "reuse_view_selector_native"."kind" = 'managed-group';

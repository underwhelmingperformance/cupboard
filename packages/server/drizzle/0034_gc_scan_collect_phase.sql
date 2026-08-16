ALTER TABLE `garbage_collection_scan` RENAME COLUMN "allow_empty_sweep" TO "allow_empty_collection";--> statement-breakpoint
UPDATE `garbage_collection_scan` SET `phase` = 'collect' WHERE `phase` = 'sweep';

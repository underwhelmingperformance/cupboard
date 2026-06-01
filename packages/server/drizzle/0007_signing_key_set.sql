ALTER TABLE `narinfo` ADD `sigs_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `narinfo` SET `sigs_json` = json_array(`sig`) WHERE `sig` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `narinfo` DROP COLUMN `sig`;--> statement-breakpoint
ALTER TABLE `signing_key` ADD `signing` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `signing_key` ADD `published` integer DEFAULT true NOT NULL;
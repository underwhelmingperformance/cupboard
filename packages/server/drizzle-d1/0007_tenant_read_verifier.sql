ALTER TABLE `tenant` ADD `read_user` text;--> statement-breakpoint
ALTER TABLE `tenant` ADD `read_password_hash` text;--> statement-breakpoint
ALTER TABLE `tenant` ADD `read_password_salt` text;

UPDATE `tenant` SET `read_user` = NULL, `read_password_hash` = NULL, `read_password_salt` = NULL WHERE `read_user` IS NOT NULL OR `read_password_hash` IS NOT NULL OR `read_password_salt` IS NOT NULL;
--> statement-breakpoint
DELETE FROM `tenant_cache_read_credential`;

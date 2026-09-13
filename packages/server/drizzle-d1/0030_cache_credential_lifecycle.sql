-- A credential set before registration must remain available to that cache.
-- For a live cache whose name was reused, stored state cannot distinguish its
-- current credential from an older one. Deleting it could enable the tenant
-- credential, so those rows require operator review. See "Cache read credentials"
-- in docs/deploying.md.
DELETE FROM `tenant_cache_read_credential`
WHERE EXISTS (
	SELECT 1
	FROM `cache_lifecycle`
	WHERE `cache_lifecycle`.`tenant` = `tenant_cache_read_credential`.`tenant`
		AND `cache_lifecycle`.`cache_kind` = `tenant_cache_read_credential`.`cache_kind`
		AND `cache_lifecycle`.`cache_name` IS `tenant_cache_read_credential`.`cache_name`
		AND `cache_lifecycle`.`deleted_at` IS NOT NULL
);

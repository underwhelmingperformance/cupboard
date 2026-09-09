-- Custom SQL migration file, put your code below! --
-- Deleting a cache used to leave the cache's read credential in place, so the
-- credential could open the next cache registered under the same name. The
-- deletion now removes the credential. This migration removes the credentials
-- that earlier deletions left: every row whose cache has a lifecycle row with a
-- deletion timestamp.
--
-- Two kinds of row stay. A credential whose cache has no lifecycle row belongs
-- to a cache the tenant Durable Object has not registered, for example because
-- the operator set the credential before the cache was created; it applies to
-- that cache once the object registers it. A credential whose cache was deleted
-- and then registered again under the same name has no deletion timestamp to
-- match, because registration clears it, and no column records whether the
-- operator set the credential for the earlier cache or for the current one.
-- Removing such a row could drop the current cache's own verifier and let the
-- tenant credential open the cache, so an operator checks those rows by hand.
-- "Read credentials to check by hand" in docs/deploying.md describes how.
DELETE FROM `tenant_cache_read_credential`
WHERE EXISTS (
	SELECT 1
	FROM `cache_lifecycle`
	WHERE `cache_lifecycle`.`tenant` = `tenant_cache_read_credential`.`tenant`
		AND `cache_lifecycle`.`cache_kind` = `tenant_cache_read_credential`.`cache_kind`
		AND `cache_lifecycle`.`cache_name` IS `tenant_cache_read_credential`.`cache_name`
		AND `cache_lifecycle`.`deleted_at` IS NOT NULL
);

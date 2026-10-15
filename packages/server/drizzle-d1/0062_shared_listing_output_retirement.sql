DROP TRIGGER shared_listing_output_parent_retired;
--> statement-breakpoint
CREATE TRIGGER shared_listing_output_parent_retired AFTER DELETE ON blob_ref_storage
WHEN NOT EXISTS (SELECT 1 FROM blob_ref_storage WHERE nar_hash = OLD.nar_hash)
AND EXISTS (SELECT 1 FROM shared_listing_output_ref WHERE nar_hash = OLD.nar_hash)
BEGIN
 INSERT INTO shared_listing_output_cleanup (nar_hash, next_attempt_at)
 VALUES (OLD.nar_hash, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 ON CONFLICT(nar_hash) DO UPDATE SET epoch = lower(hex(randomblob(16))), cursor = NULL, owner = NULL,
 lease_expires_at = NULL, next_attempt_at = excluded.next_attempt_at;
END;

CREATE TRIGGER `nar_capture_reference_insert` AFTER INSERT ON `blob_ref_storage`
WHEN (SELECT is_ready FROM nar_capture_state WHERE id = 1) = 1 AND (SELECT count(*) FROM (SELECT 1 FROM blob_ref_storage WHERE nar_hash = NEW.nar_hash LIMIT 2)) = 1
BEGIN
 INSERT INTO nar_capture_event (nar_hash, source_incarnation) SELECT b.nar_hash, b.incarnation FROM blob_state AS b WHERE b.nar_hash = NEW.nar_hash AND EXISTS (SELECT 1 FROM object_incarnation AS o WHERE o.kind = 'nar' AND o.object_id = b.nar_hash AND o.incarnation = b.incarnation AND o.state = 'live');
END;
--> statement-breakpoint
CREATE TRIGGER `nar_capture_reference_update` AFTER UPDATE OF nar_hash ON `blob_ref_storage`
WHEN (SELECT is_ready FROM nar_capture_state WHERE id = 1) = 1 AND NEW.nar_hash <> OLD.nar_hash AND (SELECT count(*) FROM (SELECT 1 FROM blob_ref_storage WHERE nar_hash = NEW.nar_hash LIMIT 2)) = 1
BEGIN
 INSERT INTO nar_capture_event (nar_hash, source_incarnation) SELECT b.nar_hash, b.incarnation FROM blob_state AS b WHERE b.nar_hash = NEW.nar_hash AND EXISTS (SELECT 1 FROM object_incarnation AS o WHERE o.kind = 'nar' AND o.object_id = b.nar_hash AND o.incarnation = b.incarnation AND o.state = 'live');
END;
--> statement-breakpoint
CREATE TRIGGER `nar_capture_state_insert` AFTER INSERT ON `blob_state`
WHEN (SELECT is_ready FROM nar_capture_state WHERE id = 1) = 1 AND EXISTS (SELECT 1 FROM blob_ref_storage WHERE nar_hash = NEW.nar_hash) AND EXISTS (SELECT 1 FROM object_incarnation WHERE kind = 'nar' AND object_id = NEW.nar_hash AND incarnation = NEW.incarnation AND state = 'live')
BEGIN
 INSERT INTO nar_capture_event (nar_hash, source_incarnation) SELECT NEW.nar_hash, NEW.incarnation;
END;
--> statement-breakpoint
CREATE TRIGGER `nar_capture_state_update` AFTER UPDATE OF incarnation ON `blob_state`
WHEN (SELECT is_ready FROM nar_capture_state WHERE id = 1) = 1 AND NEW.incarnation <> OLD.incarnation AND EXISTS (SELECT 1 FROM blob_ref_storage WHERE nar_hash = NEW.nar_hash) AND EXISTS (SELECT 1 FROM object_incarnation WHERE kind = 'nar' AND object_id = NEW.nar_hash AND incarnation = NEW.incarnation AND state = 'live')
BEGIN
 INSERT INTO nar_capture_event (nar_hash, source_incarnation) SELECT NEW.nar_hash, NEW.incarnation;
END;
--> statement-breakpoint
CREATE TRIGGER `nar_capture_registration_insert` AFTER INSERT ON `object_incarnation`
WHEN (SELECT is_ready FROM nar_capture_state WHERE id = 1) = 1 AND NEW.kind = 'nar' AND NEW.state = 'live'
BEGIN
 INSERT INTO nar_capture_event (nar_hash, source_incarnation) SELECT b.nar_hash, b.incarnation FROM blob_state AS b WHERE b.nar_hash = NEW.object_id AND b.incarnation = NEW.incarnation AND EXISTS (SELECT 1 FROM blob_ref_storage AS r WHERE r.nar_hash = b.nar_hash);
END;
--> statement-breakpoint
CREATE TRIGGER `nar_capture_registration_update` AFTER UPDATE OF state, incarnation ON `object_incarnation`
WHEN (SELECT is_ready FROM nar_capture_state WHERE id = 1) = 1 AND NEW.kind = 'nar' AND NEW.state = 'live' AND (NEW.state <> OLD.state OR NEW.incarnation <> OLD.incarnation)
BEGIN
 INSERT INTO nar_capture_event (nar_hash, source_incarnation) SELECT b.nar_hash, b.incarnation FROM blob_state AS b WHERE b.nar_hash = NEW.object_id AND b.incarnation = NEW.incarnation AND EXISTS (SELECT 1 FROM blob_ref_storage AS r WHERE r.nar_hash = b.nar_hash);
END;
--> statement-breakpoint
CREATE TRIGGER `nar_capture_advance_clock` AFTER INSERT ON `nar_capture_event`
BEGIN
 UPDATE nar_capture_state SET latest = max(latest, NEW.id) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `shared_listing_job_capture_insert` BEFORE INSERT ON `shared_listing_job`
WHEN typeof(NEW.event_cursor) <> 'integer' OR NEW.event_cursor < 0 OR NEW.event_cursor > 9007199254740991
BEGIN
 SELECT RAISE(ABORT, 'shared listing job capture cursor is outside the safe integer domain');
END;
--> statement-breakpoint
CREATE TRIGGER `shared_listing_job_capture_update` BEFORE UPDATE OF event_cursor ON `shared_listing_job`
WHEN typeof(NEW.event_cursor) <> 'integer' OR NEW.event_cursor < 0 OR NEW.event_cursor > 9007199254740991
BEGIN
 SELECT RAISE(ABORT, 'shared listing job capture cursor is outside the safe integer domain');
END;
--> statement-breakpoint
UPDATE `nar_capture_state` SET `is_ready` = 1 WHERE `id` = 1;

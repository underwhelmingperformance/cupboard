ALTER TABLE `shared_listing_job` ADD `event_through` integer;
--> statement-breakpoint
CREATE TRIGGER `shared_listing_job_window_insert` BEFORE INSERT ON `shared_listing_job`
WHEN NEW.event_through IS NOT NULL AND (typeof(NEW.event_through) <> 'integer' OR NEW.event_through < NEW.event_cursor OR NEW.event_through > 9007199254740991)
BEGIN
 SELECT RAISE(ABORT, 'shared listing job capture window is outside the safe sequence domain');
END;
--> statement-breakpoint
CREATE TRIGGER `shared_listing_job_window_update` BEFORE UPDATE OF event_through, event_cursor ON `shared_listing_job`
WHEN NEW.event_through IS NOT NULL AND (typeof(NEW.event_through) <> 'integer' OR NEW.event_through < NEW.event_cursor OR NEW.event_through > 9007199254740991)
BEGIN
 SELECT RAISE(ABORT, 'shared listing job capture window is outside the safe sequence domain');
END;

CREATE TRIGGER `listing_adoption_capture_clock` AFTER INSERT ON `listing_adoption_capture_event`
BEGIN
 UPDATE listing_adoption_capture_state SET latest = max(latest, NEW.id) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_parent_insert` AFTER INSERT ON `blob_ref_storage`
WHEN NEW.readable = 1
BEGIN
 INSERT INTO listing_adoption_capture_event (source) VALUES (json_object('kind','parent','narHash',NEW.nar_hash,'tenant',NEW.tenant,'cache',json(CASE WHEN NEW.cache_kind = 'default' THEN json_object('kind','default') ELSE json_object('kind','named','name',NEW.cache_name) END),'cacheGeneration',NEW.cache_generation,'storePathHash',NEW.store_path_hash,'generation',NEW.generation));
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_parent_update` AFTER UPDATE OF tenant, cache_kind, cache_name, cache_generation, store_path_hash, generation, nar_hash, readable ON `blob_ref_storage`
WHEN NEW.readable = 1 AND (NEW.tenant IS NOT OLD.tenant OR NEW.cache_kind IS NOT OLD.cache_kind OR NEW.cache_name IS NOT OLD.cache_name OR NEW.cache_generation IS NOT OLD.cache_generation OR NEW.store_path_hash IS NOT OLD.store_path_hash OR NEW.generation IS NOT OLD.generation OR NEW.nar_hash IS NOT OLD.nar_hash OR NEW.readable IS NOT OLD.readable)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) VALUES (json_object('kind','parent','narHash',NEW.nar_hash,'tenant',NEW.tenant,'cache',json(CASE WHEN NEW.cache_kind = 'default' THEN json_object('kind','default') ELSE json_object('kind','named','name',NEW.cache_name) END),'cacheGeneration',NEW.cache_generation,'storePathHash',NEW.store_path_hash,'generation',NEW.generation));
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_fact_insert` AFTER INSERT ON `listing_fact`
BEGIN
 INSERT INTO listing_adoption_fact (nar_hash,generator_revision,digest) VALUES (NEW.nar_hash,NEW.generator_revision,NEW.digest) ON CONFLICT (nar_hash,generator_revision) DO NOTHING;
 INSERT INTO listing_adoption_capture_event (source) VALUES (json_object('kind','listing','identity',json_object('narHash',NEW.nar_hash,'generatorRevision',NEW.generator_revision)));
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_fact_delete` AFTER DELETE ON `listing_fact`
BEGIN
 DELETE FROM listing_adoption_fact WHERE nar_hash = OLD.nar_hash AND generator_revision = OLD.generator_revision AND digest = OLD.digest;
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_cas_registration_insert` AFTER INSERT ON `object_incarnation`
WHEN NEW.kind = 'cas' AND NEW.state = 'live' AND EXISTS (SELECT 1 FROM listing_adoption_fact WHERE digest = NEW.object_id) AND EXISTS (SELECT 1 FROM cas_object_storage WHERE digest = NEW.object_id AND incarnation = NEW.incarnation)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) VALUES (json_object('kind','cas','digest',NEW.object_id,'incarnation',NEW.incarnation));
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_cas_registration_update` AFTER UPDATE OF state, incarnation, kind, object_id ON `object_incarnation`
WHEN NEW.kind = 'cas' AND NEW.state = 'live' AND (NEW.state IS NOT OLD.state OR NEW.incarnation IS NOT OLD.incarnation OR NEW.kind IS NOT OLD.kind OR NEW.object_id IS NOT OLD.object_id) AND EXISTS (SELECT 1 FROM listing_adoption_fact WHERE digest = NEW.object_id) AND EXISTS (SELECT 1 FROM cas_object_storage WHERE digest = NEW.object_id AND incarnation = NEW.incarnation)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) VALUES (json_object('kind','cas','digest',NEW.object_id,'incarnation',NEW.incarnation));
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_cas_metadata_insert` AFTER INSERT ON `cas_object_storage`
WHEN EXISTS (SELECT 1 FROM listing_adoption_fact WHERE digest = NEW.digest) AND EXISTS (SELECT 1 FROM object_incarnation WHERE kind = 'cas' AND object_id = NEW.digest AND incarnation = NEW.incarnation AND state = 'live')
BEGIN
 INSERT INTO listing_adoption_capture_event (source) VALUES (json_object('kind','cas','digest',NEW.digest,'incarnation',NEW.incarnation));
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_cas_metadata_update` AFTER UPDATE OF digest, incarnation, size ON `cas_object_storage`
WHEN (NEW.digest IS NOT OLD.digest OR NEW.incarnation IS NOT OLD.incarnation OR NEW.size IS NOT OLD.size) AND EXISTS (SELECT 1 FROM listing_adoption_fact WHERE digest = NEW.digest) AND EXISTS (SELECT 1 FROM object_incarnation WHERE kind = 'cas' AND object_id = NEW.digest AND incarnation = NEW.incarnation AND state = 'live')
BEGIN
 INSERT INTO listing_adoption_capture_event (source) VALUES (json_object('kind','cas','digest',NEW.digest,'incarnation',NEW.incarnation));
END;
--> statement-breakpoint
UPDATE listing_adoption_capture_state SET is_ready = 1 WHERE id = 1;

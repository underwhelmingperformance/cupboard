CREATE TRIGGER `listing_adoption_parent_tenant_finalise_guard`
BEFORE UPDATE OF status ON tenant
WHEN NEW.status = 'offboarded' AND OLD.status <> 'offboarded'
 AND EXISTS (SELECT 1 FROM listing_adoption_parent WHERE tenant = NEW.id)
BEGIN
 SELECT RAISE(ABORT, 'Tenant listing adoption cleanup is still pending');
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_parent_delete_default` AFTER DELETE ON `blob_ref_storage`
WHEN OLD.cache_kind = 'default' AND EXISTS (SELECT 1 FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'default' AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) SELECT json_object('kind','parent','narHash',nar_hash,'tenant',tenant,'cache',json(CASE WHEN cache_kind = 'default' THEN json_object('kind','default') ELSE json_object('kind','named','name',cache_name) END),'cacheGeneration',cache_generation,'storePathHash',store_path_hash,'generation',generation) FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'default' AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash;
 DELETE FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'default' AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash;
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_parent_retire_default` AFTER UPDATE OF tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation,nar_hash,readable ON `blob_ref_storage`
WHEN OLD.cache_kind = 'default' AND (NEW.tenant IS NOT OLD.tenant OR NEW.cache_kind IS NOT OLD.cache_kind OR NEW.cache_name IS NOT OLD.cache_name OR NEW.cache_generation IS NOT OLD.cache_generation OR NEW.store_path_hash IS NOT OLD.store_path_hash OR NEW.generation IS NOT OLD.generation OR NEW.nar_hash IS NOT OLD.nar_hash OR NEW.readable <> 1) AND EXISTS (SELECT 1 FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'default' AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) SELECT json_object('kind','parent','narHash',nar_hash,'tenant',tenant,'cache',json(CASE WHEN cache_kind = 'default' THEN json_object('kind','default') ELSE json_object('kind','named','name',cache_name) END),'cacheGeneration',cache_generation,'storePathHash',store_path_hash,'generation',generation) FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'default' AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash;
 DELETE FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'default' AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash;
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_parent_revoke_default_insert` AFTER INSERT ON `path_read_revocation`
WHEN NEW.cache_kind = 'default' AND EXISTS (SELECT 1 FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'default' AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) SELECT json_object('kind','parent','narHash',nar_hash,'tenant',tenant,'cache',json(CASE WHEN cache_kind = 'default' THEN json_object('kind','default') ELSE json_object('kind','named','name',cache_name) END),'cacheGeneration',cache_generation,'storePathHash',store_path_hash,'generation',generation) FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'default' AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation;
 DELETE FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'default' AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation;
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_parent_revoke_default_update` AFTER UPDATE OF tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation ON `path_read_revocation`
WHEN NEW.cache_kind = 'default' AND EXISTS (SELECT 1 FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'default' AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) SELECT json_object('kind','parent','narHash',nar_hash,'tenant',tenant,'cache',json(CASE WHEN cache_kind = 'default' THEN json_object('kind','default') ELSE json_object('kind','named','name',cache_name) END),'cacheGeneration',cache_generation,'storePathHash',store_path_hash,'generation',generation) FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'default' AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation;
 DELETE FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'default' AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation;
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_parent_delete_named` AFTER DELETE ON `blob_ref_storage`
WHEN OLD.cache_kind = 'named' AND EXISTS (SELECT 1 FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'named' AND cache_name = OLD.cache_name AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) SELECT json_object('kind','parent','narHash',nar_hash,'tenant',tenant,'cache',json(CASE WHEN cache_kind = 'default' THEN json_object('kind','default') ELSE json_object('kind','named','name',cache_name) END),'cacheGeneration',cache_generation,'storePathHash',store_path_hash,'generation',generation) FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'named' AND cache_name = OLD.cache_name AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash;
 DELETE FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'named' AND cache_name = OLD.cache_name AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash;
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_parent_retire_named` AFTER UPDATE OF tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation,nar_hash,readable ON `blob_ref_storage`
WHEN OLD.cache_kind = 'named' AND (NEW.tenant IS NOT OLD.tenant OR NEW.cache_kind IS NOT OLD.cache_kind OR NEW.cache_name IS NOT OLD.cache_name OR NEW.cache_generation IS NOT OLD.cache_generation OR NEW.store_path_hash IS NOT OLD.store_path_hash OR NEW.generation IS NOT OLD.generation OR NEW.nar_hash IS NOT OLD.nar_hash OR NEW.readable <> 1) AND EXISTS (SELECT 1 FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'named' AND cache_name = OLD.cache_name AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) SELECT json_object('kind','parent','narHash',nar_hash,'tenant',tenant,'cache',json(CASE WHEN cache_kind = 'default' THEN json_object('kind','default') ELSE json_object('kind','named','name',cache_name) END),'cacheGeneration',cache_generation,'storePathHash',store_path_hash,'generation',generation) FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'named' AND cache_name = OLD.cache_name AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash;
 DELETE FROM listing_adoption_parent WHERE tenant = OLD.tenant AND cache_kind = 'named' AND cache_name = OLD.cache_name AND store_path_hash = OLD.store_path_hash AND cache_generation = OLD.cache_generation AND generation = OLD.generation AND nar_hash = OLD.nar_hash;
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_parent_revoke_named_insert` AFTER INSERT ON `path_read_revocation`
WHEN NEW.cache_kind = 'named' AND EXISTS (SELECT 1 FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'named' AND cache_name = NEW.cache_name AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) SELECT json_object('kind','parent','narHash',nar_hash,'tenant',tenant,'cache',json(CASE WHEN cache_kind = 'default' THEN json_object('kind','default') ELSE json_object('kind','named','name',cache_name) END),'cacheGeneration',cache_generation,'storePathHash',store_path_hash,'generation',generation) FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'named' AND cache_name = NEW.cache_name AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation;
 DELETE FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'named' AND cache_name = NEW.cache_name AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation;
END;
--> statement-breakpoint
CREATE TRIGGER `listing_adoption_parent_revoke_named_update` AFTER UPDATE OF tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation ON `path_read_revocation`
WHEN NEW.cache_kind = 'named' AND EXISTS (SELECT 1 FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'named' AND cache_name = NEW.cache_name AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation)
BEGIN
 INSERT INTO listing_adoption_capture_event (source) SELECT json_object('kind','parent','narHash',nar_hash,'tenant',tenant,'cache',json(CASE WHEN cache_kind = 'default' THEN json_object('kind','default') ELSE json_object('kind','named','name',cache_name) END),'cacheGeneration',cache_generation,'storePathHash',store_path_hash,'generation',generation) FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'named' AND cache_name = NEW.cache_name AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation;
 DELETE FROM listing_adoption_parent WHERE tenant = NEW.tenant AND cache_kind = 'named' AND cache_name = NEW.cache_name AND store_path_hash = NEW.store_path_hash AND cache_generation = NEW.cache_generation AND generation <= NEW.generation;
END;

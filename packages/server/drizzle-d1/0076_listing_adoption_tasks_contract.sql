CREATE TRIGGER `listing_adoption_work_enrol` AFTER INSERT ON `listing_adoption_work`
BEGIN
 INSERT INTO listing_adoption_task (kind,work_id,source,created_at)
 VALUES ('expand',NEW.id,json_object('kind','expand','work',json_object('id',NEW.id,'consumerEpoch',NEW.consumer_epoch,'eventId',NEW.event_id,'source',json(NEW.source),'createdAt',NEW.created_at)),NEW.created_at)
 ON CONFLICT (work_id) DO NOTHING;
END;

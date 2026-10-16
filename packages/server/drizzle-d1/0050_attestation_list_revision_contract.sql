CREATE TABLE attestation_list_reader_readiness_guard (
 ready integer NOT NULL CHECK(ready = 1)
);
--> statement-breakpoint
INSERT INTO attestation_list_reader_readiness_guard (ready)
SELECT CASE WHEN EXISTS (
 SELECT 1 FROM tenant
 WHERE status IN ('active', 'suspended') AND coalesce(local_step, -1) < 7
) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE attestation_list_reader_readiness_guard;

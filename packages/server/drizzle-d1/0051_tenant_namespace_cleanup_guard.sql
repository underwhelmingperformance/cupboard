CREATE TABLE `tenant_namespace_cleanup_guard` (
	`tenant` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`not_before` text NOT NULL
);

--> statement-breakpoint
CREATE TRIGGER tenant_namespace_cleanup_guard_begin
AFTER UPDATE OF status ON tenant
WHEN NEW.status = 'offboarding' AND OLD.status IN ('active', 'suspended')
 AND EXISTS (SELECT 1 FROM deployment_transition WHERE id = 'attestation-list-revision' AND state <> 'expanded')
BEGIN
 INSERT INTO tenant_namespace_cleanup_guard (tenant, started_at, not_before)
 VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5160 seconds'))
 ON CONFLICT (tenant) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER tenant_namespace_cleanup_guard_finalise
BEFORE UPDATE OF status ON tenant
WHEN NEW.status = 'offboarded' AND OLD.status <> 'offboarded'
 AND EXISTS (SELECT 1 FROM tenant_namespace_cleanup_guard WHERE tenant = NEW.id AND not_before > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN
 SELECT RAISE(ABORT, 'Tenant namespace cleanup window is still active');
END;

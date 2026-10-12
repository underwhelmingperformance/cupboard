CREATE TRIGGER attestation_list_retired_tenant_insert_guard
BEFORE INSERT ON attestation_list_revision
WHEN EXISTS (SELECT 1 FROM tenant WHERE id = NEW.tenant AND status IN ('offboarding', 'offboarded'))
BEGIN
 SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER attestation_list_retired_tenant_finalise_guard
BEFORE UPDATE OF status ON tenant
WHEN NEW.status = 'offboarded' AND OLD.status <> 'offboarded'
 AND (EXISTS (SELECT 1 FROM attestation_list_revision WHERE tenant = NEW.id AND cache_kind = 'default') OR EXISTS (SELECT 1 FROM attestation_list_revision WHERE tenant = NEW.id AND cache_kind = 'named'))
BEGIN
 SELECT RAISE(ABORT, 'Tenant attestation-list cleanup is still pending');
END;

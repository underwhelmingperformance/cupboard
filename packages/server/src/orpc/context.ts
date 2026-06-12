import type { AccessClaims, AccessScope } from '../auth/auth.ts';
import type { AttestationsService } from '../do/attestations-service.ts';
import type { AuthKeysService } from '../do/auth-keys-service.ts';
import type { CacheAdminService } from '../do/cache-admin-service.ts';
import type { DeletionQueueService } from '../do/deletion-queue-service.ts';
import type { GarbageCollectionService } from '../do/garbage-collection-service.ts';
import type { IntegrityCheckService } from '../do/integrity-check-service.ts';
import type { OidcTrustService } from '../do/oidc-trust-service.ts';
import type { RetentionService } from '../do/retention-service.ts';
import type { RootsService } from '../do/roots-service.ts';
import type { SigningKeysService } from '../do/signing-keys-service.ts';
import type { StatsService } from '../do/stats-service.ts';
import type { UploadsService } from '../do/uploads-service.ts';

/**
 * The capabilities the contract's procedures need from the Durable Object:
 * authentication, the maintenance-eligibility bracket, and the domain
 * services. The object supplies an instance per request through the handler
 * context.
 */
export interface TenantRpcServices {
	requireScope(request: Request, scope: AccessScope): Promise<AccessClaims>;
	withMaintenanceEligibility<T>(body: () => Promise<T>): Promise<T>;
	readonly cacheAdmin: CacheAdminService;
	readonly signingKeys: SigningKeysService;
	readonly authKeys: AuthKeysService;
	readonly retention: RetentionService;
	readonly oidcTrust: OidcTrustService;
	readonly stats: StatsService;
	readonly integrityCheck: IntegrityCheckService;
	readonly roots: RootsService;
	readonly deletionQueue: DeletionQueueService;
	readonly garbageCollection: GarbageCollectionService;
	readonly uploads: UploadsService;
	readonly attestations: AttestationsService;
}

/** The initial oRPC context for every tenant procedure call. */
export interface TenantOrpcContext {
	readonly request: Request;
	readonly services: TenantRpcServices;
}
